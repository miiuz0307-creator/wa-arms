// Admin web server: login, WhatsApp connection + QR, allowed numbers, tickets, audit log.
const http = require('http');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { signSession, verifySession, safeEqual, redact } = require('./secure');
const { toIntl, isValidIntl, formatLocal } = require('./phones');
const { areaLabel } = require('./classify');
const M = require('./messages');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function createServer({ cfg, store, wa, railway, github, claude, pipeline, log, ws }) {
  const failures = new Map(); // ip -> [timestamps]
  const secure = process.env.NODE_ENV === 'production';

  const send = (res, code, body, headers = {}) => {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(code, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
    res.end(isObj ? JSON.stringify(body) : body);
  };

  const cookies = (req) =>
    Object.fromEntries(
      String(req.headers.cookie || '')
        .split(';')
        .map((c) => c.trim().split('='))
        .filter((p) => p.length === 2),
    );

  const authed = (req) => verifySession(cfg.sessionSecret, cookies(req).botix_admin);

  async function body(req) {
    let raw = '';
    for await (const c of req) {
      raw += c;
      if (raw.length > 100_000) throw new Error('too large');
    }
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  // Railway's proxy appends the real client address as the LAST entry; earlier entries are client-controlled
  const ipOf = (req) => {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : String(req.socket.remoteAddress || '');
  };
  const allFailures = [];

  async function readiness() {
    const nums = await store.listNumbers();
    const wsStatus = wa.status();
    return [
      { key: 'db', label: 'מסד נתונים קבוע', ok: store.kind === 'postgres', hint: 'הוסיפו Postgres ב-Railway (DATABASE_URL). בלי זה הכול נמחק בהפעלה מחדש.' },
      { key: 'wa', label: 'WhatsApp מחובר', ok: wsStatus.state === 'connected', hint: 'לחצו "חיבור WhatsApp" וסרקו את ה-QR מהטלפון של מספר הבוט.' },
      { key: 'numbers', label: 'מספרים מאושרים', ok: nums.some((n) => n.active), hint: 'הוסיפו לפחות מספר אחד.' },
      { key: 'approver', label: 'יש מאשר', ok: nums.some((n) => n.active && n.role === 'approver'), hint: 'לפחות מספר אחד צריך הרשאת "מאשר".' },
      { key: 'claude', label: 'חיבור ל-Claude', ok: claude.ready(), hint: 'הריצו במחשב `claude setup-token` והוסיפו את התוצאה כ-CLAUDE_CODE_OAUTH_TOKEN.' },
      { key: 'github', label: 'גישה לקוד (GitHub)', ok: github.ready(), hint: 'צרו טוקן GitHub מוגבל למאגר wa-arms בלבד והוסיפו כ-GITHUB_TOKEN.' },
      { key: 'logs', label: 'לוגים וחזרה לאחור (Railway)', ok: railway.ready('production'), hint: 'צרו Project Token לסביבת production והוסיפו כ-RAILWAY_PROD_TOKEN.' },
      { key: 'staging', label: 'סביבת בדיקה (staging)', ok: railway.ready('staging'), hint: 'צרו סביבת staging ב-Railway שעוקבת אחרי הענף staging, והוסיפו RAILWAY_STAGING_ENV_ID ו-RAILWAY_STAGING_TOKEN.' },
      { key: 'runner', label: 'הפרדת הרשאות ל-Claude', ok: Boolean(ws.runner), hint: 'השרת צריך לרוץ מתוך ה-Dockerfile המצורף (משתמש runner נפרד).' },
    ];
  }

  const publicTicket = (t) => ({
    ...t,
    area_label: t.area ? areaLabel(t.area) : null,
    status_label: M.statusLabel(t.status),
    requester_display: formatLocal(t.requester_phone),
    images: (t.images || []).length,
  });

  async function api(req, res, url) {
    const m = req.method;
    const p = url.pathname;

    if (p === '/api/login' && m === 'POST') {
      const ip = ipOf(req);
      const recent = (failures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60_000);
      while (allFailures.length && Date.now() - allFailures[0] > 15 * 60_000) allFailures.shift();
      if (recent.length >= 5 || allFailures.length >= 30) return send(res, 429, { error: 'יותר מדי ניסיונות. נסו שוב בעוד רבע שעה.' });
      const { password } = await body(req);
      if (!cfg.adminPassword || !safeEqual(password || '', cfg.adminPassword)) {
        failures.set(ip, [...recent, Date.now()]);
        allFailures.push(Date.now());
        await pipeline.audit(null, 'admin', 'login_failed', `כניסה שגויה לממשק (${ip})`);
        return send(res, 401, { error: 'סיסמה שגויה' });
      }
      failures.delete(ip);
      await pipeline.audit(null, 'admin', 'login', 'כניסה לממשק הניהול');
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `botix_admin=${signSession(cfg.sessionSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`,
      });
    }
    if (p === '/api/logout' && m === 'POST') {
      if (authed(req)) await pipeline.audit(null, 'admin', 'logout', 'יציאה מממשק הניהול');
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'botix_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (!authed(req)) return send(res, 401, { error: 'נדרשת כניסה' });
    // simple CSRF guard on top of SameSite=Strict: our own page always sends this header
    if (m !== 'GET' && req.headers['x-botix'] !== '1') return send(res, 403, { error: 'בקשה לא מורשית' });

    if (p === '/api/state' && m === 'GET') {
      const s = wa.status();
      const qr = s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 320 }) : null;
      const open = await store.listTickets(100, ['queued', 'awaiting_approval', 'blocked', ...pipeline.ACTIVE]);
      return send(res, 200, {
        wa: { ...s, qr, me: s.me ? formatLocal(s.me) : null },
        readiness: await readiness(),
        counts: {
          open: open.length,
          awaiting: open.filter((t) => t.status === 'awaiting_approval').length,
          running: pipeline.isRunning(),
        },
        repo: cfg.github.repo,
      });
    }
    if (p === '/api/wa/connect' && m === 'POST') {
      await pipeline.audit(null, 'admin', 'wa_connect', 'התבקש חיבור WhatsApp');
      await wa.connect();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/wa/disconnect' && m === 'POST') {
      const { logout } = await body(req);
      await wa.disconnect({ logout: Boolean(logout) });
      await pipeline.audit(null, 'admin', 'wa_disconnect', logout ? 'WhatsApp נותק והחיבור נמחק' : 'WhatsApp נותק זמנית');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/numbers' && m === 'GET') {
      return send(res, 200, (await store.listNumbers()).map((n) => ({ ...n, display: formatLocal(n.phone) })));
    }
    if (p === '/api/numbers' && m === 'POST') {
      const b = await body(req);
      const phone = toIntl(b.phone);
      if (!isValidIntl(phone)) return send(res, 400, { error: 'מספר טלפון לא תקין' });
      const role = b.role === 'approver' ? 'approver' : 'requester';
      const n = await store.addNumber({ phone, name: String(b.name || '').slice(0, 60), role });
      await pipeline.audit(null, 'admin', 'number_added', `נוסף מספר מאושר: ${formatLocal(phone)} (${role === 'approver' ? 'מאשר' : 'מבקש'})`);
      return send(res, 200, n);
    }
    let mm;
    if ((mm = /^\/api\/numbers\/(\d+)$/.exec(p))) {
      const id = Number(mm[1]);
      if (m === 'DELETE') {
        const n = (await store.listNumbers()).find((x) => x.id === id);
        await store.removeNumber(id);
        await pipeline.audit(null, 'admin', 'number_removed', `הוסר מספר: ${n ? formatLocal(n.phone) : id}`);
        return send(res, 200, { ok: true });
      }
      if (m === 'PATCH') {
        const b = await body(req);
        const patch = {};
        if ('role' in b) patch.role = b.role === 'approver' ? 'approver' : 'requester';
        if ('active' in b) patch.active = Boolean(b.active);
        if ('name' in b) patch.name = String(b.name || '').slice(0, 60);
        const n = await store.updateNumber(id, patch);
        await pipeline.audit(null, 'admin', 'number_updated', `עודכן מספר ${n ? formatLocal(n.phone) : id}`, patch);
        return send(res, 200, n);
      }
    }

    if (p === '/api/tickets' && m === 'GET') {
      return send(res, 200, (await store.listTickets(100)).map(publicTicket));
    }
    if ((mm = /^\/api\/tickets\/(\d+)$/.exec(p)) && m === 'GET') {
      const t = await store.getTicket(mm[1]);
      if (!t) return send(res, 404, { error: 'לא נמצא' });
      return send(res, 200, { ticket: publicTicket(t), events: await store.listEvents({ ticketId: t.id }) });
    }
    if ((mm = /^\/api\/tickets\/(\d+)\/(cancel|reject|rollback)$/.exec(p)) && m === 'POST') {
      const id = Number(mm[1]);
      const action = mm[2];
      const b = await body(req);
      if (action === 'rollback') {
        if (b.confirm !== 'החזר') return send(res, 400, { error: 'כדי לאשר חזרה לגרסה הקודמת יש להקליד: החזר' });
        await pipeline.audit(id, 'admin', 'rollback_requested', 'התבקשה חזרה לגרסה הקודמת מהממשק');
        const r = await pipeline.rollback('admin', id);
        return send(res, 200, { ok: !r, message: r || 'השרת הוחזר לגרסה הקודמת' });
      }
      const r = action === 'cancel' ? await pipeline.cancel('admin', id, { isApprover: true }) : await pipeline.reject('admin', id);
      return send(res, 200, { ok: true, message: r });
    }

    if (p === '/api/events' && m === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
      return send(res, 200, await store.listEvents({ limit }));
    }

    return send(res, 404, { error: 'לא נמצא' });
  }

  function staticFile(res, p) {
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), { 'Content-Type': TYPES['.html'] });
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    send(res, 200, fs.readFileSync(file), { 'Content-Type': type, 'Cache-Control': rel === 'index.html' ? 'no-store' : 'public, max-age=300' });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/healthz') return send(res, 200, { ok: true, wa: wa.status().state });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') return send(res, 405, { error: 'שיטה לא נתמכת' });
      return staticFile(res, url.pathname);
    } catch (e) {
      log.error({ err: e.message, path: url.pathname }, 'request failed');
      if (!res.headersSent) send(res, 500, { error: redact(e.message).slice(0, 200) });
    }
  });
}

module.exports = { createServer };
