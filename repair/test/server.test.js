const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/server');
const { createPipeline } = require('../src/pipeline');
const h = require('./helpers');

async function boot() {
  const cfg = h.makeCfg();
  const store = h.createMemoryStore();
  const deps = { cfg, store, wa: h.fakeWa(), railway: h.fakeRailway({ staging: false }), github: h.fakeGitHub(), ws: h.fakeWs({ files: [] }), claude: h.fakeClaude([{ parsed: null }]), log: h.silentLog };
  const pipeline = createPipeline(deps);
  const server = createServer({ ...deps, pipeline });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, { method = 'GET', body, csrf = true } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Botix': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return { server, call, store, cfg };
}

test('admin API: login, CSRF guard, numbers, state, security headers', async (t) => {
  const s = await boot();
  t.after(() => s.server.close());

  assert.equal((await s.call('/api/state')).status, 401);
  assert.equal((await s.call('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  assert.equal((await s.call('/api/login', { method: 'POST', body: { password: s.cfg.adminPassword } })).status, 200);

  const st = await s.call('/api/state');
  assert.equal(st.status, 200);
  assert.equal(st.json.wa.state, 'connected');
  const keys = st.json.readiness.map((r) => r.key);
  assert.ok(keys.includes('staging') && keys.includes('claude'));
  assert.equal(st.json.readiness.find((r) => r.key === 'staging').ok, false);
  // the state never contains secret values
  assert.ok(!st.text.includes(s.cfg.github.token) && !st.text.includes(s.cfg.claudeOauthToken));
  assert.ok(st.headers.get('content-security-policy').includes("script-src 'self'"));

  // POST without our header is refused even with the cookie
  assert.equal((await s.call('/api/numbers', { method: 'POST', body: { phone: '0501234567' }, csrf: false })).status, 403);
  assert.equal((await s.call('/api/numbers', { method: 'POST', body: { phone: 'abc' } })).status, 400);
  const added = await s.call('/api/numbers', { method: 'POST', body: { phone: '050-123-4567', name: 'מיכאל', role: 'approver' } });
  assert.equal(added.json.phone, '972501234567');
  const list = await s.call('/api/numbers');
  assert.equal(list.json[0].display, '050-1234567');

  const rb = await s.call('/api/tickets/1/rollback', { method: 'POST', body: { confirm: 'כן' } });
  assert.equal(rb.status, 400);

  const page = await s.call('/');
  assert.ok(page.text.includes('BotiX'));
  assert.equal((await s.call('/healthz')).json.ok, true);

  const ev = await s.call('/api/events');
  assert.ok(ev.json.some((e) => e.type === 'number_added'));
});

test('a forged X-Forwarded-For does not bypass the login limit', async (t) => {
  const s = await boot();
  t.after(() => s.server.close());
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const tryLogin = (fake, password) =>
    fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `${fake}, 10.0.0.9` }, body: JSON.stringify({ password }) });
  for (let i = 0; i < 5; i++) await tryLogin(`1.1.1.${i}`, 'wrong');
  assert.equal((await tryLogin('9.9.9.9', s.cfg.adminPassword)).status, 429);
});

test('login is rate-limited after 5 failures', async (t) => {
  const s = await boot();
  t.after(() => s.server.close());
  for (let i = 0; i < 5; i++) await s.call('/api/login', { method: 'POST', body: { password: 'x' } });
  assert.equal((await s.call('/api/login', { method: 'POST', body: { password: s.cfg.adminPassword } })).status, 429);
});
