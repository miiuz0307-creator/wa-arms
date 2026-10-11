// Automated tests for the engine – no WhatsApp and no database are touched.
// Run: npm test   (uses the stand-ins in test/stubs instead of Baileys / Supabase)
process.env.SUPABASE_URL = 'http://test';
process.env.SUPABASE_ANON_KEY = 'x';
process.env.ENGINE_KEY = 'x';
process.env.SESSION_SECRET = 'test-secret';
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.AUTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));

const test = require('node:test');
const assert = require('node:assert');

const { useDbAuthState } = require('../src/authState');
const engine = require('../src/index');
const { Arm } = require('../src/arm');

const ops = [];
function dbAnswer(fn) {
  ops.length = 0;
  global.__db = (op) => {
    ops.push(op);
    return fn(op);
  };
}

// ---------- WhatsApp connection files (ק2) ----------
test('auth: keys survive a restart, are written atomically, damaged files are skipped', async () => {
  dbAnswer(() => ({ data: [], error: null }));
  const a = await useDbAuthState('arm-1', 'test-secret');
  a.state.creds.me = { id: '972500000001@s.whatsapp.net' };
  await a.saveCreds();
  await a.state.keys.set({ session: { 'u1.0': { x: 1 } }, 'pre-key': { 5: { k: 2 } } });
  await a.flush();
  const dir = path.join(process.env.AUTH_DIR, 'arm-1');
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('creds'));
  assert.ok(!files.some((f) => f.startsWith('.tmp-')), 'no temp files left behind');
  // simulate a crash mid-write: a torn temp file and a damaged key file
  fs.writeFileSync(path.join(dir, '.tmp-session-u1.0-1-ab'), 'half');
  fs.writeFileSync(path.join(dir, encodeURIComponent('session-u2.0')), 'garbage');
  const b = await useDbAuthState('arm-1', 'test-secret');
  assert.equal(b.state.creds.me.id, '972500000001@s.whatsapp.net', 'login kept – no new QR');
  const got = await b.state.keys.get('session', ['u1.0', 'u2.0']);
  assert.deepEqual(got['u1.0'], { x: 1 });
  assert.equal(got['u2.0'], null, 'damaged key skipped instead of crashing');
  assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith('.tmp-')), 'leftover temp file removed');
});

test('auth: damaged creds on disk are restored from the database backup, and never overwrite it', async () => {
  dbAnswer(() => ({ data: [], error: null }));
  const a = await useDbAuthState('arm-2', 'test-secret');
  a.state.creds.me = { id: '972500000002@s.whatsapp.net' };
  await a.saveCreds();
  await a.flush();
  const dir = path.join(process.env.AUTH_DIR, 'arm-2');
  const good = fs.readFileSync(path.join(dir, 'creds'), 'utf8');
  fs.writeFileSync(path.join(dir, 'creds'), good.slice(0, 20)); // torn write
  const upserts = [];
  dbAnswer((op) => {
    if (op.table === 'arm_auth' && op.action === 'select') return { data: [{ key: 'creds', value: good }], error: null };
    if (op.table === 'arm_auth' && op.action === 'upsert') upserts.push(op.payload);
    return { data: [], error: null };
  });
  const b = await useDbAuthState('arm-2', 'test-secret');
  assert.equal(b.state.creds.me.id, '972500000002@s.whatsapp.net');
  assert.equal(fs.readFileSync(path.join(dir, 'creds'), 'utf8'), good, 'disk repaired');
  await b.flush();
  for (const batch of upserts) for (const r of batch) assert.notEqual(r.value, good.slice(0, 20), 'damaged copy never sent to backup');
});

// ---------- arms list (ק1) ----------
function fakeArm(id) {
  const arm = { id, name: id, stationId: 'st', destroyed: 0, stopped: 0, online: true };
  arm.destroy = async () => { arm.destroyed++; };
  arm.stop = async () => { arm.stopped++; };
  return arm;
}

test('arms: an empty or failed arms list never logs out any number', async () => {
  engine.arms.clear();
  const a1 = fakeArm('a1');
  const a2 = fakeArm('a2');
  engine.arms.set('a1', a1);
  engine.arms.set('a2', a2);
  dbAnswer((op) => (op.rpc === 'engine_station_states' ? { data: [{ id: 'st', allowed: true }], error: null } : { data: [], error: null }));
  for (let i = 0; i < 3; i++) await engine.reconcileArms();
  assert.equal(a1.destroyed + a2.destroyed, 0);
  dbAnswer(() => ({ data: null, error: { message: 'timeout' } }));
  await assert.rejects(engine.reconcileArms());
  assert.equal(a1.destroyed + a2.destroyed, 0);
  assert.equal(engine.arms.size, 2);
});

test('arms: an arm really deleted in the app is removed only after confirmation', async () => {
  engine.arms.clear();
  const a1 = fakeArm('a1');
  const gone = fakeArm('gone');
  engine.arms.set('a1', a1);
  engine.arms.set('gone', gone);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    let rowStillThere = true;
    dbAnswer((op) => {
      if (op.rpc === 'engine_station_states') return { data: [{ id: 'st', allowed: true }], error: null };
      if (op.table === 'arms' && op.maybeSingle) return { data: rowStillThere ? { id: 'gone' } : null, error: null };
      if (op.table === 'arms') return { data: [{ id: 'a1', name: 'a1', is_active: true, status: 'online', station_id: 'st' }], error: null };
      return { data: [], error: null };
    });
    await engine.reconcileArms();
    now += 31_000;
    await engine.reconcileArms();
    assert.equal(gone.destroyed, 0, 'row still in the database (list was partial) – kept');
    rowStillThere = false;
    await engine.reconcileArms(); // missing again, first sighting
    now += 31_000;
    await engine.reconcileArms();
    assert.equal(gone.destroyed, 1, 'confirmed deleted – removed');
    assert.equal(a1.destroyed, 0);
  } finally {
    Date.now = realNow;
  }
});

// ---------- sending (ח1) ----------
function sendingArm(sendImpl) {
  const arm = fakeArm('s1');
  arm.groupMeta = new Map();
  arm.ownJids = () => [];
  arm.sent = [];
  arm.send = async (jid, text, id) => {
    arm.sent.push({ jid, text, id });
    return sendImpl(arm.sent.length);
  };
  return arm;
}
const job = { target_id: 77, campaign_id: 'c', wa_group_id: 'g@g.us', final_text: 'נסיעה' };

test('send: success is recorded even through database hiccups', async () => {
  const arm = sendingArm(() => ({}));
  let fails = 2;
  const results = [];
  dbAnswer((op) => {
    if (op.rpc === 'claim_target_engine') return { data: [job], error: null };
    if (op.rpc === 'target_result_engine') {
      if (fails-- > 0) return { data: null, error: { message: 'db busy' } };
      results.push(op.args);
    }
    return { data: [], error: null };
  });
  await engine.sendOne(arm);
  assert.equal(arm.sent.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].p_ok, true);
});

test('send: an unconfirmed send (timeout) is never sent again', async () => {
  const arm = sendingArm(() => {
    const e = new Error('לא התקבל אישור');
    e.uncertain = true;
    throw e;
  });
  const updates = [];
  dbAnswer((op) => {
    if (op.rpc === 'claim_target_engine') return { data: [job], error: null };
    if (op.table === 'campaign_targets' && op.action === 'update') updates.push(op.payload);
    return { data: [], error: null };
  });
  await engine.sendOne(arm);
  assert.equal(arm.sent.length, 1, 'one attempt only');
  assert.equal(updates[0].status, 'failed');
  assert.ok(!ops.some((o) => o.action === 'update' && o.payload?.status === 'pending'), 'not put back in the queue');
});

test('send: retries after a short hiccup use the same WhatsApp message id', async () => {
  const arm = sendingArm((n) => {
    if (n < 3) throw new Error('Connection Closed');
    return {};
  });
  dbAnswer((op) => (op.rpc === 'claim_target_engine' ? { data: [job], error: null } : { data: [], error: null }));
  await engine.sendOne(arm);
  assert.equal(arm.sent.length, 3);
  assert.equal(new Set(arm.sent.map((s) => s.id)).size, 1, 'same id each time → recipients see one message');
  assert.equal(arm.sent[0].id, engine.msgIdFor(77, 's1'));
});

// ---------- connection handling ----------
test('arm: 403 from WhatsApp stops reconnecting and tells the manager; session kept', async () => {
  const updates = [];
  dbAnswer((op) => {
    if (op.table === 'arms' && op.action === 'update') updates.push(op.payload);
    return { data: [], error: null };
  });
  const arm = new Arm({ id: 'x403', name: 'x', station_id: 'st' }, () => {});
  const sock = {};
  arm.sock = sock;
  arm.stopped = false;
  arm.creds = { me: { id: '1@s.whatsapp.net' } };
  let cleared = 0;
  arm.auth = { flush: async () => {}, clear: async () => { cleared++; } };
  await arm.onConnectionUpdate(sock, { connection: 'close', lastDisconnect: { error: { output: { statusCode: 403 } } } });
  assert.equal(updates.at(-1).status, 'error');
  assert.equal(cleared, 0, 'nothing deleted');
  assert.ok(!arm.reconnectTimer, 'no reconnect scheduled');
});

test('arm: repeated 440 (opened elsewhere) stops after 3 times in 10 minutes', async () => {
  dbAnswer(() => ({ data: [], error: null }));
  const arm = new Arm({ id: 'x440', name: 'x', station_id: 'st' }, () => {});
  arm.creds = { me: { id: '1@s.whatsapp.net' } };
  arm.auth = { flush: async () => {}, clear: async () => {} };
  arm.start = async () => {};
  for (let i = 0; i < 3; i++) {
    const sock = {};
    arm.sock = sock;
    arm.stopped = false;
    clearTimeout(arm.reconnectTimer);
    arm.reconnectTimer = null;
    await arm.onConnectionUpdate(sock, { connection: 'close', lastDisconnect: { error: { output: { statusCode: 440 } } } });
  }
  assert.ok(!arm.reconnectTimer, 'third time: no more reconnects');
  assert.equal(arm.replaced.length, 3);
});

// ---------- backup (ח5) ----------
test('backup: whole database written to disk, restore SQL rebuilds the same rows', async () => {
  const backup = require('../src/backup');
  const rows = { stations: [{ id: 's1', name: 'תחנה' }], campaign_targets: Array.from({ length: 4500 }, (_, i) => ({ id: i + 1 })) };
  dbAnswer((op) => {
    if (op.rpc === 'engine_backup_rows') {
      const all = rows[op.args.p_table] || [];
      return { data: all.slice(op.args.p_offset, op.args.p_offset + op.args.p_limit), error: null };
    }
    return { data: [], error: null };
  });
  const { file, counts } = await backup.runBackup();
  assert.equal(counts.campaign_targets, 4500, 'paging reads every row');
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '../scripts/restore-sql.js'), file, '--schema', 'restore_check'], { encoding: 'utf8' });
  assert.match(out, /insert into "restore_check"\."stations" overriding system value/);
  assert.equal((out.match(/"campaign_targets" overriding/g) || []).length, 5, '1000 rows per statement');
  assert.match(out, /on conflict do nothing/, 'restore never overwrites existing rows');
});
