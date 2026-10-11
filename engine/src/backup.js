// Daily backup of the whole database to the server disk (Railway volume), outside the database.
// One gzip JSON file per day: { created_at, tables: { name: [rows...] } }. The last 14 days are kept.
// Restore: node scripts/restore-sql.js <file> > restore.sql  (then run it in the Supabase SQL editor).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { db, log } = require('./config');

const DIR = process.env.BACKUP_DIR || '/data/backups';
const KEEP_DAYS = 14;
// order matters for restore (parents before children)
const TABLES = [
  'stations', 'profiles', 'app_settings', 'templates', 'triggers', 'arms', 'groups',
  'distribution_lists', 'list_groups', 'list_arms', 'source_groups', 'dispatchers', 'wa_operators',
  'campaigns', 'campaign_arms', 'campaign_targets', 'quote_sessions', 'activity_log', 'arm_auth',
];

async function dumpTable(name) {
  const rows = [];
  for (let off = 0; ; off += 2000) {
    let res;
    for (let i = 0; i < 4; i++) {
      res = await db.rpc('engine_backup_rows', { p_table: name, p_offset: off, p_limit: 2000 });
      if (!res.error) break;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
    rows.push(...(res.data || []));
    if ((res.data || []).length < 2000) break;
    await new Promise((r) => setTimeout(r, 200)); // gentle on the database
  }
  return rows;
}

async function runBackup() {
  fs.mkdirSync(DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(DIR, `db-${day}.json.gz`);
  const t0 = Date.now();
  const tables = {};
  const counts = {};
  for (const t of TABLES) {
    tables[t] = await dumpTable(t);
    counts[t] = tables[t].length;
  }
  const gz = zlib.gzipSync(JSON.stringify({ created_at: new Date().toISOString(), tables }));
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, gz);
  await fsp.rename(tmp, file);
  // keep the last KEEP_DAYS files
  const files = (await fsp.readdir(DIR)).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) await fsp.unlink(path.join(DIR, f)).catch(() => {});
  log.info({ file, kb: Math.round(gz.length / 1024), sec: Math.round((Date.now() - t0) / 1000), counts }, 'database backup written');
  return { file, counts };
}

// once a day, at night (Israel ~03:00 = 00:00 UTC), and on start if today's file is missing
let running = false;
async function maybeBackup() {
  if (running) return;
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(DIR, `db-${day}.json.gz`);
  if (fs.existsSync(file)) return;
  // wait for the quiet hour unless no backup exists from yesterday either
  const y = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const hasYesterday = fs.existsSync(path.join(DIR, `db-${y}.json.gz`));
  if (hasYesterday && new Date().getUTCHours() >= 3) return;
  running = true;
  try {
    await runBackup();
  } catch (e) {
    log.error({ err: e.message }, 'database backup failed');
  } finally {
    running = false;
  }
}

module.exports = { runBackup, maybeBackup, TABLES };
