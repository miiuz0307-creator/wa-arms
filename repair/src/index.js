// BotiX AI Repair – entry point.
const fs = require('fs');
const pino = require('pino');
const { load } = require('./config');
const { createMemoryStore } = require('./store/memory');
const { createPgStore } = require('./store/pg');
const { createWhatsApp, hasSession } = require('./wa');
const { createRailway } = require('./railway');
const { createGitHub } = require('./github');
const { createWorkspace } = require('./workspace');
const { createClaude } = require('./claude');
const { createPipeline } = require('./pipeline');
const { createIntake } = require('./intake');
const { createServer } = require('./server');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// libsignal prints harmless decryption noise straight to the console (e.g. "Bad MAC" after a restart).
// It floods the server log (Railway drops lines above 500/s), so drop those lines.
const NOISE = /Bad MAC|Decrypted message with closed session|Failed to decrypt message|Session error|SessionError|Closing (open )?session|Closing stale|SessionEntry|No matching sessions|decryptWithSessions|doDecryptWhisperMessage|verifyMAC|fillMessageKeys|_asyncQueueExecutor|session_cipher|queue_job|processTicksAndRejections|libsignal|messages into the future/;
for (const level of ['error', 'warn', 'info', 'log']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const first = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
    if (NOISE.test(first)) return;
    orig(...args);
  };
}

async function main() {
  const cfg = load();
  const missing = [];
  if (!cfg.adminPassword || cfg.adminPassword.length < 10) missing.push('ADMIN_PASSWORD (לפחות 10 תווים)');
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) missing.push('SESSION_SECRET (לפחות 32 תווים אקראיים)');
  if (missing.length) {
    console.error(`חסרות הגדרות חובה: ${missing.join(', ')}`);
    process.exit(1);
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  let store;
  if (cfg.databaseUrl) store = await createPgStore(cfg.databaseUrl);
  else {
    log.warn('DATABASE_URL חסר – הנתונים נשמרים בזיכרון בלבד ויימחקו בהפעלה מחדש');
    store = createMemoryStore();
  }

  let intake = null;
  const savedGroup = await store.getSetting('command_group');
  const wa = createWhatsApp({
    onGroupFound: async (id, subject) => {
      await store.setSetting('command_group', { id, subject });
      await pipeline.audit(null, 'system', 'command_group', `קבוצת הפיקוד נקבעה: ${subject}`);
      await wa.send(id, `✅ הבוט מחובר לקבוצה "${subject}".\nמעכשיו כתבו כאן תקלות ופקודות.\n\n` + require('./messages').help(true)).catch(() => {});
    },
    store,
    secret: cfg.sessionSecret,
    log,
    buttons: cfg.waButtons,
    onMessage: (msg) => (intake ? intake.handle(msg) : null),
    // learn the hidden WhatsApp id of every approved number, so their messages are recognised
    onOpen: async () => {
      for (const n of await store.listNumbers()) {
        if (n.lid) continue;
        const lid = await wa.lidOf(n.phone);
        if (lid) await store.updateNumber(n.id, { lid });
      }
    },
  });
  if (savedGroup?.id) wa.setCommandGroup(savedGroup.id, savedGroup.subject);
  const railway = createRailway(cfg.railway);
  const github = createGitHub(cfg.github);
  const ws = createWorkspace(cfg);
  if (!ws.runner) log.warn('Claude והבדיקות ירוצו באותו משתמש כמו השרת (לא בתוך ה-Dockerfile). הפרדת ההרשאות לא פעילה.');
  const claude = createClaude(cfg, ws);
  const pipeline = createPipeline({ cfg, store, wa, railway, github, ws, claude, log, onNotify: (p) => intake?.touch(p) });
  intake = createIntake({ cfg, store, wa, pipeline, log });

  // OWNER_PHONES: make sure the owner's numbers are on the list as approvers
  {
    const { toIntl } = require('./phones');
    const existing = await store.listNumbers();
    for (const raw of cfg.ownerPhones || []) {
      const phone = toIntl(raw);
      if (!phone) continue;
      const n = existing.find((x) => x.phone === phone);
      if (!n) await store.addNumber({ phone, name: 'בעלים', role: 'approver' });
      else if (n.role !== 'approver' || !n.active) await store.updateNumber(n.id, { role: 'approver', active: true });
    }
  }

  for (const t of await store.resetStuck()) {
    const msg =
      t.status === 'deploying'
        ? 'השרת הופעל מחדש באמצע העלאה לייצור. ייתכן שהתיקון כבר מוזג ועלה – בדקו ב-Railway. אפשר לחזור לגרסה הקודמת מהממשק.'
        : `הטיפול נקטע בהפעלה מחדש (היה בשלב ${t.status})`;
    await pipeline.audit(t.id, 'system', 'interrupted', msg);
  }

  // reconnect automatically when a session from an earlier scan exists
  if (await hasSession(store, cfg.sessionSecret)) wa.connect().catch((e) => log.error({ err: e.message }, 'auto-connect failed'));

  pipeline.start();
  const server = createServer({ cfg, store, wa, railway, github, claude, pipeline, log, ws });
  server.listen(cfg.port, () => log.info({ port: cfg.port }, 'BotiX AI Repair is up'));

  const shutdown = async () => {
    pipeline.stop();
    server.close();
    await wa.disconnect().catch(() => {});
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
