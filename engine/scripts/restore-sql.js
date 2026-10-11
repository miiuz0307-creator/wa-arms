// Turns a daily backup file into SQL that puts the rows back.
//   node scripts/restore-sql.js /data/backups/db-2026-10-11.json.gz [--schema restore_test] [--tables a,b] > restore.sql
// Rows that still exist are left as they are (on conflict do nothing) – nothing is deleted or overwritten.
// --schema X: restore into a separate schema (created as an empty copy of public) to check a backup safely.
const fs = require('fs');
const zlib = require('zlib');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
if (!file) { console.error('usage: restore-sql.js <backup.json.gz> [--schema X] [--tables a,b]'); process.exit(1); }
const raw = fs.readFileSync(file);
const data = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
const schema = opt('schema') || 'public';
const only = opt('tables') ? new Set(opt('tables').split(',')) : null;
const q = (s) => '"' + s.replace(/"/g, '""') + '"';
let tag = 'j' + Math.random().toString(36).slice(2, 8);
const out = [`-- restore of ${file} (backup taken ${data.created_at}) into schema ${schema}`, 'begin;'];
if (schema !== 'public') out.push(`create schema if not exists ${q(schema)};`);
for (const [t, rows] of Object.entries(data.tables)) {
  if (only && !only.has(t)) continue;
  if (schema !== 'public') out.push(`create table if not exists ${q(schema)}.${q(t)} (like public.${q(t)} including defaults including constraints including indexes);`);
  for (let i = 0; i < rows.length; i += 1000) {
    const json = JSON.stringify(rows.slice(i, i + 1000));
    while (json.includes(`$${tag}$`)) tag += 'x';
    out.push(`insert into ${q(schema)}.${q(t)} overriding system value select * from jsonb_populate_recordset(null::${q(schema)}.${q(t)}, $${tag}$${json}$${tag}$::jsonb) on conflict do nothing;`);
  }
}
out.push('commit;');
process.stdout.write(out.join('\n') + '\n');
