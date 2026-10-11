// WhatsApp connection by QR (Baileys – an unofficial WhatsApp Web client).
// The session is kept encrypted in our database, so a restart or a new server needs no new scan.
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const { encrypt, decrypt } = require('./secure');
const { senderOf, jidOf } = require('./phones');

const makeWASocket = baileys.default || baileys.makeWASocket;
const { DisconnectReason, Browsers, BufferJSON, initAuthCreds, proto } = baileys;
const quiet = pino({ level: 'silent' });
const MAX_IMAGE = 8 * 1024 * 1024;

async function useDbAuthState(store, secret) {
  const read = async (k) => {
    const v = await store.authGet(k);
    if (!v) return null;
    try {
      return JSON.parse(decrypt(secret, v), BufferJSON.reviver);
    } catch {
      return null; // wrong SESSION_SECRET or damaged row – treated as missing
    }
  };
  const write = (k, data) => store.authSet(k, encrypt(secret, JSON.stringify(data, BufferJSON.replacer)));
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(
            ids.map(async (id) => {
              let v = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
              out[id] = v;
            }),
          );
          return out;
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const v = data[type][id];
              const k = `${type}-${id}`;
              if (v) await write(k, v);
              else await store.authDel(k);
            }
          }
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

const textOf = (m = {}) =>
  m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.documentMessage?.caption || '';

function createWhatsApp({ store, secret, log, onMessage }) {
  let sock = null;
  let stopped = true;
  let reconnectTimer = null;
  let retries = 0;
  const status = { state: 'disconnected', qr: null, me: null, error: null, since: new Date().toISOString() };

  const set = (patch) => Object.assign(status, patch, { since: new Date().toISOString() });

  async function connect() {
    clearTimeout(reconnectTimer);
    if (sock) return status;
    stopped = false;
    set({ state: 'connecting', error: null });
    const { state, saveCreds } = await useDbAuthState(store, secret);
    const s = makeWASocket({
      auth: state,
      logger: quiet,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    sock = s;
    s.ev.on('creds.update', () => saveCreds().catch((e) => log.error({ err: e.message }, 'saving creds failed')));
    s.ev.on('connection.update', (u) => onUpdate(s, u, state).catch((e) => log.error({ err: e.message }, 'connection handler failed')));
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) handleIncoming(s, m).catch((e) => log.error({ err: e.message }, 'incoming message failed'));
    });
    return status;
  }

  async function onUpdate(s, u, state) {
    if (s !== sock) return;
    if (u.qr) set({ state: 'qr', qr: u.qr, error: null });
    if (u.connection === 'open') {
      retries = 0;
      const me = (s.user?.id || '').split(':')[0].split('@')[0];
      set({ state: 'connected', qr: null, me, error: null });
      log.info({ me }, 'WhatsApp connected');
    }
    if (u.connection !== 'close') return;
    sock = null;
    const code = u.lastDisconnect?.error?.output?.statusCode;
    log.warn({ code }, 'WhatsApp connection closed');
    if (stopped) return set({ state: 'disconnected', qr: null });
    if (code === DisconnectReason.restartRequired) return connect(); // normal right after scanning
    if (code === DisconnectReason.loggedOut) {
      await store.authClear();
      stopped = true;
      return set({ state: 'disconnected', qr: null, me: null, error: 'החיבור נותק מהטלפון. לחצו "חיבור WhatsApp" וסרקו שוב.' });
    }
    if (!state.creds?.me) {
      stopped = true;
      return set({ state: 'disconnected', qr: null, error: 'פג תוקף ה-QR. לחצו "חיבור WhatsApp" כדי לקבל חדש.' });
    }
    if (code === 403) {
      stopped = true;
      return set({ state: 'error', qr: null, error: 'וואטסאפ חסם או הגביל את המספר (קוד 403). בדקו בטלפון לפני חיבור מחדש.' });
    }
    if (code === DisconnectReason.connectionReplaced) {
      stopped = true;
      return set({ state: 'error', qr: null, error: 'המספר חובר במקום אחר (קוד 440). ודאו שהבוט לא רץ בשני שרתים.' });
    }
    retries++;
    const wait = Math.min(5000 * 2 ** Math.min(retries, 6), 5 * 60_000);
    set({ state: 'connecting', qr: null, error: `החיבור נפל (קוד ${code ?? 'לא ידוע'}). מתחבר מחדש…` });
    reconnectTimer = setTimeout(() => connect().catch(() => {}), wait);
  }

  async function handleIncoming(s, m) {
    const jid = m.key?.remoteJid || '';
    if (m.key?.fromMe || !m.message) return;
    // private chats only: ignore groups, status updates, channels and broadcasts
    if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
    const msg = m.message.ephemeralMessage?.message || m.message.viewOnceMessage?.message || m.message;
    const { phone, lid } = senderOf(m.key);
    let image = null;
    if (msg.imageMessage) {
      const size = Number(msg.imageMessage.fileLength || 0);
      const mimetype = msg.imageMessage.mimetype || 'image/jpeg';
      // downloaded only after the sender is checked (intake calls load())
      image = {
        mimetype,
        load: async () => {
          if (size > MAX_IMAGE) return { tooBig: true };
          try {
            const buf = await baileys.downloadMediaMessage({ ...m, message: msg }, 'buffer', {}, { logger: quiet, reuploadRequest: s.updateMediaMessage });
            if (!buf || buf.length > MAX_IMAGE) return { tooBig: true };
            return { buffer: buf, mimetype };
          } catch (e) {
            log.warn({ err: e.message }, 'image download failed');
            return { failed: true };
          }
        },
      };
    }
    await onMessage({ jid, phone, lid, name: m.pushName || '', text: textOf(msg).trim(), image });
  }

  async function send(to, text) {
    if (!sock || status.state !== 'connected') throw new Error('WhatsApp לא מחובר');
    const jid = to.includes('@') ? to : jidOf(to);
    await sock.sendMessage(jid, { text });
  }

  async function disconnect({ logout = false } = {}) {
    stopped = true;
    clearTimeout(reconnectTimer);
    const s = sock;
    sock = null;
    if (s) {
      if (logout) await s.logout().catch(() => {});
      else s.end?.(undefined);
    }
    if (logout) await store.authClear();
    set({ state: 'disconnected', qr: null, ...(logout ? { me: null } : {}), error: null });
  }

  return { connect, disconnect, send, status: () => ({ ...status }) };
}

module.exports = { createWhatsApp, useDbAuthState, textOf };
