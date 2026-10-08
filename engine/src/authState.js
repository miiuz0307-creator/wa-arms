// WhatsApp auth state stored in Supabase (table arm_auth), encrypted with AES-256-GCM.
// Moving to another server needs only the same SESSION_SECRET – no new QR scan.
const crypto = require('crypto');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { db, log } = require('./config');

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

  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('arm_auth')
      .select('key,value')
      .eq('arm_id', armId)
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data) cache.set(r.key, r.value);
    if (data.length < 1000) break;
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
      const { error } = await db.from('arm_auth').upsert(ups.slice(i, i + 500));
      if (error) log.error({ armId, err: error.message }, 'auth upsert failed');
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
