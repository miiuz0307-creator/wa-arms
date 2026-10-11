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
    const { version } = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('version lookup timeout')), 5000)),
    ]);
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
    if (quoted && /עזרה|הפצה|לפרסם|ביטול|בטל|נמכר|^\s*נ+\s*$/.test(text)) {
      // lagSec = how long after it was written the arm got it
      const lagSec = m.messageTimestamp ? Math.round(Date.now() / 1000 - Number(m.messageTimestamp)) : null;
      log.info(
        { arm: this.name, type, group: jid.endsWith('@g.us'), fromMe: !!m.key?.fromMe, quoted, text: text.slice(0, 40), sender: m.key?.participant, lagSec },
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
      auth: { creds: state.creds, keys: (this.signalKeys = makeCacheableSignalKeyStore(state.keys, waLogger)) },
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

    // "Retry" receipts (a member couldn't decrypt one of our messages) are handled by Baileys in the
    // same one-at-a-time queue as incoming messages, and each one waits on network calls. During a
    // distribution hundreds arrive, so an operator's "נ" waited ~20s behind them. While this arm is
    // sending, park retry receipts and hand them to Baileys once the sending pauses.
    const baileysReceipt = sock.ws.listeners('CB:receipt');
    if (baileysReceipt.length) {
      sock.ws.removeAllListeners('CB:receipt');
      const pass = (node) => {
        for (const fn of baileysReceipt) {
          try {
            fn(node);
          } catch (e) {
            log.warn({ arm: this.name, err: e.message }, 'receipt handler failed');
          }
        }
      };
      // Group "retry" receipts: after a distribution they arrive by the thousand, and Baileys handles each
      // one (with network calls) in the same queue as incoming messages – "עזרה"/"נ" then waited minutes.
      // Baileys can't re-send the message anyway (we keep no copies), so handle them here instantly:
      // acknowledge, and mark the group so the next message hands the encryption key to everyone again.
      const resetKeyAt = new Map();
      sock.ws.on('CB:receipt', (node) => {
        const a = node?.attrs || {};
        if (a.type === 'retry' && String(a.from || '').endsWith('@g.us')) {
          const ack = { tag: 'ack', attrs: { id: a.id, to: a.from, class: 'receipt', type: 'retry' } };
          if (a.participant) ack.attrs.participant = a.participant;
          if (a.recipient) ack.attrs.recipient = a.recipient;
          Promise.resolve(sock.sendNode?.(ack)).catch(() => {});
          if (Date.now() - (resetKeyAt.get(a.from) || 0) > 60_000) {
            resetKeyAt.set(a.from, Date.now());
            Promise.resolve(this.signalKeys?.set({ 'sender-key-memory': { [a.from]: null } })).catch(() => {});
          }
          return;
        }
        pass(node);
      });
    } else {
      log.warn({ arm: this.name }, 'could not find Baileys receipt handler – retry receipts handled by Baileys');
    }
    log.info({ arm: this.name }, 'connecting');
    // A socket that neither opens nor closes would leave the arm stuck on "connecting" forever
    clearTimeout(this.connectGuard);
    this.connectGuard = setTimeout(() => {
      if (this.sock !== sock || this.online) return;
      log.warn({ arm: this.name }, 'still not connected after 90s – retrying');
      try {
        sock.end(new Error('connect stuck'));
      } catch {}
      // if the socket doesn't report the close, restart it ourselves
      setTimeout(() => {
        if (this.sock !== sock || this.online) return;
        this.sock = null;
        this.stopped = true;
        this.scheduleReconnect();
      }, 10_000);
    }, 90_000);
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
    this.gotMessage = false;
    this.lastRawAt = Date.now();
    // diagnostics: "retry" receipts = members asking us to re-send a message they couldn't decrypt.
    // Baileys handles them in the same queue as incoming messages, so many of them delay reading.
    this.retryReceipts = 0;
    sock.ws.on('CB:receipt', (node) => {
      if (node?.attrs?.type === 'retry') this.retryReceipts += 1;
    });
    sock.ws.on('CB:message', () => {
      this.raw += 1;
      this.gotMessage = true;
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
      if (sock.user?.id) this.markOnline(sock, 'caught up').catch(() => {});
    });

    // Watchdog: in 90 busy groups silence means WhatsApp stopped delivering to this socket
    // (it happens after reconnects). Reconnecting makes it deliver again.
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.sock !== sock) return clearInterval(this.watchdog);
      if (!this.online) {
        // logged in and receiving, but Baileys never said 'open'
        if (sock.user?.id && this.gotMessage && Date.now() - this.lastRawAt < 60_000) this.markOnline(sock, 'messages flowing').catch(() => {});
        return;
      }
      const quiet = Date.now() - Math.max(this.lastRawAt || 0, this.onlineAt || 0);
      if (quiet > 150_000 && !this.pinging) {
        // quiet groups are normal – only reconnect if WhatsApp doesn't answer a ping
        this.pinging = true;
        this.lastRawAt = Date.now();
        Promise.race([
          sock.query({ tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:p', id: sock.generateMessageTag() }, content: [{ tag: 'ping', attrs: {} }] }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 20_000)),
        ])
          .then(() => log.info({ arm: this.name, quietSec: Math.round(quiet / 1000) }, 'quiet but connection alive'))
          .catch((e) => {
            if (this.sock !== sock) return;
            log.warn({ arm: this.name, err: e.message }, 'no answer from WhatsApp – reconnecting');
            try {
              sock.end(new Error('incoming stalled'));
            } catch {}
          })
          .finally(() => (this.pinging = false));
      }
    }, 30_000);
    if (!this.rawTimer) {
      this.rawTimer = setInterval(() => {
        if (this.raw || this.upserts) log.info({ arm: this.name, rawMessages: this.raw, upsertEvents: this.upserts, retryReceipts: this.retryReceipts || 0 }, 'socket traffic (last minute)');
        this.retryReceipts = 0;
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

  // Called on 'open', and as a fallback once messages are flowing: Baileys sometimes
  // never emits 'open' even though the socket is logged in and working.
  async markOnline(sock, why) {
    if (sock !== this.sock || this.online || this.markingOnline) return;
    this.markingOnline = true;
    try {
      this.online = true;
      this.retry = 0;
      this.onlineAt = Date.now();
      const phone = formatPhone(jidUser(sock.user?.id));
      log.info({ arm: this.name, phone, why }, 'arm online');
      db.from('arm_qr').delete().eq('arm_id', this.id).then(() => {}, () => {});
      await this.update({
        status: 'online',
        phone,
        last_connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_error: null,
      });
      this.syncGroups().catch((e) => log.error({ arm: this.name, err: e.message }, 'group sync failed'));
    } finally {
      this.markingOnline = false;
    }
  }

  async onConnectionUpdate(sock, u) {
    if (sock !== this.sock) return; // stale socket

    if (u.qr) {
      await db.from('arm_qr').upsert({ arm_id: this.id, qr: u.qr, updated_at: new Date().toISOString() });
      await this.update({ status: 'qr', last_error: null });
    }

    if (u.connection === 'open') await this.markOnline(sock, 'open');

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
    const wait = Math.max(0, 10 * 60_000 - (Date.now() - (this.lastGroupSync || 0)));
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

    // WhatsApp sometimes returns a group without its details (name, members). Ask for those
    // groups one by one, and otherwise keep the name we already had instead of showing a number.
    // Ask for the details one by one only for groups we have no name for at all, a few at a time and
    // not more than every half hour per group – asking for many in a row trips WhatsApp's rate limit.
    const nameKnown = (id) => {
      const v = this.savedGroups?.get(id);
      return v && !v.startsWith(id + '|');
    };
    this.metaTried = this.metaTried || new Map();
    const missing = groups.filter((g) => !g.subject && !nameKnown(g.id) && Date.now() - (this.metaTried.get(g.id) || 0) > 30 * 60_000);
    for (const g of missing.slice(0, 10)) {
      this.metaTried.set(g.id, Date.now());
      try {
        const meta = await Promise.race([this.sock.groupMetadata(g.id), new Promise((r) => setTimeout(() => r(null), 8000))]);
        if (meta?.subject) {
          Object.assign(g, meta);
          this.groupMeta.set(g.id, meta);
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    const stillMissing = groups.filter((g) => !g.subject).map((g) => g.id);
    const known = new Map();
    if (stillMissing.length) {
      const { data } = await db.from('groups').select('wa_group_id,name,participants').eq('arm_id', this.id).in('wa_group_id', stillMissing);
      for (const r of data || []) if (r.name && r.name !== r.wa_group_id) known.set(r.wa_group_id, r);
    }
    const rows = groups.map((g) => ({
      arm_id: this.id,
      wa_group_id: g.id,
      name: g.subject || known.get(g.id)?.name || g.id,
      participants: g.participants?.length || known.get(g.id)?.participants || null,
      updated_at: now,
    }));
    if (stillMissing.length) log.info({ arm: this.name, withoutDetails: stillMissing.length, keptName: known.size }, 'groups without details from WhatsApp');
    // Only write what changed (a full rewrite every couple of minutes was needless database load)
    if (!this.savedGroups) {
      const { data, error } = await db.from('groups').select('wa_group_id,name,participants').eq('arm_id', this.id);
      if (error) throw error;
      this.savedGroups = new Map((data || []).map((r) => [r.wa_group_id, `${r.name}|${r.participants}`]));
    }
    const changed = rows.filter((r) => this.savedGroups.get(r.wa_group_id) !== `${r.name}|${r.participants}`);
    for (let i = 0; i < changed.length; i += 500) {
      const { error } = await db.from('groups').upsert(changed.slice(i, i + 500), { onConflict: 'arm_id,wa_group_id' });
      if (error) {
        this.savedGroups = null;
        throw error;
      }
    }
    for (const r of changed) this.savedGroups.set(r.wa_group_id, `${r.name}|${r.participants}`);
    // remove groups the arm has left (only when WhatsApp returned a list at all)
    const current = new Set(rows.map((r) => r.wa_group_id));
    const gone = rows.length ? [...this.savedGroups.keys()].filter((id) => !current.has(id)) : [];
    for (let i = 0; i < gone.length; i += 100) {
      const { error } = await db.from('groups').delete().eq('arm_id', this.id).in('wa_group_id', gone.slice(i, i + 100));
      if (!error) gone.slice(i, i + 100).forEach((id) => this.savedGroups.delete(id));
    }
    if (changed.length || gone.length) log.info({ arm: this.name, changed: changed.length, removed: gone.length }, 'groups changed');
    log.info({ arm: this.name, groups: rows.length }, 'groups synced');
  }

  /**
   * React to a message with an emoji ('' removes the reaction).
   * In groups the sender may be addressed by hidden ID (LID) or by phone; WhatsApp only shows the
   * reaction when the key matches how the message was stored, so we send it for every known form.
   */
  async react(key, emoji) {
    if (!this.sock || !this.online || !key?.remoteJid || !key?.id) return false;
    // Only the key exactly as the message arrived. (A second copy addressed to the phone-number form of
    // the sender replaced the first one in LID groups, so no reaction showed at all.)
    const variants = [key];
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
    this.lastSendAt = Date.now();
    const sent = await Promise.race([
      this.sock.sendMessage(jid, { text }),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('Timed Out (שליחה לא הסתיימה תוך 45 שניות)')), 45_000);
      }),
    ]).finally(() => clearTimeout(timer));
    this.rememberSent(sent?.key?.id);
    this.lastSendAt = Date.now();
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
