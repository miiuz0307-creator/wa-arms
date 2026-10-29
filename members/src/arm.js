// The one dedicated WhatsApp number ("arm") of this tool.
// Completely separate from BotiX: its own session folder, its own socket, no shared tables.
const fs = require('fs');
const path = require('path');
const { toIntl, bareJid, jidUser } = require('./phone');

// recent log lines are kept in memory for the support diagnostics (the VM console log isn't reliable)
// and in a file on disk, so the moments before a disconnect are still there after a restart
const LOG = [];
let LOG_FILE = null;
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  LOG.push(line.slice(0, 400));
  if (LOG.length > 120) LOG.shift();
  if (LOG_FILE) {
    try {
      if ((fs.statSync(LOG_FILE, { throwIfNoEntry: false })?.size || 0) > 1_000_000) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      fs.appendFileSync(LOG_FILE, `${line.slice(0, 1000)}\n`);
    } catch {}
  }
};

// a WhatsApp protocol node, short enough for the log
function nodeText(n) {
  if (!n) return '';
  const kids = Array.isArray(n.content) ? n.content.map((c) => `${c.tag}${Object.keys(c.attrs || {}).length ? JSON.stringify(c.attrs) : ''}`).join(',') : '';
  return `${n.tag}${JSON.stringify(n.attrs || {})}${kids ? `[${kids}]` : ''}`.slice(0, 500);
}

// Baileys wants a pino-style logger; keep it quiet
const silent = {
  level: 'silent',
  child() {
    return silent;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

const WA_ID = /@(s\.whatsapp\.net|lid)$/;

// every id a participant is known by (phone jid and/or lid, depending on the group)
function participantIds(p) {
  const out = new Set();
  for (const v of Object.values(p || {})) if (typeof v === 'string' && WA_ID.test(v)) out.add(bareJid(v));
  return out;
}

class Arm {
  constructor(dataDir) {
    this.authDir = path.join(dataDir, 'auth');
    this.dataDir = dataDir;
    LOG_FILE = path.join(dataDir, 'arm.log');
    try { this.logouts = JSON.parse(fs.readFileSync(path.join(dataDir, 'logouts.json'), 'utf8')); } catch { this.logouts = []; }
    this.sock = null;
    this.state = 'stopped'; // stopped | connecting | qr | online | logged_out
    this.qr = null;
    this.me = null; // { pn, lid }
    this.groups = new Map(); // jid -> { id, name, participants: [{ids:Set, admin}] }
    this.groupsAt = null;
    this.lastError = null;
    this.retry = 0;
    this.refreshing = null;
    try { this.lastPhone = fs.readFileSync(path.join(dataDir, 'last-phone'), 'utf8').trim(); } catch {}
    try { this.lastLogout = JSON.parse(fs.readFileSync(path.join(dataDir, 'last-logout'), 'utf8')); } catch {}
  }

  ownJids() {
    const norm = (j) => (j ? String(j).replace(/:\d+(?=@)/, '') : null);
    const c = this.sock?.authState?.creds;
    return [this.sock?.user?.id, this.sock?.user?.lid, c?.me?.id, c?.me?.lid].map(norm).filter(Boolean);
  }

  /** true = a message this tool doesn't need: confirm it without decrypting. */
  skipIncoming(node) {
    const a = node?.attrs || {};
    const from = a.from || '';
    if (!a.id) return false;
    if (a.category === 'peer') return false; // the arm's own phone talking to this device
    const f = from.replace(/:\d+(?=@)/, '');
    const own = this.ownJids();
    if (own.includes(f)) return false; // messages from the arm's own number
    if (from.endsWith('@g.us')) {
      const p = String(a.participant || '').replace(/:\d+(?=@)/, '');
      return !(p && own.includes(p)); // group messages – unless written from the arm's own phone
    }
    return from.endsWith('@s.whatsapp.net') || from.endsWith('@lid') || from === 'status@broadcast' || from.endsWith('@newsletter');
  }

  confirmSkipped(sock, node) {
    const a = node.attrs;
    const receipt = { tag: 'receipt', attrs: { id: a.id, to: a.from } };
    if (a.participant) receipt.attrs.participant = a.participant;
    const ack = { tag: 'ack', attrs: { id: a.id, to: a.from, class: 'message' } };
    if (a.participant) ack.attrs.participant = a.participant;
    if (a.recipient) ack.attrs.recipient = a.recipient;
    if (a.type) ack.attrs.type = a.type;
    Promise.resolve(sock.sendNode?.(receipt)).then(() => sock.sendNode?.(ack)).catch(() => {});
    this.skipped = (this.skipped || 0) + 1;
  }

  status() {
    let adminOf = 0;
    for (const g of this.groups.values()) if (this.iAmAdmin(g)) adminOf += 1;
    return {
      state: this.state,
      qr: this.state === 'qr' ? this.qr : null,
      phone: this.me ? jidUser(this.me.pn) : null,
      groups: this.groups.size,
      adminOf,
      groupsAt: this.groupsAt,
      lastError: this.lastError,
      pairCode: this.state !== 'online' ? this.pairCode || null : null,
      pairPhone: this.state !== 'online' ? this.pairPhone || null : null,
      pairError: this.state !== 'online' ? this.pairError || null : null,
      wasLoggedOut: !!this.wasLoggedOut || !!this.lastLogout,
      lastLogout: this.lastLogout ? { at: this.lastLogout.at, reason: this.lastLogout.reason, kind: this.lastLogout.kind || null, afterAction: this.lastLogout.lastAction || null } : null,
      lastPhone: this.lastPhone || null,
    };
  }

  /** Someone has the app open: if a QR is wanted and the arm stopped renewing it, start again. */
  wake() {
    this.viewedAt = Date.now();
    if (this.idle) {
      this.idle = false;
      log('app opened – new QR');
      this.later(0);
    }
  }

  // one pending reconnect at a time (a second one would replace a socket that is mid-link)
  later(ms) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start().catch((e) => log('start failed', e.message)), ms);
  }

  /** Link with an 8-character code typed into WhatsApp instead of scanning a QR. */
  async requestPairing(raw) {
    const intl = toIntl(raw);
    if (!intl) throw new Error('מספר לא תקין');
    if (this.state === 'online') throw new Error('הזרוע כבר מחוברת');
    if (fs.existsSync(path.join(this.authDir, 'creds.json'))) {
      try { if (JSON.parse(fs.readFileSync(path.join(this.authDir, 'creds.json'), 'utf8'))?.me?.id) throw new Error('linked'); } catch (e) { if (e.message === 'linked') throw new Error('הזרוע מקושרת וממתינה לחיבור מחדש. נסה שוב בעוד דקה.'); }
    }
    this.pairPhone = intl;
    this.pairCode = null;
    this.pairError = null;
    this.pairAsked = false;
    // fresh connection: the code is requested on its first QR event
    clearTimeout(this.reconnectTimer);
    const old = this.sock;
    this.sock = null;
    try {
      old?.end?.(undefined);
    } catch {}
    await this.start();
    for (let i = 0; i < 40 && !this.pairCode && !this.pairError; i++) await new Promise((r) => setTimeout(r, 250));
    if (this.pairError) throw new Error(this.pairError);
    if (!this.pairCode) throw new Error('וואטסאפ לא החזיר קוד. נסה שוב.');
    return { code: this.pairCode };
  }

  async start() {
    const baileys = require('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;
    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]));
    } catch {}

    this.state = 'connecting';
    const sock = makeWASocket({
      // same connection profile as the BotiX arms, which stay linked for weeks: a standard browser name
      // (a made-up one like "Members" stands out) and cached encryption keys
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silent) },
      version,
      logger: silent,
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: false,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      // Only skip broadcast channels. Private messages must NOT be ignored: they include key sharing and
      // sync messages from the arm's own phone, and a linked device that never answers them is logged out
      // by WhatsApp (that is what disconnected the arm every so often).
      shouldIgnoreJid: (jid) => String(jid) === 'status@broadcast' || String(jid).endsWith('@newsletter'),
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    // ---- same protections as the BotiX arms, which stay linked for weeks on this library ----
    // 1) This tool never reads messages. Decrypting the traffic of ~30 busy groups made the linked device
    //    exchange keys and send "retry" requests for every message it couldn't decrypt – heavy, abnormal
    //    traffic. Now group/private messages are only confirmed (receipt + ack), not decrypted.
    //    Messages from the arm's own phone (key sharing, sync) still go through – ignoring those
    //    got the device logged out before.
    const baileysMessage = sock.ws.listeners('CB:message');
    if (baileysMessage.length) {
      sock.ws.removeAllListeners('CB:message');
      sock.ws.on('CB:message', (node) => {
        if (this.skipIncoming(node)) return this.confirmSkipped(sock, node);
        for (const fn of baileysMessage) {
          try { fn(node); } catch (e) { log('message handler failed', e.message); }
        }
      });
    } else log('could not find the message handler – messages are decrypted');
    // 2) Baileys 6.7.24 can leave its event buffer on, so later events (like member changes) never arrive
    clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      if (this.sock !== sock) return clearInterval(this.flushTimer);
      try { if (sock.ev.isBuffering?.()) sock.ev.flush(); } catch {}
    }, 200);
    // 3) messages waiting from while the arm was away arrive in batches – keep asking until WhatsApp is done
    clearInterval(this.batchPump);
    sock.ws.on('CB:ib,,offline_preview', () => {
      clearInterval(this.batchPump);
      this.batchPump = setInterval(() => {
        if (this.sock !== sock) return clearInterval(this.batchPump);
        Promise.resolve(sock.sendNode?.({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] })).catch(() => {});
      }, 1500);
    });
    sock.ws.on('CB:ib,,offline', () => clearInterval(this.batchPump));
    this.skipped = 0;

    // exactly what WhatsApp says when it closes the connection (the reason behind a logout)
    sock.ws.on('CB:stream:error', (n) => log('whatsapp stream error', nodeText(n)));
    sock.ws.on('CB:failure', (n) => log('whatsapp failure', nodeText(n)));

    // A socket that neither opens nor closes would leave the arm stuck on "connecting" (as in BotiX)
    clearTimeout(this.connectGuard);
    const connectStart = Date.now();
    this.connectGuard = setTimeout(() => {
      if (this.sock !== sock || this.state === 'online' || (this.qrAt || 0) > connectStart) return;
      log('still not connected after 90s – retrying');
      try { sock.end(new Error('connect stuck')); } catch {}
    }, 90_000);
    // Watchdog: a connection that went dead without closing. Ask WhatsApp for a ping every 2 minutes;
    // no answer in 20 s → reconnect (takes a few seconds, no QR).
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.sock !== sock) return clearInterval(this.watchdog);
      if (this.state !== 'online' || this.pinging) return;
      this.pinging = true;
      Promise.race([
        sock.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:p', id: sock.generateMessageTag() }, content: [{ tag: 'ping', attrs: {} }] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 20_000)),
      ])
        .catch((e) => {
          if (this.sock !== sock) return;
          log('no answer from WhatsApp – reconnecting', e.message);
          try { sock.end(new Error('stalled')); } catch {}
        })
        .finally(() => { this.pinging = false; });
    }, 120_000);

    sock.ev.on('connection.update', async (u) => {
      if (sock !== this.sock) return;
      if (u.qr) {
        this.qrAt = Date.now();
        this.qr = u.qr;
        this.state = 'qr';
        // linking with a code instead of a QR (the phone can't scan its own screen): ask once per connection
        if (this.pairPhone && !this.pairCode && !this.pairAsked) {
          this.pairAsked = true;
          try {
            const code = await sock.requestPairingCode(this.pairPhone);
            this.pairCode = String(code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2');
            this.pairAt = new Date().toISOString();
            log('pairing code issued');
          } catch (e) {
            this.pairError = 'וואטסאפ לא החזיר קוד. בדוק את המספר ונסה שוב.';
            this.pairPhone = null;
            log('pairing code failed', e.message);
          }
        }
      }
      if (u.connection === 'open') {
        this.state = 'online';
        this.qr = null;
        this.pairPhone = null;
        this.pairCode = null;
        this.pairError = null;
        this.wasLoggedOut = false;
        this.lastLogout = null;
        try { fs.rmSync(path.join(path.dirname(this.authDir), 'last-logout'), { force: true }); } catch {}
        this.retry = 0;
        this.lastError = null;
        this.onlineAt = new Date().toISOString();
        this.me = { pn: bareJid(sock.user?.id), lid: sock.user?.lid ? bareJid(sock.user.lid) : null };
        log('arm online', jidUser(this.me.pn));
        this.lastPhone = jidUser(this.me.pn);
        try { fs.writeFileSync(path.join(path.dirname(this.authDir), 'last-phone'), this.lastPhone); } catch {}
        this.refreshGroups().catch((e) => log('groups refresh failed', e.message));
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.lastError = u.lastDisconnect?.error?.message || String(code || '');
        let detail = '';
        try { detail = JSON.stringify(u.lastDisconnect?.error?.data ?? u.lastDisconnect?.error?.output?.payload ?? '').slice(0, 300); } catch {}
        log('connection closed', code, this.lastError, detail);
        if (code === DisconnectReason.loggedOut) {
          log('arm logged out – needs a new QR');
          this.state = 'logged_out';
          this.wasLoggedOut = true;
          // keep the whole picture: what WhatsApp said, the last group action, and the log just before it
          const kind = /device_removed/.test(LOG.slice(-10).join(' ') + detail) ? 'device_removed' : null;
          this.lastLogout = { at: new Date().toISOString(), reason: this.lastError, kind, detail, lastAction: this.lastAction || null, onlineSince: this.onlineAt || null, log: LOG.slice(-40) };
          this.logouts = [this.lastLogout, ...(this.logouts || [])].slice(0, 20);
          try { fs.writeFileSync(path.join(this.dataDir, 'last-logout'), JSON.stringify(this.lastLogout)); } catch {}
          try { fs.writeFileSync(path.join(this.dataDir, 'logouts.json'), JSON.stringify(this.logouts)); } catch {}
          this.me = null;
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.groups.clear();
          this.later(2000);
          return;
        }
        // Waiting to be linked: the QR / code ran out (408). Start again right away so a fresh QR is on screen –
        // backing off here hid the QR for up to a minute at a time. A pairing code is not renewed by itself.
        if (!state.creds?.me?.id) { // never linked yet (after a QR link `registered` can stay false, `me` is set)
          if (this.pairCode) {
            this.pairPhone = null;
            this.pairCode = null;
            this.pairError = 'הקוד פג תוקף. בקש קוד חדש.';
          }
          this.pairAsked = false;
          this.state = 'qr';
          // Renew the QR only while someone has the app open. Renewing it all night long (a new
          // unlinked session every ~3 minutes) is useless and is unusual traffic for the number's IP.
          if (Date.now() - (this.viewedAt || 0) < 3 * 60_000 || this.pairPhone) {
            log('waiting for link, new QR', code);
            this.later(1000);
          } else {
            this.qr = null;
            this.idle = true;
            log('waiting for link – QR paused until the app is opened');
          }
          return;
        }
        this.state = 'connecting';
        this.retry += 1;
        const wait = Math.min(60_000, 2000 * 2 ** Math.min(this.retry, 5));
        log('arm closed', code, 'reconnect in', wait);
        this.later(wait);
      }
    });

    // keep the group list fresh without re-downloading everything
    sock.ev.on('groups.update', (list) => {
      for (const g of list || []) {
        const cur = this.groups.get(g.id);
        if (cur && g.subject) cur.name = g.subject;
      }
    });
    sock.ev.on('group-participants.update', (ev) => this.applyParticipantEvent(ev));
  }

  applyParticipantEvent({ id, participants, action }) {
    const g = this.groups.get(id);
    if (!g) {
      // the arm was added to a new group
      if (action === 'add') this.refreshGroups().catch(() => {});
      return;
    }
    const ids = (participants || []).map((p) => bareJid(typeof p === 'string' ? p : p?.id));
    if (action === 'remove') {
      g.participants = g.participants.filter((p) => !ids.some((x) => p.ids.has(x)));
      if (ids.some((x) => this.isMe(x))) this.groups.delete(id);
    } else if (action === 'add') {
      for (const x of ids) if (!g.participants.some((p) => p.ids.has(x))) g.participants.push({ ids: new Set([x]), admin: null });
    } else if (action === 'promote' || action === 'demote') {
      for (const p of g.participants) if (ids.some((x) => p.ids.has(x))) p.admin = action === 'promote' ? 'admin' : null;
    }
  }

  isMe(id) {
    return !!this.me && (id === this.me.pn || id === this.me.lid);
  }

  iAmAdmin(g) {
    return g.participants.some((p) => p.admin && [...p.ids].some((x) => this.isMe(x)));
  }

  /** All the arm's groups, for building saved lists. */
  allGroups() {
    return [...this.groups.values()].map((g) => ({ id: g.id, name: g.name, size: g.participants.length, iAmAdmin: this.iAmAdmin(g) })).sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  /** Re-read every group the arm is in (one WhatsApp request). */
  refreshGroups() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (this.state !== 'online') throw new Error('הזרוע לא מחוברת');
      const all = await this.sock.groupFetchAllParticipating();
      const next = new Map();
      for (const g of Object.values(all || {})) {
        next.set(g.id, {
          id: g.id,
          name: g.subject || g.id,
          addressingMode: g.addressingMode || null,
          participants: (g.participants || []).map((p) => ({ ids: participantIds(p), admin: p.admin || null })),
        });
      }
      this.groups = next;
      this.groupsAt = new Date().toISOString();
      log('groups loaded', next.size);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Every id WhatsApp might use for this number in groups: phone jid and, if known, its lid. */
  async idsFor(intl) {
    const pn = `${intl}@s.whatsapp.net`;
    const ids = new Set([pn]);
    let exists = null;
    try {
      const [r] = (await this.sock.onWhatsApp(pn)) || [];
      if (r) {
        exists = !!r.exists;
        if (r.jid) ids.add(bareJid(r.jid));
        if (r.lid) ids.add(bareJid(r.lid));
      } else exists = false;
    } catch {}
    // lid learned from a group where both ids appear on the same participant
    for (const g of this.groups.values()) {
      for (const p of g.participants) if (p.ids.has(pn)) for (const x of p.ids) ids.add(x);
    }
    return { pn, ids, exists };
  }

  /** Split all the arm's groups into: the number is in it / not in it. */
  async lookup(raw) {
    const intl = toIntl(raw);
    if (!intl) throw new Error('מספר לא תקין');
    if (this.state !== 'online') throw new Error('הזרוע לא מחוברת');
    if (!this.groupsAt) await this.refreshGroups();
    const { ids, exists } = await this.idsFor(intl);
    const inGroups = [];
    const notIn = [];
    for (const g of this.groups.values()) {
      const row = { id: g.id, name: g.name, size: g.participants.length, iAmAdmin: this.iAmAdmin(g) };
      const m = g.participants.find((p) => [...p.ids].some((x) => ids.has(x)));
      if (m) inGroups.push({ ...row, memberId: [...m.ids].find((x) => ids.has(x)), memberAdmin: !!m.admin });
      else notIn.push(row);
    }
    const byName = (a, b) => a.name.localeCompare(b.name, 'he');
    return { number: intl, onWhatsApp: exists, inGroups: inGroups.sort(byName), notIn: notIn.sort(byName) };
  }

  /** remove / add / promote one number in one group. Returns { ok, code, message }. */
  async change(action, groupId, intl) {
    if (this.state !== 'online') return { ok: false, code: 'offline', message: 'הזרוע לא מחוברת' };
    const g = this.groups.get(groupId);
    if (!g) return { ok: false, code: 'nogroup', message: 'הזרוע כבר לא בקבוצה' };
    if (!this.iAmAdmin(g)) return { ok: false, code: 'notadmin', message: 'הזרוע לא מנהלת בקבוצה' };
    let target = `${intl}@s.whatsapp.net`;
    if (action === 'remove' || action === 'promote' || action === 'demote') {
      const { ids } = await this.idsFor(intl);
      const m = g.participants.find((p) => [...p.ids].some((x) => ids.has(x)));
      if (!m && action === 'remove') return { ok: true, code: 'absent', message: 'כבר לא בקבוצה' };
      if (!m && action !== 'remove') return { ok: false, code: 'absent', message: 'המספר לא נמצא בקבוצה' };
      if (m && action === 'promote' && m.admin) return { ok: true, code: 'already', message: 'כבר מנהל' };
      if (m && action === 'demote' && !m.admin) return { ok: true, code: 'already', message: 'כבר לא מנהל' };
      if (m && action === 'demote' && m.admin === 'superadmin') return { ok: false, code: 'owner', message: 'זה יוצר הקבוצה – אי אפשר להוריד לו ניהול' };
      // use the id the group itself knows the member by – in groups that address members by LID, the LID
      if (m) {
        const known = [...m.ids].filter((x) => ids.has(x));
        const lid = known.find((x) => x.endsWith('@lid'));
        target = (g.addressingMode === 'lid' && lid) || known.find((x) => x.endsWith('@s.whatsapp.net')) || known[0];
        this._altTarget = known.find((x) => x !== target) || [...m.ids].find((x) => x !== target) || null;
      }
    }
    try {
      let [r] = (await this.sock.groupParticipantsUpdate(groupId, [target], action)) || [];
      // 404 = WhatsApp didn't find the member by that id: try the member's other id (phone ↔ LID) once
      if (String(r?.status) === '404' && action !== 'add' && this._altTarget) {
        target = this._altTarget;
        [r] = (await this.sock.groupParticipantsUpdate(groupId, [target], action)) || [];
      }
      this._altTarget = null;
      const status = String(r?.status ?? '200');
      log('group action', action, g.name, '→', status);
      this.lastAction = { at: new Date().toISOString(), action, group: g.name, status };
      if (status === '200') {
        this.applyParticipantEvent({ id: groupId, participants: [target], action });
        return { ok: true, code: status, message: { remove: 'הוסר', add: 'צורף', promote: 'הוגדר כמנהל', demote: 'הוסר מניהול' }[action] };
      }
      if (action === 'add' && status === '409') return { ok: true, code: status, message: 'כבר בקבוצה' };
      return { ok: false, code: status, message: explain(status, action) };
    } catch (e) {
      const msg = String(e?.message || '');
      log('group action failed', action, g.name, '→', msg, String(e?.output?.statusCode || ''));
      this.lastAction = { at: new Date().toISOString(), action, group: g.name, status: msg.slice(0, 80) };
      const code = e?.output?.statusCode || e?.data;
      // WhatsApp is limiting this number's group actions for a while – the job runner waits and retries
      if (/rate-overlimit/i.test(msg) || String(code) === '429') return { ok: false, code: 'rate', message: 'וואטסאפ הגביל זמנית את קצב הפעולות' };
      if (/not-authorized|forbidden/i.test(msg)) return { ok: false, code: '401', message: 'אין הרשאה – הזרוע לא מנהלת' };
      if (/timed? ?out/i.test(msg)) return { ok: false, code: 'timeout', message: 'וואטסאפ לא ענה בזמן' };
      return { ok: false, code: 'error', message: msg || 'שגיאה' };
    }
  }

  async logout() {
    try {
      await this.sock?.logout();
    } catch {}
  }
}

function explain(status, action) {
  const m = {
    401: 'אין הרשאה – הזרוע לא מנהלת',
    403: action === 'add' ? 'הגדרות הפרטיות של המספר חוסמות צירוף – צריך לשלוח לו קישור הזמנה' : 'אין הרשאה',
    404: action === 'add' ? 'המספר לא קיים בוואטסאפ' : 'וואטסאפ לא מצא את המספר בקבוצה',
    406: 'לא ניתן לצרף – המספר יצא מהקבוצה לאחרונה או נחסם',
    408: 'המספר יצא מהקבוצה לאחרונה – וואטסאפ לא מאפשר לצרף אותו שוב כרגע',
    409: action === 'add' ? 'כבר בקבוצה' : 'התנגשות',
    500: 'הקבוצה מלאה',
    429: 'וואטסאפ הגביל זמנית את קצב הפעולות',
  };
  return m[status] || `וואטסאפ סירב (${status})`;
}

module.exports = { Arm, participantIds, LOG };
