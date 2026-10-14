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

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));

// ---- login: one access code, signed cookie for 30 days ----
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeToken() {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  return `${exp}.${sign(String(exp))}`;
}
function authed(req) {
  const m = /(?:^|;\s*)mm=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
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
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, INDEX);

    if (p === '/api/login' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
      const a = attempts.get(ip) || { n: 0, until: 0 };
      if (a.until > Date.now()) return send(res, 429, { error: 'יותר מדי ניסיונות, נסה שוב בעוד כמה דקות' });
      const { code } = await readBody(req);
      const ok = typeof code === 'string' && code.length === ACCESS_CODE.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(ACCESS_CODE));
      if (!ok) {
        a.n += 1;
        if (a.n >= 5) Object.assign(a, { n: 0, until: Date.now() + 10 * 60_000 });
        attempts.set(ip, a);
        return send(res, 401, { error: 'קוד שגוי' });
      }
      attempts.delete(ip);
      return send(res, 200, { ok: true }, { 'set-cookie': `mm=${makeToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
    }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'לא נמצא' });
    if (!authed(req)) return send(res, 401, { error: 'צריך להתחבר' });

    if (p === '/api/status' && req.method === 'GET') return send(res, 200, { ...arm.status(), running: jobs.running, settings: jobs.settings });
    if (p === '/api/refresh' && req.method === 'POST') {
      await arm.refreshGroups();
      return send(res, 200, arm.status());
    }
    if (p === '/api/lookup' && req.method === 'POST') {
      const { number } = await readBody(req);
      return send(res, 200, await arm.lookup(number));
    }
    if (p === '/api/jobs' && req.method === 'GET') return send(res, 200, { jobs: jobs.list.slice(0, 30) });
    if (p === '/api/jobs' && req.method === 'POST') return send(res, 200, { job: jobs.create(await readBody(req)) });
    const stop = /^\/api\/jobs\/([a-f0-9]+)\/stop$/.exec(p);
    if (stop && req.method === 'POST') return send(res, 200, { ok: jobs.stop(stop[1]) });
    if (p === '/api/settings' && req.method === 'POST') return send(res, 200, jobs.setSettings(await readBody(req)));
    if (p === '/api/arm/logout' && req.method === 'POST') {
      await arm.logout();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'לא נמצא' });
  } catch (e) {
    return send(res, 400, { error: e?.message || 'שגיאה' });
  }
});

server.listen(PORT, () => console.log(`members tool on :${PORT}${DEMO ? ' (demo)' : ''}`));
