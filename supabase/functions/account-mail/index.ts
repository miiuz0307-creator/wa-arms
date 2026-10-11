// account-mail: e-mails sent from the system's own mailbox (set by the owner in the app).
//   reset_request {email}                 → 6-digit code by e-mail (valid 10 min). Same answer for unknown e-mails.
//   reset_confirm {email, code, password} → sets the new password.
//   test {to?}                            → owner only: sends a test e-mail.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import nodemailer from 'npm:nodemailer@6.9.14';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: CORS });
const sha = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const normEmail = (e: unknown) => String(e || '').trim().toLowerCase();

async function settings() {
  const { data } = await db.from('mail_settings').select('*').eq('id', 1).single();
  if (!data?.address || !data?.smtp_pass) throw new Error('מייל המערכת עוד לא הוגדר');
  return data;
}

async function send(to: string, subject: string, text: string, html: string) {
  const s = await settings();
  const t = nodemailer.createTransport({
    host: s.smtp_host,
    port: s.smtp_port,
    secure: s.smtp_port === 465,
    auth: { user: s.smtp_user || s.address, pass: s.smtp_pass },
    connectionTimeout: 15_000,
  });
  await t.sendMail({ from: `"${s.from_name}" <${s.address}>`, to, subject, text, html });
}

const box = (inner: string) =>
  `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;color:#0f172a;max-width:480px">${inner}</div>`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const ip = (req.headers.get('x-forwarded-for') || '?').split(',')[0].trim();

  try {
    if (body.action === 'reset_request') {
      const email = normEmail(body.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'כתובת מייל לא תקינה' });
      const since10 = new Date(Date.now() - 10 * 60_000).toISOString();
      const since60 = new Date(Date.now() - 60 * 60_000).toISOString();
      const [{ count: byMail }, { count: byIp }] = await Promise.all([
        db.from('password_reset_codes').select('id', { count: 'exact', head: true }).eq('email', email).gte('created_at', since10),
        db.from('password_reset_codes').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', since60),
      ]);
      if ((byMail || 0) >= 3 || (byIp || 0) >= 10) return json({ error: 'נשלחו כבר כמה קודים. נסה שוב בעוד כמה דקות.' });
      const { data: uid } = await db.rpc('auth_user_by_email', { p_email: email });
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
      await db.from('password_reset_codes').insert({
        email,
        code_hash: uid ? await sha(`${email}:${code}`) : 'none',
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        ip,
      });
      if (uid) {
        await send(
          email,
          `קוד לאיפוס סיסמה: ${code}`,
          `קוד האיפוס שלך: ${code}\nהקוד תקף ל-10 דקות. אם לא ביקשת, התעלם מהמייל.`,
          box(`<p>קוד האיפוס שלך:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p><p style="color:#64748b">הקוד תקף ל-10 דקות. אם לא ביקשת – התעלם מהמייל.</p>`),
        );
      }
      // same answer whether or not the e-mail is registered
      return json({ ok: true });
    }

    if (body.action === 'reset_confirm') {
      const email = normEmail(body.email);
      const code = String(body.code || '').replace(/\D/g, '');
      const password = String(body.password || '');
      if (password.length < 8) return json({ error: 'הסיסמה חייבת להיות לפחות 8 תווים' });
      const { data: rows } = await db
        .from('password_reset_codes')
        .select('*')
        .eq('email', email)
        .is('used_at', null)
        .neq('code_hash', 'none')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1);
      const r = rows?.[0];
      if (!r) return json({ error: 'הקוד פג תוקף או שלא נשלח. בקש קוד חדש.' });
      if (r.attempts >= 5) return json({ error: 'יותר מדי ניסיונות. בקש קוד חדש.' });
      await db.from('password_reset_codes').update({ attempts: r.attempts + 1 }).eq('id', r.id);
      if (r.code_hash !== (await sha(`${email}:${code}`))) return json({ error: 'קוד שגוי' });
      const { data: uid } = await db.rpc('auth_user_by_email', { p_email: email });
      if (!uid) return json({ error: 'קוד שגוי' });
      const { error } = await db.auth.admin.updateUserById(uid, { password });
      if (error) return json({ error: 'לא הצלחנו לשמור את הסיסמה. נסה שוב.' });
      await db.from('password_reset_codes').update({ used_at: new Date().toISOString() }).eq('id', r.id);
      await db.from('activity_log').insert({ actor_id: uid, action: 'password_reset', entity: 'user', entity_id: uid });
      return json({ ok: true });
    }

    if (body.action === 'test') {
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: u } = await db.auth.getUser(jwt);
      if (!u?.user) return json({ error: 'not allowed' }, 401);
      const { data: p } = await db.from('profiles').select('role,is_active').eq('id', u.user.id).single();
      if (!p || p.role !== 'owner' || !p.is_active) return json({ error: 'not allowed' }, 403);
      const to = normEmail(body.to) || u.user.email!;
      await send(to, 'בדיקת מייל המערכת', 'מייל המערכת מוגדר ועובד.', box('<p>✅ מייל המערכת מוגדר ועובד.</p>'));
      return json({ ok: true, to });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    const msg = (e as Error).message || 'שגיאה';
    console.error(msg);
    if (/Invalid login|Username and Password not accepted|EAUTH|535/i.test(msg))
      return json({ error: 'המייל דחה את הסיסמה. ב-Gmail צריך "סיסמת אפליקציה" (16 תווים), לא הסיסמה הרגילה.' });
    return json({ error: msg.startsWith('מייל המערכת') ? msg : 'שליחת המייל נכשלה: ' + msg.slice(0, 120) });
  }
});
