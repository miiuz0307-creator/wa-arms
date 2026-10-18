// WhatsApp connection by QR (Baileys – an unofficial WhatsApp Web client).
// The session is kept encrypted in our database, so a restart or a new server needs no new scan.
//
// Baileys 7 understands WhatsApp's newer hidden ids (LID). With 6.x, messages
// from people whose chat moved to LID arrived empty ("Message absent from node" / "No session").
// Baileys 7 is an ES module, so it is loaded with import() once, before the first connection.
const pino = require('pino');
const { encrypt, decrypt } = require('./secure');
const { senderOf, jidOf } = require('./phones');

let B = null;
async function lib() {
  if (B) return B;
  // BAILEYS_MODULE: a file path to a stand-in, used by the tests
  const target = process.env.BAILEYS_MODULE ? require('url').pathToFileURL(require('path').resolve(process.env.BAILEYS_MODULE)).href : '@whiskeysockets/baileys';
  const m = await import(target);
  const pick = (k) => m[k] ?? m.default?.[k];
  B = {
    makeWASocket: typeof m.default === 'function' ? m.default : pick('makeWASocket'),
    DisconnectReason: pick('DisconnectReason'),
    Browsers: pick('Browsers'),
    BufferJSON: pick('BufferJSON'),
    initAuthCreds: pick('initAuthCreds'),
    proto: pick('proto'),
    makeCacheableSignalKeyStore: pick('makeCacheableSignalKeyStore'),
    downloadMediaMessage: pick('downloadMediaMessage'),
    generateWAMessageFromContent: pick('generateWAMessageFromContent'),
  };
  return B;
}

// The bot only talks in private chats: never decrypt group, status, broadcast or channel traffic.
// A busy number receives thousands of group messages; decrypting them was pure load and noise.
const ignoredJid = (jid = '') => jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');

// A group whose name contains one of these becomes the bot's command group
const COMMAND_GROUP_NAME = /botix|בוטיקס|תיקונ/i;
const quiet = pino({ level: 'silent' });
const MAX_IMAGE = 8 * 1024 * 1024;

// Baileys 6.7.17+ and 7 keep sender keys as raw JSON bytes
const WANTS_BYTES = true;

/**
 * Session keys live in memory (always current – WhatsApp's encryption breaks with "Bad MAC" if a
 * key is read before the previous write landed) and are saved to the database in batches.
 */
async function useDbAuthState(store, secret, log = quiet) {
  const { BufferJSON, initAuthCreds, proto } = await lib();
  const cache = new Map(); // key -> encrypted string
  for (const r of await store.authAll()) cache.set(r.key, r.value);

  const pendingSet = new Map();
  const pendingDel = new Set();
  let timer = null;
  let flushing = Promise.resolve();
  const doFlush = async () => {
    const sets = [...pendingSet];
    const dels = [...pendingDel];
    pendingSet.clear();
    pendingDel.clear();
    try {
      if (sets.length) await store.authSetMany(sets);
      if (dels.length) await store.authDelMany(dels);
    } catch (e) {
      log.error({ err: e.message }, 'saving WhatsApp session failed – will retry');
      for (const [k, v] of sets) if (!pendingSet.has(k) && !pendingDel.has(k)) pendingSet.set(k, v);
      for (const k of dels) if (!pendingSet.has(k)) pendingDel.add(k);
      schedule(5000);
    }
  };
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    flushing = flushing.then(doFlush, doFlush);
    return flushing;
  };
  const schedule = (ms = 1500) => {
    if (!timer) timer = setTimeout(flush, ms);
  };

  const read = (k) => {
    const v = cache.get(k);
    if (!v) return null;
    try {
      return JSON.parse(decrypt(secret, v), BufferJSON.reviver);
    } catch {
      return null; // wrong SESSION_SECRET or damaged row – treated as missing
    }
  };
  const write = (k, data) => {
    if (data === null || data === undefined) {
      cache.delete(k);
      pendingSet.delete(k);
      pendingDel.add(k);
    } else {
      const v = encrypt(secret, JSON.stringify(data, BufferJSON.replacer));
      cache.set(k, v);
      pendingDel.delete(k);
      pendingSet.set(k, v);
    }
    schedule(k === 'creds' ? 200 : 1500);
  };

  const creds = read('creds') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let v = read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            if (type === 'sender-key' && v) {
              const isBytes = Buffer.isBuffer(v) || v instanceof Uint8Array;
              try {
                if (WANTS_BYTES && !isBytes) v = Buffer.from(JSON.stringify(v, BufferJSON.replacer), 'utf8');
                else if (!WANTS_BYTES && isBytes) v = JSON.parse(Buffer.from(v).toString('utf8'), BufferJSON.reviver);
              } catch {
                v = null;
              }
            }
            out[id] = v;
          }
          return out;
        },
        set: async (data) => {
          for (const type of Object.keys(data)) for (const id of Object.keys(data[type])) write(`${type}-${id}`, data[type][id]);
        },
      },
    },
    saveCreds: async () => write('creds', creds),
    flush,
    clear: async () => {
      clearTimeout(timer);
      timer = null;
      pendingSet.clear();
      pendingDel.clear();
      cache.clear();
      await flushing.catch(() => {});
      await store.authClear();
    },
  };
}

/** Is there a scanned session to reconnect with? */
async function hasSession(store, secret) {
  const { BufferJSON } = await lib();
  const v = (await store.authAll()).find((r) => r.key === 'creds')?.value;
  if (!v) return false;
  try {
    return Boolean(JSON.parse(decrypt(secret, v), BufferJSON.reviver)?.me);
  } catch {
    return false;
  }
}

// A tapped button arrives as its id (e.g. "menu:human"), the same as if the id had been typed.
function buttonIdOf(m = {}) {
  const flow = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (flow) {
    try {
      const id = JSON.parse(flow)?.id;
      if (id) return String(id);
    } catch {}
  }
  return m.buttonsResponseMessage?.selectedButtonId || m.templateButtonReplyMessage?.selectedId || m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}

// which kind of message arrived – used by the menu test to tell which menu style WhatsApp delivered
function kindOf(m = {}) {
  if (m.interactiveResponseMessage) return 'native_flow';
  if (m.listResponseMessage) return 'list';
  if (m.buttonsResponseMessage || m.templateButtonReplyMessage) return 'buttons';
  return 'text';
}

const textOf = (m = {}) =>
  buttonIdOf(m) || m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.documentMessage?.caption || '';

function createWhatsApp({ store, secret, log, onMessage, onOpen, onGroupFound, buttons = true }) {
  const buttonsEnabled = buttons;
  // Private chats with this version of WhatsApp Web often arrive empty ("Message absent from node"),
  // group messages decrypt reliably – so the bot also works in one dedicated command group.
  let commandGroup = null;
  let commandGroupName = null;
  const checkedGroups = new Set();
  let sockRef = null;
  // A group message from a group we have not looked at yet: check its name once (cheap metadata
  // lookup). If it is the command group, its next messages are read.
  const ignore = (jid = '') => {
    if (!jid.endsWith('@g.us')) return ignoredJid(jid);
    if (jid === commandGroup) return false;
    if (!checkedGroups.has(jid) && sockRef) {
      checkedGroups.add(jid);
      sockRef
        .groupMetadata(jid)
        .then((meta) => considerGroup(jid, meta?.subject))
        .catch(() => checkedGroups.delete(jid));
    }
    return true;
  };
  let sock = null;
  let stopped = true;
  let reconnectTimer = null;
  let retries = 0;
  let auth = null;
  let undecryptable = 0;
  // our own sent messages, so WhatsApp can ask us to re-send one the recipient could not decrypt
  const sentCache = new Map();
  const retryMap = new Map();
  const retryCounter = {
    get: (k) => retryMap.get(k),
    set: (k, v) => {
      retryMap.set(k, v);
      if (retryMap.size > 2000) retryMap.delete(retryMap.keys().next().value);
    },
    del: (k) => retryMap.delete(k),
    flushAll: () => retryMap.clear(),
  };
  const status = { state: 'disconnected', qr: null, me: null, error: null, since: new Date().toISOString() };

  const set = (patch) => Object.assign(status, patch, { since: new Date().toISOString() });

  async function connect() {
    clearTimeout(reconnectTimer);
    if (sock) return status;
    stopped = false;
    set({ state: 'connecting', error: null });
    const { makeWASocket, Browsers, makeCacheableSignalKeyStore } = await lib();
    auth = auth || (await useDbAuthState(store, secret, log));
    const { state, saveCreds } = auth;
    const keys = makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(state.keys, quiet) : state.keys;
    const s = makeWASocket({
      auth: { creds: state.creds, keys },
      logger: quiet,
      shouldIgnoreJid: ignore,
      browser: Browsers.ubuntu('Chrome'),
      getMessage: async (key) => sentCache.get(key?.id),
      msgRetryCounterCache: retryCounter,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    sock = s;
    sockRef = s;
    s.ev.on('creds.update', () => saveCreds().catch((e) => log.error({ err: e.message }, 'saving creds failed')));
    s.ev.on('connection.update', (u) => onUpdate(s, u, state).catch((e) => log.error({ err: e.message }, 'connection handler failed')));
    s.ev.on('groups.upsert', (groups) => {
      for (const g of groups || []) considerGroup(g.id, g.subject);
    });
    s.ev.on('groups.update', (groups) => {
      for (const g of groups || []) if (g.subject) considerGroup(g.id, g.subject);
    });
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) handleIncoming(s, m).catch((e) => log.error({ err: e.message }, 'incoming message failed'));
    });
    return status;
  }

  async function onUpdate(s, u, state) {
    const { DisconnectReason } = await lib();
    if (s !== sock) return;
    if (u.qr) set({ state: 'qr', qr: u.qr, error: null });
    if (u.connection === 'open') {
      retries = 0;
      const me = (s.user?.id || '').split(':')[0].split('@')[0];
      undecryptable = 0;
      set({ state: 'connected', qr: null, me, error: null });
      log.info({ me }, 'WhatsApp connected');
      if (onOpen) Promise.resolve(onOpen()).catch((e) => log.warn({ err: e.message }, 'after-connect task failed'));
      findCommandGroup(s).catch((e) => log.warn({ err: e.message }, 'looking for the command group failed'));
    }
    if (u.connection !== 'close') return;
    sock = null;
    const code = u.lastDisconnect?.error?.output?.statusCode;
    log.warn({ code }, 'WhatsApp connection closed');
    await auth?.flush().catch(() => {});
    if (stopped) return set({ state: 'disconnected', qr: null });
    if (code === DisconnectReason.restartRequired) return connect(); // normal right after scanning
    if (code === DisconnectReason.loggedOut) {
      await auth?.clear();
      auth = null;
      stopped = true;
      return set({ state: 'disconnected', qr: null, me: null, error: 'החיבור נותק מהטלפון. לחצו "חיבור WhatsApp" וסרקו שוב.' });
    }
    if (!state.creds?.me) {
      stopped = true;
      auth = null;
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
    if (m.key?.fromMe) return;
    if (!m.message) {
      // a private message that could not be decrypted (broken encryption session with that sender)
      if (!ignore(jid) && m.messageStubType === 2) {
        undecryptable++;
        log.warn({ undecryptable, params: m.messageStubParameters }, 'private message could not be decrypted');
        if (undecryptable >= 3) set({ error: 'הודעות פרטיות מגיעות אבל לא ניתנות לפענוח. לחצו "ניתוק ומחיקת החיבור" וסרקו QR מחדש.' });
      }
      return;
    }
    // private chats only: ignore groups, status updates, channels and broadcasts
    if (ignore(jid)) return;
    const msg = m.message.ephemeralMessage?.message || m.message.viewOnceMessage?.message || m.message;
    let { phone, lid } = senderOf({ ...m.key, participant: m.key?.participant || m.participant });
    if (!phone && !lid) {
      // unknown sender shape: log which id fields exist (domains only, no numbers) to diagnose
      const shape = Object.fromEntries(Object.entries({ ...m.key, mParticipant: m.participant }).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.includes('@') ? '@' + v.split('@')[1] : v.length]));
      log.warn({ shape }, 'sender could not be identified');
    }
    // WhatsApp increasingly hides the number behind a private id (LID): ask Baileys for the number
    if (!phone && lid) {
      try {
        const pn = await s.signalRepository?.lidMapping?.getPNForLID?.(`${lid}@lid`);
        if (pn) phone = String(pn).split('@')[0].split(':')[0];
      } catch {}
    }
    log.info({ chat: jid.endsWith('@g.us') ? 'group' : 'private', from: phone ? `${phone.slice(0, 5)}***${phone.slice(-2)}` : null, lid: lid ? 'yes' : 'no', image: Boolean(msg.imageMessage), kind: kindOf(msg) }, 'message received');
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
            const buf = await (await lib()).downloadMediaMessage({ ...m, message: msg }, 'buffer', {}, { logger: quiet, reuploadRequest: s.updateMediaMessage });
            if (!buf || buf.length > MAX_IMAGE) return { tooBig: true };
            return { buffer: buf, mimetype };
          } catch (e) {
            log.warn({ err: e.message }, 'image download failed');
            return { failed: true };
          }
        },
      };
    }
    await onMessage({ jid, phone, lid, name: m.pushName || '', text: textOf(msg).trim(), kind: kindOf(msg), image });
  }

  function considerGroup(id, subject) {
    if (!id || !subject || commandGroup === id || !COMMAND_GROUP_NAME.test(subject)) return;
    checkedGroups.add(id);
    commandGroup = id;
    commandGroupName = subject;
    log.info({ subject }, 'command group found');
    if (onGroupFound) Promise.resolve(onGroupFound(id, subject)).catch(() => {});
  }

  async function findCommandGroup(s) {
    if (commandGroup) {
      try {
        const meta = await s.groupMetadata(commandGroup);
        commandGroupName = meta?.subject || commandGroupName;
        return;
      } catch {
        // the bot was removed from the saved group – look for another one
        commandGroup = null;
      }
    }
    const all = (await s.groupFetchAllParticipating()) || {};
    const found = Object.values(all).find((g) => COMMAND_GROUP_NAME.test(g.subject || ''));
    if (found) considerGroup(found.id, found.subject);
  }

  function setCommandGroup(id, name = null) {
    commandGroup = id || null;
    commandGroupName = name;
  }

  /** WhatsApp's private id (LID) of a phone number, when WhatsApp tells us. */
  async function lidOf(phone) {
    if (!sock || status.state !== 'connected') return null;
    try {
      const [r] = (await sock.onWhatsApp(phone)) || [];
      const lid = r?.lid || null;
      return lid ? String(lid).split('@')[0].split(':')[0] : null;
    } catch {
      return null;
    }
  }

  const remember = (id, message) => {
    if (!id || !message) return;
    sentCache.set(id, message);
    if (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value);
  };

  async function send(to, text) {
    if (!sock || status.state !== 'connected') throw new Error('WhatsApp לא מחובר');
    const jid = to.includes('@') ? to : jidOf(to);
    const sent = await sock.sendMessage(jid, { text });
    remember(sent?.key?.id, sent?.message);
  }

  /**
   * A message with tap buttons (WhatsApp "quick reply"). Buttons are not officially supported for
   * QR-linked numbers; if sending fails the same options go out as a numbered text instead.
   * The text always lists the numbers too, so typing 1/2 works where buttons do not show.
   */
  async function sendButtons(to, text, buttons, footer = '') {
    if (!sock || status.state !== 'connected') throw new Error('WhatsApp לא מחובר');
    const jid = to.includes('@') ? to : jidOf(to);
    const { generateWAMessageFromContent } = await lib();
    try {
      if (!buttonsEnabled || !generateWAMessageFromContent || !sock.relayMessage) throw new Error('buttons off');
      const content = {
        interactiveMessage: {
          header: { title: '', subtitle: '', hasMediaAttachment: false },
          body: { text },
          footer: { text: footer || 'BotiX' },
          nativeFlowMessage: {
            buttons: buttons.map((b) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.title, id: b.id }) })),
            messageParamsJson: '',
          },
        },
      };
      const msg = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id });
      await sock.relayMessage(jid, msg.message, {
        messageId: msg.key.id,
        additionalNodes: [{ tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] }],
      });
      remember(msg.key.id, msg.message);
    } catch (e) {
      if (e.message !== 'buttons off') log.warn({ err: e.message }, 'buttons message failed – sending text');
      await send(to, text);
    }
  }

  // Send a message built by hand (interactive/list) with the extra "biz" node WhatsApp expects
  // for these types. Not officially supported for QR-linked numbers – used by the menu test.
  async function relayRaw(jid, content, bizContent) {
    const { generateWAMessageFromContent } = await lib();
    if (!generateWAMessageFromContent || !sock.relayMessage) throw new Error('הספרייה לא תומכת בשליחה כזו');
    const msg = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id });
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: [{ tag: 'biz', attrs: {}, content: bizContent }] });
    remember(msg.key.id, msg.message);
    return msg.key.id;
  }

  /**
   * Menu test: three menu styles, each labelled, so a real phone shows which ones WhatsApp renders.
   *   A – "פתיחת תפריט" button with a list (native flow single_select)
   *   B – classic list message (listMessage)
   *   C – three tap buttons (quick_reply)
   * Returns what was sent and what failed; nothing else in the bot changes.
   */
  async function sendMenuTest(to) {
    if (!sock || status.state !== 'connected') throw new Error('WhatsApp לא מחובר');
    const jid = to.includes('@') ? to : jidOf(to);
    const rows = (v) => [1, 2, 3].map((n) => ({ id: `test:${v}${n}`, title: `אפשרות ${n}`, description: `בדיקה ${v} – אפשרות ${n}` }));
    const flowNode = [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }];
    const variants = [
      {
        v: 'A',
        send: () =>
          relayRaw(jid, {
            interactiveMessage: {
              header: { title: 'בדיקה A', subtitle: '', hasMediaAttachment: false },
              body: { text: '🧪 בדיקה A: לחצו על "פתיחת תפריט" ובחרו אפשרות.' },
              footer: { text: 'BotiX' },
              nativeFlowMessage: {
                buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: 'פתיחת תפריט', sections: [{ title: 'בדיקה A', rows: rows('A').map((r) => ({ header: '', ...r })) }] }) }],
                messageParamsJson: '',
              },
            },
          }, flowNode),
      },
      {
        v: 'B',
        send: () =>
          relayRaw(jid, {
            listMessage: {
              title: 'בדיקה B',
              description: '🧪 בדיקה B: לחצו על "פתיחת תפריט" ובחרו אפשרות.',
              buttonText: 'פתיחת תפריט',
              footerText: 'BotiX',
              listType: 1,
              sections: [{ title: 'בדיקה B', rows: rows('B').map((r) => ({ title: r.title, description: r.description, rowId: r.id })) }],
            },
          }, [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }]),
      },
      {
        v: 'C',
        send: () =>
          relayRaw(jid, {
            interactiveMessage: {
              header: { title: 'בדיקה C', subtitle: '', hasMediaAttachment: false },
              body: { text: '🧪 בדיקה C: לחצו על אחד הכפתורים.' },
              footer: { text: 'BotiX' },
              nativeFlowMessage: {
                buttons: rows('C').map((r) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: r.title, id: r.id }) })),
                messageParamsJson: '',
              },
            },
          }, flowNode),
      },
    ];
    const results = [];
    for (const x of variants) {
      try {
        await x.send();
        results.push({ variant: x.v, sent: true });
      } catch (e) {
        results.push({ variant: x.v, sent: false, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    log.info({ results }, 'menu test sent');
    return results;
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
    await auth?.flush().catch(() => {});
    if (logout) {
      await auth?.clear();
      await store.authClear();
      auth = null;
    }
    set({ state: 'disconnected', qr: null, ...(logout ? { me: null } : {}), error: null });
  }

  return {
    connect,
    disconnect,
    send,
    sendButtons,
    sendMenuTest,
    lidOf,
    setCommandGroup,
    commandGroup: () => commandGroup,
    status: () => ({ ...status, group: commandGroup ? commandGroupName || 'קבוצת פיקוד' : null }),
  };
}

module.exports = { createWhatsApp, useDbAuthState, hasSession, textOf, buttonIdOf, kindOf, ignoredJid, COMMAND_GROUP_NAME };
