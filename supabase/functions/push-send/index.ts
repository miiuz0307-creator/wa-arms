// push-send: called by the database (trigger on public.notifications) for every new notification.
// Sends it as a phone notification (web push) to every phone that agreed: the station's phones, and the
// owner's phones when the notification is for the owner. Phones that no longer exist are switched off.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
// the push keys live in the database (ops.push_keys, readable only by this function's service role)
let keysReady = false;
async function keys() {
  if (keysReady) return;
  const { data, error } = await db.rpc('push_keys_get');
  if (error || !data?.public_key) throw new Error(`push keys: ${error?.message || 'missing'}`);
  webpush.setVapidDetails(data.subject || 'mailto:admin@botix.app', data.public_key, data.private_key);
  keysReady = true;
}

Deno.serve(async (req) => {
  // same internal key as the release runner: only the database calls this
  const { data: ok } = await db.rpc('runner_key_ok', { p_key: req.headers.get('x-runner-key') || '' });
  if (ok !== true) return new Response('no', { status: 401 });
  await keys();
  const { id } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ ok: false, error: 'no id' }, { status: 400 });

  const { data: n } = await db.from('notifications').select('*').eq('id', id).maybeSingle();
  if (!n) return Response.json({ ok: false, error: 'not found' }, { status: 404 });

  let q = db.from('push_subscriptions').select('id,endpoint,p256dh,auth,failures').lt('failures', 5);
  const ors: string[] = [];
  if (n.station_id) ors.push(`station_id.eq.${n.station_id}`);
  if (n.for_owner) ors.push('is_owner.eq.true');
  if (!ors.length) return Response.json({ ok: true, sent: 0 });
  q = q.or(ors.join(','));
  const { data: subs } = await q.limit(500);

  const payload = JSON.stringify({
    title: n.title,
    body: n.body || '',
    url: n.url || '/notifications',
    tag: n.arm_id ? `arm-${n.arm_id}` : `n-${n.id}`,
    urgent: n.level === 'urgent',
  });
  let sent = 0;
  await Promise.all(
    (subs || []).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: 6 * 3600,
          urgency: n.level === 'urgent' ? 'high' : 'normal',
        });
        sent++;
        await db.from('push_subscriptions').update({ last_ok_at: new Date().toISOString(), failures: 0 }).eq('id', s.id);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // 404/410: the phone removed the permission or the app – stop sending to it
        await db.from('push_subscriptions').update({ failures: code === 404 || code === 410 ? 99 : (s.failures || 0) + 1 }).eq('id', s.id);
      }
    }),
  );
  await db.from('notifications').update({ pushed_at: new Date().toISOString() }).eq('id', n.id);
  return Response.json({ ok: true, sent, of: (subs || []).length });
});
