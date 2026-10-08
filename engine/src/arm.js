// One WhatsApp "arm": its own socket, its own session, its own failures.
const baileys = require('@whiskeysockets/baileys');
const { db, log, waLogger, SESSION_SECRET } = require('./config');
const { useDbAuthState } = require('./authState');
const { jidUser, formatPhone } = require('./util');

const makeWASocket = baileys.default || baileys.makeWASocket;
const { DisconnectReason, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = baileys;

let cachedVersion = null;
async function waVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
  } catch {
    cachedVersion = undefined;
  }
  return cachedVersion;
}

class Arm {
  constructor(row, onMessage) {
    this.id = row.id;
    this.name = row.name;
    this.onMessage = onMessage;
    this.sock = null;
    this.auth = null;
    this.online = false;
    this.stopped = true;
    this.retry = 0;
    this.reconnectTimer = null;
    this.nextSendAt = 0;
    this.busy = false;
  }

  async update(fields) {
    const { error } = await db.from('arms').update(fields).eq('id', this.id);
    if (error) log.error({ arm: this.name, err: error.message }, 'arm update failed');
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    try {
      await this.connect();
    } catch (e) {
      log.error({ arm: this.name, err: e.message }, 'arm start failed');
      await this.update({ status: 'error', last_error: e.message });
      this.scheduleReconnect();
    }
  }

  async connect() {
    const { state, saveCreds, flush, clear } = await useDbAuthState(this.id, SESSION_SECRET);
    this.auth = { flush, clear };
    this.creds = state.creds;

    const sock = makeWASocket({
      version: await waVersion(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
      logger: waLogger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    await this.update({ status: 'connecting' });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      this.onConnectionUpdate(sock, u).catch((e) =>
        log.error({ arm: this.name, err: e.message }, 'connection.update handler failed'),
      );
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        this.onMessage(this, m).catch((e) =>
          log.error({ arm: this.name, err: e.message }, 'message handler failed'),
        );
      }
    });

    sock.ev.on('groups.upsert', () => this.syncGroups().catch(() => {}));
    sock.ev.on('groups.update', () => this.syncGroups().catch(() => {}));
  }

  async onConnectionUpdate(sock, u) {
    if (sock !== this.sock) return; // stale socket

    if (u.qr) {
      await db.from('arm_qr').upsert({ arm_id: this.id, qr: u.qr, updated_at: new Date().toISOString() });
      await this.update({ status: 'qr', last_error: null });
    }

    if (u.connection === 'open') {
      this.online = true;
      this.retry = 0;
      const phone = formatPhone(jidUser(sock.user?.id));
      await db.from('arm_qr').delete().eq('arm_id', this.id);
      await this.update({
        status: 'online',
        phone,
        last_connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_error: null,
      });
      log.info({ arm: this.name, phone }, 'arm online');
      await this.syncGroups().catch((e) => log.error({ arm: this.name, err: e.message }, 'group sync failed'));
    }

    if (u.connection === 'close') {
      this.online = false;
      this.sock = null;
      if (this.stopped) return;
      await this.auth?.flush().catch(() => {});
      const code = u.lastDisconnect?.error?.output?.statusCode;
      log.warn({ arm: this.name, code }, 'arm connection closed');

      if (code === DisconnectReason.restartRequired) {
        // normal right after scanning the QR
        this.stopped = true;
        return this.start();
      }
      if (code === DisconnectReason.loggedOut) {
        await this.auth?.clear();
        await db.from('arm_qr').delete().eq('arm_id', this.id);
        await this.update({ status: 'pending', last_error: 'החיבור נותק מהטלפון. לחץ "QR חדש" כדי לחבר שוב.' });
        this.stopped = true;
        return;
      }
      if (!this.creds?.me) {
        // QR expired without being scanned – wait for the user to ask for a new one
        await db.from('arm_qr').delete().eq('arm_id', this.id);
        await this.update({ status: 'pending', last_error: 'פג תוקף ה-QR. לחץ "QR חדש".' });
        this.stopped = true;
        return;
      }
      await this.update({ status: 'offline', last_error: `החיבור נפל (קוד ${code ?? 'לא ידוע'}), מתחבר מחדש` });
      this.stopped = true;
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(60_000, 2_000 * 2 ** this.retry);
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => this.start(), delay);
  }

  async syncGroups() {
    if (!this.sock || !this.online) return;
    const all = await this.sock.groupFetchAllParticipating();
    const groups = Object.values(all);
    const now = new Date().toISOString();
    const rows = groups.map((g) => ({
      arm_id: this.id,
      wa_group_id: g.id,
      name: g.subject || g.id,
      participants: g.participants?.length ?? null,
      updated_at: now,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from('groups').upsert(rows.slice(i, i + 500), { onConflict: 'arm_id,wa_group_id' });
      if (error) throw error;
    }
    // remove groups the arm has left
    let q = db.from('groups').delete().eq('arm_id', this.id);
    if (rows.length) q = q.lt('updated_at', now);
    await q;
    log.info({ arm: this.name, groups: rows.length }, 'groups synced');
  }

  async send(jid, text) {
    if (!this.sock || !this.online) throw new Error('הזרוע לא מחוברת');
    await this.sock.sendMessage(jid, { text });
  }

  // stop the socket but keep the session (can reconnect without QR)
  async stop() {
    this.stopped = true;
    this.online = false;
    clearTimeout(this.reconnectTimer);
    const s = this.sock;
    this.sock = null;
    try {
      s?.end(undefined);
    } catch {}
    await this.auth?.flush().catch(() => {});
  }

  // log out from WhatsApp, wipe session, and start fresh (new QR)
  async reset() {
    const s = this.sock;
    this.stopped = true;
    this.sock = null;
    clearTimeout(this.reconnectTimer);
    try {
      if (s && this.online) await s.logout();
    } catch {}
    try {
      s?.end(undefined);
    } catch {}
    this.online = false;
    if (this.auth) await this.auth.clear();
    else await db.from('arm_auth').delete().eq('arm_id', this.id);
    this.retry = 0;
    await this.update({ status: 'pending', phone: null, last_error: null });
    await this.start();
  }

  // arm deleted from the system: log out of WhatsApp too
  async destroy() {
    const s = this.sock;
    this.stopped = true;
    this.sock = null;
    clearTimeout(this.reconnectTimer);
    try {
      if (s && this.online) await s.logout();
    } catch {}
    try {
      s?.end(undefined);
    } catch {}
    this.online = false;
  }
}

module.exports = { Arm };
