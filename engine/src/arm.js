// One WhatsApp "arm": its own socket, its own session, its own failures.
const baileys = require('@whiskeysockets/baileys');
const { db, log, waLogger, SESSION_SECRET } = require('./config');
const { useDbAuthState } = require('./authState');
const { jidUser, formatPhone } = require('./util');

const makeWASocket = baileys.default || baileys.makeWASocket;

// Who-has-which-devices cache. Baileys' default forgets it after 5 minutes, so every
// distribution re-asked WhatsApp about hundreds of members per group (slow, and it stalls sends).
function longCache(ttlMs = 12 * 60 * 60 * 1000) {
  const m = new Map();
  const live = (k) => {
    const e = m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      m.delete(k);
      return undefined;
    }
    return e.v;
  };
  return {
    get: (k) => live(k),
    set: (k, v) => (m.set(k, { v, exp: Date.now() + ttlMs }), true),
    mget: (ks) => Object.fromEntries(ks.map((k) => [k, live(k)]).filter(([, v]) => v !== undefined)),
    mset: (list) => (list.forEach(({ key, val }) => m.set(key, { v: val, exp: Date.now() + ttlMs })), true),
    del: (k) => (Array.isArray(k) ? k.forEach((x) => m.delete(x)) : m.delete(k), true),
    take: (k) => {
      const v = live(k);
      m.delete(k);
      return v;
    },
    has: (k) => live(k) !== undefined,
    keys: () => [...m.keys()],
    flushAll: () => m.clear(),
  };
}
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
    this.stationId = row.station_id;
    this.onMessage = onMessage;
    this.sock = null;
    this.auth = null;
    this.online = false;
    this.stopped = true;
    this.retry = 0;
    this.reconnectTimer = null;
    this.nextSendAt = 0;
    this.busy = false;
    this.sentIds = new Set(); // ids of messages the bot itself sent (never treat as commands)
  }

  // diagnostics: one summary line per minute of everything the arm receives
  stat(type, messages) {
    const st = (this.stats = this.stats || { events: 0, byType: {}, groups: 0, dms: 0, stub: 0, text: 0, samples: [] });
    st.events += 1;
    st.byType[type] = (st.byType[type] || 0) + messages.length;
    for (const m of messages) {
      const jid = m.key?.remoteJid || '';
      if (jid.endsWith('@g.us')) st.groups += 1;
      else st.dms += 1;
      if (!m.message) st.stub += 1;
      else {
        st.text += 1;
        if (st.samples.length < 3) st.samples.push(Object.keys(m.message).join(','));
      }
    }
    if (!this.statTimer) {
      this.statTimer = setTimeout(() => {
        log.info({ arm: this.name, ...this.stats }, 'received in the last minute');
        this.stats = null;
        this.statTimer = null;
      }, 60_000);
    }
  }

  // diagnostics: count undecryptable messages, log anything that looks like a help request
  trace(m, type) {
    const jid = m.key?.remoteJid || '';
    if (!m.message && m.messageStubType) {
      this.undecrypted = (this.undecrypted || 0) + 1;
      if (this.undecrypted <= 2) {
        log.info(
          { arm: this.name, group: jid.endsWith('@g.us'), stub: m.messageStubType, params: m.messageStubParameters, sender: m.key?.participant },
          'undecryptable message sample',
        );
      }
      if (!this.undecryptedTimer) {
        this.undecryptedTimer = setTimeout(() => {
          log.warn({ arm: this.name, count: this.undecrypted }, 'messages that could not be decrypted (last minute)');
          this.undecrypted = 0;
          this.undecryptedTimer = null;
        }, 60_000);
      }
      return;
    }
    const msg = m.message?.ephemeralMessage?.message || m.message || {};
    const text = msg.conversation || msg.extendedTextMessage?.text || '';
    const quoted = !!msg.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted && /עזרה|הפצה|לפרסם/.test(text)) {
      log.info(
        { arm: this.name, type, group: jid.endsWith('@g.us'), fromMe: !!m.key?.fromMe, quoted, text: text.slice(0, 40), sender: m.key?.participant },
        'incoming candidate',
      );
    }
  }

  rememberSent(id) {
    if (!id) return;
    this.sentIds.add(id);
    if (this.sentIds.size > 2000) this.sentIds.delete(this.sentIds.values().next().value);
  }

  isOwnSent(id) {
    return this.sentIds.has(id);
  }

  /** The arm's own WhatsApp identities (phone JID and LID), without device suffix. */
  ownJids() {
    const norm = (j) => (j ? String(j).replace(/:\d+(?=@)/, '') : null);
    return [this.sock?.user?.id, this.sock?.user?.lid, this.creds?.me?.id, this.creds?.me?.lid, this.learnedLid]
      .map(norm)
      .filter(Boolean);
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
      this.stopped = true; // so the scheduled retry really starts again
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
      // We never need old chat history. Waiting for it (and the app-state sync after it)
      // can leave Baileys buffering every new message forever, so skip it entirely.
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      // answer group-metadata lookups from memory instead of asking WhatsApp every time
      cachedGroupMetadata: async (jid) => this.groupMeta?.get(jid),
      userDevicesCache: (this.devCache = this.devCache || longCache()),
    });
    this.sock = sock;
    await this.update({ status: 'connecting' });

    sock.ev.on('creds.update', saveCreds);

    // Baileys 6.7.24: once its event buffer is switched on during message processing,
    // nothing switches it off again, so new messages are never emitted. Release it ourselves.
    clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      if (this.sock !== sock) return clearInterval(this.flushTimer);
      try {
        if (sock.ev.isBuffering?.()) sock.ev.flush();
      } catch {}
    }, 100);

    // WhatsApp can accept a message on the socket and reject it afterwards – log those
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates || []) {
        if (u.update?.status === 0 && this.sentIds?.has?.(u.key?.id)) {
          log.warn({ arm: this.name, id: u.key?.id, jid: u.key?.remoteJid, err: u.update?.messageStubParameters }, 'WhatsApp rejected a sent message');
        }
      }
    });


    // diagnostics: raw message nodes reaching the socket vs. events emitted
    this.raw = 0;
    this.upserts = 0;
    this.lastRawAt = Date.now();
    sock.ws.on('CB:message', () => {
      this.raw += 1;
      this.lastRawAt = Date.now();
    });
    // Messages that piled up while the arm was away arrive in batches, and WhatsApp sends the next
    // batch only when asked. Baileys asks once, so after ~100 messages delivery stopped and new
    // messages (like "עזרה") waited behind the backlog. Keep asking until WhatsApp says it's done.
    this.offlineDone = false;
    clearInterval(this.batchPump);
    const askBatch = () =>
      Promise.resolve(sock.sendNode?.({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] })).catch(() => {});
    sock.ws.on('CB:ib,,offline_preview', () => {
      this.offlineDone = false;
      clearInterval(this.batchPump);
      this.batchPump = setInterval(() => {
        if (this.sock !== sock || this.offlineDone) return clearInterval(this.batchPump);
        askBatch();
      }, 1500);
    });
    sock.ws.on('CB:ib,,offline', () => {
      this.offlineDone = true;
      clearInterval(this.batchPump);
      log.info({ arm: this.name }, 'caught up with messages from while offline – now live');
    });

    // Watchdog: in 90 busy groups silence means WhatsApp stopped delivering to this socket
    // (it happens after reconnects). Reconnecting makes it deliver again.
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.sock !== sock) return clearInterval(this.watchdog);
      if (!this.online) return;
      const quiet = Date.now() - Math.max(this.lastRawAt || 0, this.onlineAt || 0);
      if (quiet > 150_000) {
        log.warn({ arm: this.name, quietSec: Math.round(quiet / 1000) }, 'no incoming messages – reconnecting to unblock');
        this.lastRawAt = Date.now();
        try {
          sock.end(new Error('incoming stalled'));
        } catch {}
      }
    }, 30_000);
    if (!this.rawTimer) {
      this.rawTimer = setInterval(() => {
        if (this.raw || this.upserts) log.info({ arm: this.name, rawMessages: this.raw, upsertEvents: this.upserts }, 'socket traffic (last minute)');
        this.raw = 0;
        this.upserts = 0;
      }, 60_000);
    }

    sock.ev.on('connection.update', (u) => {
      this.onConnectionUpdate(sock, u).catch((e) =>
        log.error({ arm: this.name, err: e.message }, 'connection.update handler failed'),
      );
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this.upserts += 1;
      this.stat(type, messages);
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) {
        this.trace(m, type);
        this.clearStuck(sock, m, type);
        // learn our own LID from our own group messages
        if (m.key?.fromMe && m.key?.participant?.endsWith('@lid')) this.learnedLid = m.key.participant.replace(/:\d+(?=@)/, '');
        this.onMessage(this, m, type).catch((e) =>
          log.error({ arm: this.name, err: e.message }, 'message handler failed'),
        );
      }
    });

    // group changes arrive in bursts – refresh the list at most once every 2 minutes
    sock.ev.on('groups.upsert', () => this.scheduleGroupSync());
    sock.ev.on('groups.update', () => this.scheduleGroupSync());
  }

  // A message we can't decrypt is redelivered by WhatsApp again and again (every minute), and the
  // messages queued behind it — including new "עזרה" requests — never arrive. After it has come back
  // once, confirm it as delivered so WhatsApp moves on (its content is lost either way).
  clearStuck(sock, m, type) {
    if (m.message || m.messageStubType !== 2 || !m.key?.id) return;
    this.stuckSeen = this.stuckSeen || new Map();
    const n = (this.stuckSeen.get(m.key.id) || 0) + 1;
    this.stuckSeen.set(m.key.id, n);
    if (this.stuckSeen.size > 5000) this.stuckSeen.delete(this.stuckSeen.keys().next().value);
    if (n < 2 && type !== 'append') return; // offline backlog: confirm right away, WhatsApp waits for it
    this.clearedStuck = (this.clearedStuck || 0) + 1;
    if (typeof sock.sendReceipt !== 'function') {
      if (!this.noReceiptWarned) log.warn({ arm: this.name }, 'sendReceipt not available');
      this.noReceiptWarned = true;
      return;
    }
    sock.sendReceipt(m.key.remoteJid, m.key.participant, [m.key.id], undefined).catch((e) =>
      log.warn({ arm: this.name, err: e?.message }, 'confirm stuck message failed'),
    );
    if (this.clearedStuck % 20 === 1) log.info({ arm: this.name, cleared: this.clearedStuck }, 'confirmed undecryptable messages so the queue moves on');
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
      this.onlineAt = Date.now();
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

  scheduleGroupSync() {
    if (this.groupSyncTimer) return;
    const wait = Math.max(0, 120_000 - (Date.now() - (this.lastGroupSync || 0)));
    this.groupSyncTimer = setTimeout(() => {
      this.groupSyncTimer = null;
      this.syncGroups().catch((e) => log.warn({ arm: this.name, err: e.message }, 'group sync failed'));
    }, wait);
  }

  async syncGroups() {
    this.lastGroupSync = Date.now();
    if (!this.sock || !this.online) return;
    const all = await this.sock.groupFetchAllParticipating();
    this.groupMeta = new Map(Object.entries(all));
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

  /**
   * React to a message with an emoji ('' removes the reaction).
   * In groups the sender may be addressed by hidden ID (LID) or by phone; WhatsApp only shows the
   * reaction when the key matches how the message was stored, so we send it for every known form.
   */
  async react(key, emoji) {
    if (!this.sock || !this.online || !key?.remoteJid || !key?.id) return false;
    const variants = [key];
    if (key.participantPn && key.participantPn !== key.participant) {
      variants.push({ ...key, participant: key.participantPn });
    }
    let ok = false;
    for (const k of variants) {
      const clean = { remoteJid: k.remoteJid, id: k.id, fromMe: !!k.fromMe, ...(k.participant ? { participant: k.participant } : {}) };
      try {
        const sent = await this.sock.sendMessage(clean.remoteJid, { react: { text: emoji, key: clean } });
        this.rememberSent(sent?.key?.id);
        ok = true;
      } catch (e) {
        log.warn({ arm: this.name, err: e.message }, 'reaction failed');
      }
    }
    return ok;
  }

  async send(jid, text) {
    if (!this.sock || !this.online) throw new Error('הזרוע לא מחוברת');
    const t0 = Date.now();
    let timer;
    const sent = await Promise.race([
      this.sock.sendMessage(jid, { text }),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('Timed Out (שליחה לא הסתיימה תוך 45 שניות)')), 45_000);
      }),
    ]).finally(() => clearTimeout(timer));
    this.rememberSent(sent?.key?.id);
    const ms = Date.now() - t0;
    if (ms > 8000) log.warn({ arm: this.name, jid, ms }, 'slow send');
    return sent;
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
