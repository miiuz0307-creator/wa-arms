// WhatsApp auth state stored in Supabase (table arm_auth), encrypted with AES-256-GCM.
// Moving to another server needs only the same SESSION_SECRET – no new QR scan.
const crypto = require('crypto');
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

async function useDbAuthState(armId, secret) {
  const key = deriveKey(secret);
  const cache = new Map();

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

  const read = (k) => {
    const v = cache.get(k);
    if (!v) return null;
    try {
      return JSON.parse(decrypt(key, v), BufferJSON.reviver);
    } catch (e) {
      log.warn({ armId, k }, 'auth value could not be decrypted');
      return null;
    }
  };

  const pendingWrites = new Map();
  const pendingDeletes = new Set();
  let timer = null;
  let flushing = Promise.resolve();

  const doFlush = async () => {
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
        if (!timer) timer = setTimeout(flush, 5000);
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

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flushing = flushing.then(doFlush, doFlush);
    return flushing;
  };

  const write = (k, val) => {
    if (val === null || val === undefined) {
      cache.delete(k);
      pendingWrites.delete(k);
      pendingDeletes.add(k);
    } else {
      const v = encrypt(key, JSON.stringify(val, BufferJSON.replacer));
      cache.set(k, v);
      pendingDeletes.delete(k);
      pendingWrites.set(k, v);
    }
    if (!timer) timer = setTimeout(flush, 500);
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
      await flush();
    },
    flush,
    clear: async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      cache.clear();
      pendingWrites.clear();
      pendingDeletes.clear();
      await flushing.catch(() => {});
      await db.from('arm_auth').delete().eq('arm_id', armId);
    },
  };
}

module.exports = { useDbAuthState };
