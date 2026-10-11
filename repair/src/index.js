// BotiX AI Repair – entry point.
const fs = require('fs');
const pino = require('pino');
const { load } = require('./config');
const { createMemoryStore } = require('./store/memory');
const { createPgStore } = require('./store/pg');
const { createWhatsApp, useDbAuthState } = require('./wa');
const { createRailway } = require('./railway');
const { createGitHub } = require('./github');
const { createWorkspace } = require('./workspace');
const { createClaude } = require('./claude');
const { createPipeline } = require('./pipeline');
const { createIntake } = require('./intake');
const { createServer } = require('./server');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

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
  const wa = createWhatsApp({
    store,
    secret: cfg.sessionSecret,
    log,
    onMessage: (msg) => (intake ? intake.handle(msg) : null),
  });
  const railway = createRailway(cfg.railway);
  const github = createGitHub(cfg.github);
  const ws = createWorkspace(cfg);
  if (!ws.runner) log.warn('Claude והבדיקות ירוצו באותו משתמש כמו השרת (לא בתוך ה-Dockerfile). הפרדת ההרשאות לא פעילה.');
  const claude = createClaude(cfg, ws);
  const pipeline = createPipeline({ cfg, store, wa, railway, github, ws, claude, log });
  intake = createIntake({ cfg, store, wa, pipeline, log });

  for (const t of await store.resetStuck()) {
    const msg =
      t.status === 'deploying'
        ? 'השרת הופעל מחדש באמצע העלאה לייצור. ייתכן שהתיקון כבר מוזג ועלה – בדקו ב-Railway. אפשר לחזור לגרסה הקודמת מהממשק.'
        : `הטיפול נקטע בהפעלה מחדש (היה בשלב ${t.status})`;
    await pipeline.audit(t.id, 'system', 'interrupted', msg);
  }

  // reconnect automatically when a session from an earlier scan exists
  const { state } = await useDbAuthState(store, cfg.sessionSecret);
  if (state.creds?.me) wa.connect().catch((e) => log.error({ err: e.message }, 'auto-connect failed'));

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
