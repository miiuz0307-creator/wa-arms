// WhatsApp auth state stored in Supabase (table arm_auth), encrypted with AES-256-GCM.
// Moving to another server needs only the same SESSION_SECRET – no new QR scan.
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { db, log } = require('./config');

// Baileys after 6.7.16 keeps sender keys as raw JSON bytes
const WANTS_BYTES = (() => {
  try {
    const [a, b, c] = require('@whiskeysockets/baileys/package.json').version.split('.').map(Number);
    return a > 6 || (a === 6 && (b > 7 || (b === 7 && c > 16)));
  } catch {
    return true;
  }
})();

const deriveKey = (secret) => crypto.createHash('sha256').update(secret).digest();

function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// Local disk copy (Railway volume). Reading/writing thousands of keys through the database
// overloaded it (each incoming group message changes keys), so the disk is the working copy
// and the database only gets a backup every minute.
const AUTH_DIR = process.env.AUTH_DIR || '/data/auth';
const fname = (k) => encodeURIComponent(k);

function localDir(armId) {
  try {
    const dir = path.join(AUTH_DIR, armId);
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.probe');
    fs.writeFileSync(probe, '1');
    return dir;
  } catch {
    return null; // no volume – database only
  }
}

// Write a file so that a crash mid-write never leaves a half-written key: write a temp file
// (names starting with '.' are ignored on load), flush it to disk, then rename over the old one.
async function writeAtomic(file, data, durable = true) {
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    if (durable) await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function useDbAuthState(armId, secret) {
  const key = deriveKey(secret);
  const cache = new Map();
  const dir = localDir(armId);

  const valid = (v) => {
    try {
      decrypt(key, v);
      return true;
    } catch {
      return false;
    }
  };

  // With a disk, per-chat keys (tens of thousands per number, ~250 MB) are read from the disk when
  // WhatsApp needs them instead of all being held in memory – that was most of the engine's memory
  // and limited how many numbers one server could carry. Only the login identity is kept loaded.
  const known = new Set(); // keys that exist on disk
  const LRU_MAX = 3000;
  const isIdentity = (k) => k === 'creds' || k.startsWith('app-state-sync-key-');
  const touch = (k, v) => {
    cache.delete(k);
    cache.set(k, v);
    if (dir && cache.size > LRU_MAX) {
      for (const old of cache.keys()) {
        if (cache.size <= LRU_MAX) break;
        if (isIdentity(old)) continue;
        cache.delete(old);
      }
    }
  };

  let fromDisk = false;
  if (dir && fs.existsSync(path.join(dir, fname('creds')))) {
    let bad = 0;
    for (const f of await fsp.readdir(dir)) {
      if (f.startsWith('.')) {
        if (f.startsWith('.tmp-')) await fsp.unlink(path.join(dir, f)).catch(() => {}); // leftover of an interrupted write
        continue;
      }
      const k = decodeURIComponent(f);
      known.add(k);
      if (!isIdentity(k)) continue;
      try {
        const v = await fsp.readFile(path.join(dir, f), 'utf8');
        if (valid(v)) cache.set(k, v);
        else {
          bad += 1; // damaged file: skip it
          known.delete(k);
        }
      } catch {}
    }
    if (bad) log.warn({ armId, bad }, 'damaged auth files skipped');
    fromDisk = true;
    // the login identity on disk is damaged: take it from the database backup instead of losing the connection
    if (!cache.has('creds')) {
      const { data } = await db.from('arm_auth').select('key,value').eq('arm_id', armId).or('key.eq.creds,key.like.app-state-sync-key-%'); // rows: bounded – one arm's login identity, a few rows
      for (const r of data || []) {
        if (valid(r.value) && !cache.has(r.key)) {
          cache.set(r.key, r.value);
          known.add(r.key);
        }
      }
      log.warn({ armId, restored: !!cache.get('creds') }, 'creds on disk unreadable – restored from database backup');
      if (cache.has('creds')) await writeAtomic(path.join(dir, fname('creds')), cache.get('creds')).catch(() => {});
    }
  } else {
    // keyset paging (by key) – offset paging re-read all earlier rows and timed out on large sessions
    let last = null;
    for (;;) {
      let q = db.from('arm_auth').select('key,value').eq('arm_id', armId).order('key').limit(500);
      if (last !== null) q = q.gt('key', last);
      let res = await q;
      if (res.error) res = await q; // one retry on a hiccup
      if (res.error) throw res.error;
      const data = res.data || [];
      for (const r of data) cache.set(r.key, r.value);
      if (data.length < 500) break;
      last = data[data.length - 1].key;
    }
    if (dir && cache.size) {
      for (const [k, v] of cache) {
        await writeAtomic(path.join(dir, fname(k)), v, false).catch(() => {});
        known.add(k);
      }
    }
  }
  log.info({ armId, keys: dir ? known.size : cache.size, source: fromDisk ? 'disk' : 'database' }, 'auth state loaded');

  const decode = (k, v) => {
    try {
      return JSON.parse(decrypt(key, v), BufferJSON.reviver);
    } catch (e) {
      log.warn({ armId, k }, 'auth value could not be decrypted');
      return null;
    }
  };
  // diskWrites/diskDeletes are declared below; read() only runs after setup is complete
  const read = async (k) => {
    let v = cache.get(k);
    if (v) {
      touch(k, v);
      return decode(k, v);
    }
    if (!dir || diskDeletes.has(k)) return null;
    v = diskWrites.get(k); // written a moment ago, not on disk yet
    if (!v && known.has(k)) v = await fsp.readFile(path.join(dir, fname(k)), 'utf8').catch(() => null);
    if (!v) return null;
    touch(k, v);
    return decode(k, v);
  };

  // disk: written within a second; database backup: every 10 minutes (or every 5s without a volume)
  const DB_EVERY_MS = dir ? 10 * 60_000 : 5000;
  const diskWrites = new Map();
  const diskDeletes = new Set();
  let diskTimer = null;
  let diskFlushing = Promise.resolve();
  const doDiskFlush = async () => {
    const ws = [...diskWrites];
    diskWrites.clear();
    const ds = [...diskDeletes];
    diskDeletes.clear();
    for (const [k, v] of ws) await writeAtomic(path.join(dir, fname(k)), v, k === 'creds' || k.startsWith('app-state-sync-key-')).catch((e) => log.error({ armId, err: e.message }, 'auth disk write failed'));
    for (const k of ds) await fsp.unlink(path.join(dir, fname(k))).catch(() => {});
  };
  const diskFlush = () => {
    if (!dir) return Promise.resolve();
    if (diskTimer) {
      clearTimeout(diskTimer);
      diskTimer = null;
    }
    diskFlushing = diskFlushing.then(doDiskFlush, doDiskFlush);
    return diskFlushing;
  };

  const pendingWrites = new Map();
  const pendingDeletes = new Set();
  let timer = null;
  let flushing = Promise.resolve();

  const doDbFlush = async () => {
    const ups = [...pendingWrites].map(([k, value]) => ({
      arm_id: armId,
      key: k,
      value,
      updated_at: new Date().toISOString(),
    }));
    pendingWrites.clear();
    const dels = [...pendingDeletes];
    pendingDeletes.clear();
    for (let i = 0; i < ups.length; i += 500) {
      const batch = ups.slice(i, i + 500);
      const { error } = await db.from('arm_auth').upsert(batch);
      if (error) {
        log.error({ armId, err: error.message }, 'auth upsert failed – will retry');
        // keep the keys so they are saved on the next flush (unless a newer value is already waiting)
        for (const r of batch) if (!pendingWrites.has(r.key) && !pendingDeletes.has(r.key)) pendingWrites.set(r.key, r.value);
        if (!timer) timer = setTimeout(dbFlush, DB_EVERY_MS);
      }
    }
    for (let i = 0; i < dels.length; i += 200) {
      const { error } = await db
        .from('arm_auth')
        .delete()
        .eq('arm_id', armId)
        .in('key', dels.slice(i, i + 200));
      if (error) log.error({ armId, err: error.message }, 'auth delete failed');
    }
  };

  const dbFlush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flushing = flushing.then(doDbFlush, doDbFlush);
    return flushing;
  };

  // everything still waiting goes out now (disk first – it is the one we start from)
  const flush = async () => {
    await diskFlush();
    await dbFlush();
  };

  // With a disk, the database keeps only the login identity (creds + app-state keys): enough to
  // reconnect without a new QR if the disk is ever lost. The thousands of per-chat encryption keys
  // stay on the disk only – writing them to the small database is what choked it.
  const backupKey = (k) => !dir || k === 'creds' || k.startsWith('app-state-sync-key-');

  const write = (k, val) => {
    if (val === null || val === undefined) {
      cache.delete(k);
      known.delete(k);
      pendingWrites.delete(k);
      if (backupKey(k)) pendingDeletes.add(k);
      diskWrites.delete(k);
      diskDeletes.add(k);
    } else {
      const v = encrypt(key, JSON.stringify(val, BufferJSON.replacer));
      touch(k, v);
      known.add(k);
      pendingDeletes.delete(k);
      if (backupKey(k)) pendingWrites.set(k, v);
      diskDeletes.delete(k);
      diskWrites.set(k, v);
    }
    if (dir && !diskTimer) diskTimer = setTimeout(diskFlush, 1000);
    // Signal keys change on almost every incoming group message: collect them so each key
    // is written once per interval instead of dozens of times.
    if (!timer && (pendingWrites.size || pendingDeletes.size)) timer = setTimeout(dbFlush, DB_EVERY_MS);
  };

  // make sure the database backup has the identity keys (once per start, a few rows)
  if (dir) {
    // only values that decrypt correctly – a damaged copy must never overwrite a good backup
    for (const [k, v] of cache) if (backupKey(k) && valid(v)) pendingWrites.set(k, v);
    if (pendingWrites.size) timer = setTimeout(dbFlush, 30_000);
  }

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          // read from disk in parallel (a group send can need a thousand member keys at once)
          const vals = [];
          for (let i = 0; i < ids.length; i += 64) {
            vals.push(...(await Promise.all(ids.slice(i, i + 64).map((id) => read(`${type}-${id}`)))));
          }
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            let v = vals[i];
            if (type === 'app-state-sync-key' && v) {
              v = proto.Message.AppStateSyncKeyData.fromObject(v);
            }
            // Sender-key format differs between Baileys versions: 6.7.16 wants the parsed structure,
            // newer versions want the raw JSON bytes. Convert whatever is stored to what this version reads.
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
          for (const category in data) {
            for (const id in data[category]) write(`${category}-${id}`, data[category][id]);
          }
        },
      },
    },
    saveCreds: async () => {
      write('creds', creds);
    },
    flush,
    clear: async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      cache.clear();
      known.clear();
      pendingWrites.clear();
      pendingDeletes.clear();
      if (diskTimer) clearTimeout(diskTimer);
      diskTimer = null;
      diskWrites.clear();
      diskDeletes.clear();
      await diskFlushing.catch(() => {});
      await flushing.catch(() => {});
      if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      await db.from('arm_auth').delete().eq('arm_id', armId);
    },
  };
}

module.exports = { useDbAuthState };
