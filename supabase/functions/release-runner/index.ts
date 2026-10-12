// release-runner: called every minute by pg_cron. Moves approved releases to production one step at a time:
//   approved → (snapshot, DB change, deploy exact commit via Railway) → deploying → verifying → live
//   and on bad health → previous commit redeployed (+ DB undo script) → rolled_back.
// Nothing here runs unless the owner approved the release in the app.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const RAILWAY = 'https://backboard.railway.com/graphql/v2';
const ENV_ID = 'b8a4493e-241e-443a-96c4-9ce5afea5729';
const SERVICES: Record<string, string> = {
  web: '00319a87-212b-4691-9f3f-7e0f117948ac',
  engine: 'babbcc28-cc69-418b-856e-c82124d11984',
};
const WEB_URL = 'https://web-production-e5de3.up.railway.app';
const GRACE_MS = 2 * 60_000; // after the new engine starts, give the arms 2 minutes to reconnect
const WATCH_MS: Record<string, number> = { engine: 10 * 60_000, web: 3 * 60_000, db: 5 * 60_000 };
const BAD_LIMIT = 3; // bad health samples (one per minute) before rolling back

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

let authMode: 'bearer' | 'project' | null = null;
async function railway(query: string, variables: Record<string, unknown> = {}) {
  const token = Deno.env.get('RAILWAY_TOKEN');
  if (!token) throw new Error('חסר RAILWAY_TOKEN');
  const modes: ('bearer' | 'project')[] = authMode ? [authMode] : ['bearer', 'project'];
  let last = '';
  for (const m of modes) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (m === 'bearer') headers.authorization = `Bearer ${token}`;
    else headers['project-access-token'] = token;
    const res = await fetch(RAILWAY, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => ({}));
    if (res.ok && !body.errors) {
      authMode = m;
      return body.data;
    }
    last = JSON.stringify(body.errors || body).slice(0, 300);
  }
  throw new Error(`Railway: ${last}`);
}

const deploy = async (component: string, sha: string) =>
  (await railway(`mutation($s:String!,$e:String!,$c:String){serviceInstanceDeployV2(serviceId:$s,environmentId:$e,commitSha:$c)}`, {
    s: SERVICES[component], e: ENV_ID, c: sha,
  })).serviceInstanceDeployV2 as string;

const deploymentStatus = async (id: string) => (await railway(`query($id:String!){deployment(id:$id){status}}`, { id })).deployment?.status as string;

async function liveCommit(component: string): Promise<string | null> {
  const d = await railway(
    `query($s:String!,$e:String!){deployments(first:10,input:{serviceId:$s,environmentId:$e}){edges{node{status meta}}}}`,
    { s: SERVICES[component], e: ENV_ID },
  );
  const node = d.deployments.edges.map((e: any) => e.node).find((n: any) => n.status === 'SUCCESS');
  return node?.meta?.commitHash || null;
}

async function health() {
  const { data: arms } = await db.from('arms').select('status,last_seen_at').eq('is_active', true);
  const online = (arms || []).filter((a: any) => a.status === 'online');
  const seen = online.reduce((m: number, a: any) => Math.max(m, a.last_seen_at ? Date.parse(a.last_seen_at) : 0), 0);
  let web: string | null = null;
  try {
    const r = await fetch(`${WEB_URL}/api/version`, { signal: AbortSignal.timeout(10_000) });
    web = r.ok ? (await r.json()).sha || 'ok' : `http ${r.status}`;
  } catch (e) {
    web = `error ${(e as Error).message}`.slice(0, 80);
  }
  const { data: es } = await db.from('engine_status').select('sync_ok_at').eq('id', 1).maybeSingle();
  const sync_age_s = es?.sync_ok_at ? Math.round((Date.now() - Date.parse(es.sync_ok_at)) / 1000) : null;
  return { at: new Date().toISOString(), arms_online: online.length, arms_active: (arms || []).length, engine_age_s: seen ? Math.round((Date.now() - seen) / 1000) : null, sync_age_s, web };
}

async function note(r: any, msg: string, patch: Record<string, unknown> = {}) {
  const log = [...(r.log || []), { at: new Date().toISOString(), msg }];
  await db.from('releases').update({ ...patch, log }).eq('id', r.id);
  r.log = log;
}

async function rollback(r: any, why: string) {
  const deps = r.deployments || {};
  const prev = r.prev || {};
  const done: string[] = [];
  for (const c of ['engine', 'web']) {
    if (!deps[c] || !prev[c]) continue;
    // only redeploy what actually went live (a failed build never replaced the running version)
    const st = await deploymentStatus(deps[c]).catch(() => 'UNKNOWN');
    if (st === 'FAILED' || st === 'SKIPPED') continue;
    await deploy(c, prev[c]);
    done.push(c);
  }
  if (r.components?.includes('db') && r.rollback_sql) {
    const { error } = await db.rpc('runner_exec', { p_release: r.id, p_undo: true });
    done.push(error ? `db (undo failed: ${error.message})` : 'db');
  }
  await note(r, `חזרה לגרסה הקודמת: ${why}${done.length ? ` (${done.join(', ')})` : ''}`, { status: 'rolled_back' });
}

async function step() {
  // 1) a release in flight
  const { data: active } = await db.from('releases').select('*').in('status', ['deploying', 'verifying', 'rollback_requested']).order('id').limit(1);
  const r = active?.[0];
  if (r) {
    if (r.status === 'rollback_requested') return rollback(r, 'לבקשת המנהל');
    if (r.status === 'deploying') {
      const deps = r.deployments || {};
      const states: Record<string, string> = {};
      for (const [c, id] of Object.entries(deps)) states[c] = await deploymentStatus(id as string);
      const bad = Object.entries(states).find(([, s]) => ['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED'].includes(s));
      if (bad) return rollback(r, `הפריסה של ${bad[0]} נכשלה (${bad[1]})`);
      if (Object.values(states).every((s) => s === 'SUCCESS')) {
        const watch = Math.max(...(r.components as string[]).map((c) => WATCH_MS[c] || 0)) + (deps.engine ? GRACE_MS : 0);
        return note(r, 'הגרסה עלתה, בודק תקינות', { status: 'verifying', deployed_at: new Date().toISOString(), verify_until: new Date(Date.now() + watch).toISOString() });
      }
      if (Date.now() - Date.parse(r.started_at) > 20 * 60_000) return rollback(r, 'הפריסה לא הסתיימה תוך 20 דקות');
      return;
    }
    if (r.status === 'verifying') {
      const h = await health();
      const base = r.baseline || {};
      const sinceUp = Date.now() - Date.parse(r.deployed_at);
      const problems: string[] = [];
      if (r.deployments?.engine && sinceUp > GRACE_MS) {
        if (h.arms_online < (base.arms_online || 0)) problems.push(`מחוברות ${h.arms_online}/${base.arms_online}`);
        if (h.engine_age_s === null || h.engine_age_s > 120) problems.push('המנוע לא מדווח');
        // the arms sync must keep finishing (on/off, warm-up, new arms are picked up through it)
        if (h.sync_age_s !== null && h.sync_age_s > 90) problems.push(`סנכרון הזרועות לא הסתיים ${h.sync_age_s} שניות`);
      }
      if (r.deployments?.web && !(typeof h.web === 'string' && h.web.startsWith(r.commit_sha.slice(0, 7)))) {
        if (sinceUp > 90_000) problems.push(`הממשק: ${h.web}`);
      }
      if (!r.deployments?.engine && r.components.includes('db') && (h.engine_age_s === null || h.engine_age_s > 180)) problems.push('המנוע לא מדווח');
      const samples = [...((r.health?.samples as any[]) || []), { ...h, problems }].slice(-20);
      const badCount = samples.filter((s) => s.problems?.length).length;
      await db.from('releases').update({ health: { samples, bad: badCount } }).eq('id', r.id);
      r.health = { samples, bad: badCount };
      if (badCount >= BAD_LIMIT) return rollback(r, problems.join(', ') || 'בדיקות תקינות נכשלו');
      if (Date.now() > Date.parse(r.verify_until)) {
        for (const c of Object.keys(r.deployments || {})) {
          await db.from('release_live').upsert({ component: c, commit_sha: r.commit_sha, release_id: r.id, since: new Date().toISOString() });
        }
        await db.from('releases').update({ status: 'superseded' }).eq('status', 'live').neq('id', r.id).overlaps('components', Object.keys(r.deployments || {}).length ? Object.keys(r.deployments) : r.components);
        return note(r, `תקין – הגרסה פעילה (${badCount} דגימות חריגות מתוך ${samples.length})`, { status: 'live' });
      }
      return;
    }
  }

  // 2) next approved release whose time has come
  const { data: next } = await db.from('releases').select('*').eq('status', 'approved').lte('deploy_after', new Date().toISOString()).order('id').limit(1);
  const n = next?.[0];
  if (!n) return;
  const comps: string[] = n.components;
  const touchesEngine = comps.includes('engine');
  if (touchesEngine) {
    const { count } = await db.from('campaigns').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running']);
    if ((count || 0) > 0) {
      const last = (n.log || []).at(-1)?.msg || '';
      if (!last.startsWith('ממתין')) await note(n, 'ממתין לסיום הפצות פעילות לפני הפעלה מחדש של המנוע');
      return;
    }
  }
  const { data: claimed } = await db.from('releases').update({ status: 'deploying', started_at: new Date().toISOString() }).eq('id', n.id).eq('status', 'approved').select('id');
  if (!claimed?.length) return;
  const h = await health();
  const prev: Record<string, string | null> = {};
  for (const c of ['web', 'engine']) if (comps.includes(c)) prev[c] = await liveCommit(c);
  await note(n, 'מתחיל: גיבוי נתונים', { baseline: h, prev });
  const { error: snapErr } = await db.rpc('runner_snapshot', { p_release: n.id });
  if (snapErr) return note(n, `הגיבוי נכשל, העדכון לא בוצע: ${snapErr.message}`, { status: 'failed' });
  if (comps.includes('db')) {
    const { error } = await db.rpc('runner_exec', { p_release: n.id, p_undo: false });
    if (error) return note(n, `שינוי מסד הנתונים נכשל ולא הוחל (בוטל אוטומטית): ${error.message}`, { status: 'failed' });
  }
  const deployments: Record<string, string> = {};
  try {
    for (const c of ['web', 'engine']) if (comps.includes(c)) deployments[c] = await deploy(c, n.commit_sha);
  } catch (e) {
    n.deployments = deployments;
    n.prev = prev;
    return rollback(n, `הפריסה לא התחילה: ${(e as Error).message}`);
  }
  if (!Object.keys(deployments).length) {
    // DB-only change: watch health for a few minutes
    return note(n, 'שינוי מסד הנתונים הוחל, בודק תקינות', {
      status: 'verifying', deployments, deployed_at: new Date().toISOString(), verify_until: new Date(Date.now() + WATCH_MS.db).toISOString(),
    });
  }
  await note(n, `פריסה התחילה: ${Object.keys(deployments).join(', ')}`, { deployments });
}

Deno.serve(async (req) => {
  // the key lives in the database (ops.runner_key); pg_cron sends it, nobody else knows it
  const { data: ok } = await db.rpc('runner_key_ok', { p_key: req.headers.get('x-runner-key') || '' });
  if (ok !== true) return new Response('no', { status: 401 });
  try {
    await step();
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
});
