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
// ---- saved group lists ("stations"): pick a list instead of choosing groups one by one ----
const LISTS_FILE = path.join(DATA_DIR, 'lists.json');
let lists = [];
try { lists = JSON.parse(fs.readFileSync(LISTS_FILE, 'utf8')); } catch {}
const saveLists = () => { fs.writeFileSync(LISTS_FILE + '.tmp', JSON.stringify(lists)); fs.renameSync(LISTS_FILE + '.tmp', LISTS_FILE); };
function cleanGroups(gs) {
  const seen = new Map();
  for (const g of Array.isArray(gs) ? gs : []) if (g && typeof g.id === 'string' && g.id.endsWith('@g.us')) seen.set(g.id, { id: g.id, name: String(g.name || g.id).slice(0, 200) });
  return [...seen.values()];
}

// what a user may do; older users (before permissions existed) keep full access
const DEFAULT_PERMS = { remove: true, add: true, makeAdmin: false };
const OWNER = { id: 'owner', name: 'מנהל', owner: true, perms: { remove: true, add: true, makeAdmin: true }, dailyLimit: 0 };
const permsOf = (u) => ({ ...DEFAULT_PERMS, ...(u.perms || {}) });
const pub = (u) => ({ id: u.id, name: u.name, owner: false, perms: permsOf(u), dailyLimit: Number(u.dailyLimit) || 0 });
function userByCode(code) {
  if (same(code, ACCESS_CODE)) return OWNER;
  const u = users.list.find((x) => same(code, x.code));
  if (!u || u.active === false) return null;
  return pub(u);
}
function userById(id) {
  if (id === 'owner') return OWNER;
  const u = users.list.find((x) => x.id === id);
  // a blocked user is logged out at once
  return u && u.active !== false ? pub(u) : null;
}
let touchTimer = null;
function touchUser(id, field) {
  const u = users.list.find((x) => x.id === id);
  if (!u) return;
  u[field] = new Date().toISOString();
  if (field === 'lastLoginAt') return saveUsers();
  if (!touchTimer) touchTimer = setTimeout(() => { touchTimer = null; saveUsers(); }, 60_000);
}
// actions (one per group) the user started today / ever, from the job history
function usage(u) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  let todayN = 0, total = 0;
  const recent = [];
  for (const j of jobs.list) {
    if (j.byId !== u.id) continue;
    const n = j.items.filter((i) => i.status === 'ok' || i.status === 'fail').length;
    total += n;
    if (new Date(j.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) === today) todayN += j.items.length;
    if (recent.length < 10) recent.push({ action: j.action, number: j.number, groups: j.items.length, ok: j.items.filter((i) => i.status === 'ok').length, createdAt: j.createdAt, makeAdmin: !!j.makeAdmin });
  }
  return { today: todayN, total, recent };
}
const userView = (u) => ({
  id: u.id, name: u.name, phone: u.phone || '', note: u.note || '', code: u.code, active: u.active !== false,
  perms: permsOf(u), dailyLimit: Number(u.dailyLimit) || 0,
  createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, lastSeenAt: u.lastSeenAt || null, usage: usage(u),
});
function newCode() {
  for (;;) {
    const c = String(crypto.randomInt(100000, 999999));
    if (c !== ACCESS_CODE && !users.list.some((u) => u.code === c)) return c;
  }
}

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
// cookie = expiry.userId.codeGeneration.signature – issuing a new code bumps the generation,
// so the user's old sessions stop working at once
const genOf = (uid) => (uid === 'owner' ? 0 : users.list.find((x) => x.id === uid)?.gen || 0);
function makeToken(uid) {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const g = genOf(uid);
  return `${exp}.${uid}.${g}.${sign(`${exp}.${uid}.${g}`)}`;
}
function authed(req) {
  const m = /(?:^|;\s*)mm=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('.');
  let exp, uid, g, sig, signed;
  if (parts.length === 2) [exp, sig, uid, g, signed] = [parts[0], parts[1], 'owner', 0, parts[0]]; // oldest cookies: owner
  else if (parts.length === 3) [exp, uid, sig, g, signed] = [parts[0], parts[1], parts[2], 0, `${parts[0]}.${parts[1]}`];
  else [exp, uid, g, sig, signed] = [parts[0], parts[1], Number(parts[2]), parts[3], `${parts[0]}.${parts[1]}.${parts[2]}`];
  if (!exp || !sig || Number(exp) < Date.now()) return null;
  const good = sign(signed);
  if (!(sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)))) return null;
  if (Number(g) !== genOf(uid)) return null;
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
      if (!who.owner) touchUser(who.id, 'lastLoginAt');
      return send(res, 200, { ok: true }, { 'set-cookie': `mm=${makeToken(who.id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
    }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'לא נמצא' });
    const me = authed(req);
    if (!me) return send(res, 401, { error: 'צריך להתחבר' });
    const ownerOnly = () => send(res, 403, { error: 'רק המנהל יכול לעשות את זה' });

    if (!me.owner) touchUser(me.id, 'lastSeenAt');
    if (p === '/api/status' && req.method === 'GET') return send(res, 200, { ...arm.status(), running: jobs.running, settings: jobs.settings, me });
    if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': 'mm=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
    if (p === '/api/users' && req.method === 'GET') {
      if (!me.owner) return ownerOnly();
      return send(res, 200, { users: users.list.map(userView) });
    }
    if (p === '/api/users' && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) throw new Error('צריך שם למשתמש');
      const u = { id: crypto.randomBytes(6).toString('hex'), name, code: newCode(), active: true, perms: { ...DEFAULT_PERMS }, dailyLimit: 0, createdAt: new Date().toISOString() };
      users.list.push(u);
      saveUsers();
      return send(res, 200, { user: userView(u) });
    }
    const updUser = /^\/api\/users\/([a-f0-9]+)$/.exec(p);
    if (updUser && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      const u = users.list.find((x) => x.id === updUser[1]);
      if (!u) throw new Error('המשתמש לא נמצא');
      const b = await readBody(req);
      if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 40); if (!n) throw new Error('צריך שם למשתמש'); u.name = n; }
      if (b.phone !== undefined) u.phone = String(b.phone).trim().slice(0, 30);
      if (b.note !== undefined) u.note = String(b.note).trim().slice(0, 500);
      if (b.active !== undefined) u.active = !!b.active;
      if (b.perms) u.perms = { remove: !!b.perms.remove, add: !!b.perms.add, makeAdmin: !!b.perms.makeAdmin };
      if (b.dailyLimit !== undefined) u.dailyLimit = Math.max(0, Math.min(10000, Math.floor(Number(b.dailyLimit) || 0)));
      saveUsers();
      return send(res, 200, { user: userView(u) });
    }
    const newCodeFor = /^\/api\/users\/([a-f0-9]+)\/code$/.exec(p);
    if (newCodeFor && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      const u = users.list.find((x) => x.id === newCodeFor[1]);
      if (!u) throw new Error('המשתמש לא נמצא');
      if (u.seed) users.removedSeeds.push(u.code);
      u.code = newCode();
      // a new code logs the user out everywhere: cookies carry the id, so bump a key the cookie must match
      u.gen = (u.gen || 0) + 1;
      saveUsers();
      return send(res, 200, { user: userView(u) });
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
    if (p === '/api/groups' && req.method === 'GET') return send(res, 200, { groups: arm.allGroups() });
    if (p === '/api/lists' && req.method === 'GET') return send(res, 200, { lists });
    if (p === '/api/lists' && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      const b = await readBody(req);
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) throw new Error('צריך שם לרשימה');
      const l = { id: crypto.randomBytes(5).toString('hex'), name, groups: cleanGroups(b.groups), createdAt: new Date().toISOString() };
      lists.push(l);
      saveLists();
      return send(res, 200, { list: l });
    }
    const lUpd = /^\/api\/lists\/([a-f0-9]+)$/.exec(p);
    if (lUpd && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      const l = lists.find((x) => x.id === lUpd[1]);
      if (!l) throw new Error('הרשימה לא נמצאה');
      const b = await readBody(req);
      if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 40); if (!n) throw new Error('צריך שם לרשימה'); l.name = n; }
      if (b.groups !== undefined) l.groups = cleanGroups(b.groups);
      saveLists();
      return send(res, 200, { list: l });
    }
    const lDel = /^\/api\/lists\/([a-f0-9]+)\/delete$/.exec(p);
    if (lDel && req.method === 'POST') {
      if (!me.owner) return ownerOnly();
      lists = lists.filter((x) => x.id !== lDel[1]);
      saveLists();
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
    if (p === '/api/jobs' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.action === 'remove' && !me.perms.remove) return send(res, 403, { error: 'אין לך הרשאה להסיר' });
      if (b.action === 'add' && !me.perms.add) return send(res, 403, { error: 'אין לך הרשאה לצרף' });
      if ((b.makeAdmin || b.action === 'promote' || b.action === 'demote') && !me.perms.makeAdmin) return send(res, 403, { error: 'אין לך הרשאה לנהל מנהלים' });
      if (!me.owner && me.dailyLimit) {
        const used = usage({ id: me.id }).today;
        const want = Array.isArray(b.groups) ? b.groups.length : 0;
        if (used + want > me.dailyLimit) return send(res, 403, { error: `הגעת למגבלה היומית (${me.dailyLimit} קבוצות). נשארו היום ${Math.max(0, me.dailyLimit - used)}` });
      }
      return send(res, 200, { job: jobs.create({ ...b, by: me.name, byId: me.id }) });
    }
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
