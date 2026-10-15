// The one dedicated WhatsApp number ("arm") of this tool.
// Completely separate from BotiX: its own session folder, its own socket, no shared tables.
const fs = require('fs');
const path = require('path');
const { toIntl, bareJid, jidUser } = require('./phone');

const log = (...a) => console.log(new Date().toISOString(), ...a);

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
      wasLoggedOut: !!this.wasLoggedOut,
      lastPhone: this.lastPhone || null,
    };
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
    const { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = baileys;
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
      auth: state,
      version,
      logger: silent,
      browser: Browsers.ubuntu('Members'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      // this tool never reads messages
      shouldIgnoreJid: (jid) => !String(jid).endsWith('@g.us'),
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (sock !== this.sock) return;
      if (u.qr) {
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
        this.retry = 0;
        this.lastError = null;
        this.me = { pn: bareJid(sock.user?.id), lid: sock.user?.lid ? bareJid(sock.user.lid) : null };
        log('arm online', jidUser(this.me.pn));
        this.lastPhone = jidUser(this.me.pn);
        try { fs.writeFileSync(path.join(path.dirname(this.authDir), 'last-phone'), this.lastPhone); } catch {}
        this.refreshGroups().catch((e) => log('groups refresh failed', e.message));
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.lastError = u.lastDisconnect?.error?.message || String(code || '');
        if (code === DisconnectReason.loggedOut) {
          log('arm logged out – needs a new QR');
          this.state = 'logged_out';
          this.wasLoggedOut = true;
          this.me = null;
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.groups.clear();
          this.later(2000);
          return;
        }
        // Waiting to be linked: the QR / code ran out (408). Start again right away so a fresh QR is on screen –
        // backing off here hid the QR for up to a minute at a time. A pairing code is not renewed by itself.
        if (!state.creds?.registered) {
          if (this.pairCode) {
            this.pairPhone = null;
            this.pairCode = null;
            this.pairError = 'הקוד פג תוקף. בקש קוד חדש.';
          }
          this.pairAsked = false;
          this.state = 'qr';
          log('waiting for link, new QR', code);
          this.later(1000);
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
    if (action === 'remove' || action === 'promote') {
      const { ids } = await this.idsFor(intl);
      const m = g.participants.find((p) => [...p.ids].some((x) => ids.has(x)));
      if (!m && action === 'remove') return { ok: true, code: 'absent', message: 'כבר לא בקבוצה' };
      if (m && action === 'promote' && m.admin) return { ok: true, code: 'already', message: 'כבר מנהל' };
      // use the id the group itself knows the member by
      if (m) target = [...m.ids].find((x) => ids.has(x));
    }
    try {
      const [r] = (await this.sock.groupParticipantsUpdate(groupId, [target], action)) || [];
      const status = String(r?.status ?? '200');
      if (status === '200') {
        this.applyParticipantEvent({ id: groupId, participants: [target], action });
        return { ok: true, code: status, message: { remove: 'הוסר', add: 'צורף', promote: 'הוגדר כמנהל' }[action] };
      }
      if (action === 'add' && status === '409') return { ok: true, code: status, message: 'כבר בקבוצה' };
      return { ok: false, code: status, message: explain(status, action) };
    } catch (e) {
      return { ok: false, code: 'error', message: e?.message || 'שגיאה' };
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
    404: 'המספר לא קיים בוואטסאפ',
    406: 'לא ניתן לצרף – המספר יצא מהקבוצה לאחרונה או נחסם',
    408: 'המספר יצא מהקבוצה לאחרונה – וואטסאפ לא מאפשר לצרף אותו שוב כרגע',
    409: action === 'add' ? 'כבר בקבוצה' : 'התנגשות',
    500: 'הקבוצה מלאה',
  };
  return m[status] || `וואטסאפ סירב (${status})`;
}

module.exports = { Arm, participantIds };
