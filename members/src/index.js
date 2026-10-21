// "ניהול חברים בקבוצות" – a separate small service. It never touches BotiX:
// no shared database tables, no calls to the engine, its own WhatsApp number and session.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Jobs } = require('./jobs');

const PORT = Number(process.env.PORT || 8080);
const DEMO = process.env.DEMO === '1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data/members');
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const SECRET = process.env.SESSION_SECRET || ACCESS_CODE;

if (!ACCESS_CODE || ACCESS_CODE.length < 4) {
  console.error('חסר ACCESS_CODE (קוד כניסה, לפחות 4 תווים)');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const arm = DEMO ? new (require('./demoArm').DemoArm)() : new (require('./arm').Arm)(DATA_DIR);
const jobs = new Jobs(arm, DATA_DIR);
arm.start().catch((e) => console.error('arm start failed', e));

const PUBLIC = path.join(__dirname, '..', 'public');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'));
// the open app compares this with the version it was loaded with and refreshes itself on a new one
const VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || crypto.createHash('sha1').update(INDEX).digest('hex')).slice(0, 12);
// app files (install as an app on the phone) – public, no login needed
const STATIC = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/maskable-512.png': ['icons/maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  '/favicon.ico': ['icons/icon-192.png', 'image/png'],
};
const staticFiles = Object.fromEntries(Object.entries(STATIC).map(([u, [f, type]]) => [u, { body: fs.readFileSync(path.join(PUBLIC, f)), type }]));

// ---- login: the owner's code (ACCESS_CODE) plus separate users, each with an own code ----
// Users live in DATA_DIR/users.json; the owner adds and removes them in the app. A removed user's
// cookie stops working at once (the cookie carries the user id, checked on every request).
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = { list: [], removedSeeds: [] };
try { users = { ...users, ...JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) }; } catch {}
const saveUsers = () => { fs.writeFileSync(USERS_FILE + '.tmp', JSON.stringify(users)); fs.renameSync(USERS_FILE + '.tmp', USERS_FILE); };
// SEED_USERS="name:code;name:code" – created once (not brought back after the owner removes them)
for (const part of String(process.env.SEED_USERS || '').split(';')) {
  const i = part.lastIndexOf(':');
  if (i < 1) continue;
  const name = part.slice(0, i).trim(), code = part.slice(i + 1).trim();
  if (code.length < 4 || code === ACCESS_CODE || users.removedSeeds.includes(code) || users.list.some((u) => u.code === code)) continue;
  users.list.push({ id: crypto.randomBytes(6).toString('hex'), name, code, seed: true, createdAt: new Date().toISOString() });
}
saveUsers();

const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function userByCode(code) {
  if (same(code, ACCESS_CODE)) return { id: 'owner', name: 'מנהל', owner: true };
  const u = users.list.find((x) => same(code, x.code));
  return u ? { id: u.id, name: u.name, owner: false } : null;
}
function userById(id) {
  if (id === 'owner') return { id: 'owner', name: 'מנהל', owner: true };
  const u = users.list.find((x) => x.id === id);
  return u ? { id: u.id, name: u.name, owner: false } : null;
}
function newCode() {
  for (;;) {
    const c = String(crypto.randomInt(100000, 999999));
    if (c !== ACCESS_CODE && !users.list.some((u) => u.code === c)) return c;
  }
}

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken(uid) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  return `${exp}.${uid}.${sign(`${exp}.${uid}`)}`;
}
function authed(req) {
  const m = /(?:^|;\s*)mm=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.');
  // older cookies (before separate users) had no user id: they were the owner's
  const [exp, uid, sig] = parts.length === 2 ? [parts[0], 'owner', parts[1]] : parts;
  if (!exp || !sig || Number(exp) < Date.now()) return null;
  const good = sign(parts.length === 2 ? exp : `${exp}.${uid}`);
  if (!(sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)))) return null;
  return userById(uid);
}
const attempts = new Map(); // ip -> { n, until }

function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, {
    'content-type': isBuf ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 2e6) reject(new Error('גדול מדי'));
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error('בקשה לא תקינה'));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/health') return send(res, 200, { ok: true, arm: arm.status().state });
    if (p === '/version') return send(res, 200, { version: VERSION });
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, INDEX);
    if (req.method === 'GET' && staticFiles[p]) {
      const f = staticFiles[p];
      res.writeHead(200, { 'content-type': f.type, 'cache-control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400' });
      return res.end(f.body);
    }

    if (p === '/api/login' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
      const a = attempts.get(ip) || { n: 0, until: 0 };
      if (a.until > Date.now()) return send(res, 429, { error: 'יותר מדי ניסיונות, נסה שוב בעוד כמה דקות' });
      const { code } = await readBody(req);
      const who = userByCode(typeof code === 'string' ? code.trim() : '');
      if (!who) {
        a.n += 1;
        if (a.n >= 5) Object.assign(a, { n: 0, until: Date.now() + 10 * 60_000 });
        attempts.set(ip, a);
        return send(res, 401, { error: 'קוד שגוי' });
      }
      attempts.delete(ip);
      return send(res, 200, { ok: true }, { 'set-cookie': `mm=${makeToken(who.id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
    }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'לא נמצא' });
    const me = authed(req);
    if (!me) return send(res, 401, { error: 'צריך להתחבר' });
    const ownerOnly = () => send(res, 403, { error: 'רק המנהל יכול לעשות את זה' });

    if (p === '/api/status' && req.method === 'GET') return send(res, 200, { ...arm.status(), running: jobs.running, settings: jobs.settings, me });
    if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': 'mm=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
    if (p === '/api/users' && req.method === 'GET') {
      if (!me.owner) return ownerOnly();
      return send(res, 200, { users: users.list.map(({ id, name, code, createdAt }) => ({ id, name, code, createdAt })) });
    }
    if (p === '/api/users' && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      const name = String((await readBody(req)).name || '').trim().slice(0, 40);
      if (!name) throw new Error('צריך שם למשתמש');
      const u = { id: crypto.randomBytes(6).toString('hex'), name, code: newCode(), createdAt: new Date().toISOString() };
      users.list.push(u);
      saveUsers();
      return send(res, 200, { user: u });
    }
    const delUser = /^\/api\/users\/([a-f0-9]+)\/delete$/.exec(p);
    if (delUser && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      const u = users.list.find((x) => x.id === delUser[1]);
      if (u) {
        users.list = users.list.filter((x) => x !== u);
        if (u.seed) users.removedSeeds.push(u.code);
        saveUsers();
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/refresh' && req.method === 'POST') {
      await arm.refreshGroups();
      return send(res, 200, arm.status());
    }
    if (p === '/api/lookup' && req.method === 'POST') {
      const { number } = await readBody(req);
      return send(res, 200, await arm.lookup(number));
    }
    if (p === '/api/jobs' && req.method === 'GET') return send(res, 200, { jobs: jobs.list.slice(0, 30) });
    if (p === '/api/jobs' && req.method === 'POST') return send(res, 200, { job: jobs.create({ ...(await readBody(req)), by: me.name }) });
    const stop = /^\/api\/jobs\/([a-f0-9]+)\/stop$/.exec(p);
    if (stop && req.method === 'POST') return send(res, 200, { ok: jobs.stop(stop[1]) });
    if (p === '/api/settings' && req.method === 'POST') return me.owner ? send(res, 200, jobs.setSettings(await readBody(req))) : ownerOnly();
    if (p === '/api/arm/pair' && req.method === 'POST') {
      const { phone } = await readBody(req);
      return send(res, 200, await arm.requestPairing(phone));
    }
    if (p === '/api/arm/logout' && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      await arm.logout();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'לא נמצא' });
  } catch (e) {
    return send(res, 400, { error: e?.message || 'שגיאה' });
  }
});

server.listen(PORT, () => console.log(`members tool on :${PORT}${DEMO ? ' (demo)' : ''}`));
