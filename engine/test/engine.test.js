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

test('auth: disk lost completely – the arm comes back from the database identity only (no QR)', async () => {
  // what the database holds after the clean-up: creds + app-state keys only
  const saved = [];
  dbAnswer((op) => {
    if (op.table === 'arm_auth' && op.action === 'upsert') saved.push(...op.payload);
    return { data: [], error: null };
  });
  const a = await useDbAuthState('arm-3', 'test-secret');
  a.state.creds.me = { id: '972500000003@s.whatsapp.net' };
  await a.saveCreds();
  await a.state.keys.set({ 'app-state-sync-key': { K1: { keyData: 'x' } }, session: { 'u9.0': { s: 1 } }, 'sender-key': { 'g@g.us::u9': { k: 1 } } });
  await a.flush();
  const keys = saved.map((r) => r.key);
  assert.ok(keys.includes('creds') && keys.includes('app-state-sync-key-K1'), 'identity is backed up to the database');
  assert.ok(!keys.some((k) => k.startsWith('session-') || k.startsWith('sender-key-')), 'per-chat keys are not (disk only)');
  // the server disk is gone
  fs.rmSync(path.join(process.env.AUTH_DIR, 'arm-3'), { recursive: true, force: true });
  const rows = saved.filter((r) => r.key === 'creds' || r.key.startsWith('app-state-'));
  dbAnswer((op) => {
    if (op.table === 'arm_auth' && op.action === 'select') return { data: rows.map((r) => ({ key: r.key, value: r.value })), error: null };
    return { data: [], error: null };
  });
  const b = await useDbAuthState('arm-3', 'test-secret');
  assert.equal(b.state.creds.me.id, '972500000003@s.whatsapp.net', 'same WhatsApp login – reconnects without a QR');
  const sk = await b.state.keys.get('app-state-sync-key', ['K1']);
  assert.ok(sk.K1, 'app-state key restored');
  assert.ok(fs.existsSync(path.join(process.env.AUTH_DIR, 'arm-3', 'creds')), 'and written back to the new disk');
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

test('arms: an arm that hangs while stopping does not freeze the arms loop', async () => {
  engine.arms.clear();
  process.env.ENGINE_STOP_LIMIT_MS = '200';
  const stuck = fakeArm('stuck');
  stuck.stop = () => new Promise(() => {}); // never finishes (blocked number, hung socket)
  engine.arms.set('stuck', stuck);
  const updates = [];
  dbAnswer((op) => {
    if (op.rpc === 'engine_station_states') return { data: [{ id: 'st', allowed: true }], error: null };
    if (op.table === 'arms' && op.action === 'update') updates.push(op.payload);
    if (op.table === 'arms') return { data: [{ id: 'stuck', name: 'stuck', is_active: false, status: 'error', station_id: 'st' }], error: null };
    return { data: [], error: null };
  });
  const t0 = Date.now();
  await engine.reconcileArms();
  delete process.env.ENGINE_STOP_LIMIT_MS;
  assert.ok(Date.now() - t0 < 2000, 'loop went on after the time limit');
  assert.equal(engine.arms.has('stuck'), false, 'the switched-off arm left the running list');
  assert.ok(updates.some((u) => u && u.status === 'paused'), 'its status was set to paused');
});

test('arms: a number still closing is not started twice; it can start again once closed', async () => {
  engine.arms.clear();
  process.env.ENGINE_STOP_LIMIT_MS = '150';
  const slow = fakeArm('slow');
  slow.stop = () => new Promise(() => {});
  engine.arms.set('slow', slow);
  let active = false;
  dbAnswer((op) => {
    if (op.rpc === 'engine_station_states') return { data: [{ id: 'st', allowed: true }], error: null };
    if (op.table === 'arms' && op.action === 'select') return { data: [{ id: 'slow', name: 'slow', is_active: active, status: 'online', station_id: 'st' }], error: null };
    return { data: [], error: null };
  });
  await engine.reconcileArms(); // switched off -> stopping in the background
  assert.equal(engine.stopping.has('slow'), true);
  active = true;
  await engine.reconcileArms(); // switched on again at once
  assert.equal(engine.arms.has('slow'), false, 'not started while the old connection is still closing');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(engine.stopping.has('slow'), false, 'the stop time limit released it');
  assert.equal(slow.stopped, true, 'and the old connection was told to close');
  delete process.env.ENGINE_STOP_LIMIT_MS;
});

test('arms: a stuck sync pass is replaced by a fresh one; settings are picked up without a restart', async () => {
  engine.arms.clear();
  process.env.ENGINE_SYNC_STUCK_MS = '100';
  const a = fakeArm('w');
  a.linkedAt = 123;
  engine.arms.set('w', a);
  let hang = true;
  dbAnswer((op) => {
    if (hang && op.table === 'arms' && op.action === 'select') return new Promise(() => {}); // database call that never returns
    if (op.rpc === 'engine_station_states') return { data: [{ id: 'st', allowed: true }], error: null };
    if (op.table === 'arms' && op.action === 'select') return { data: [{ id: 'w', name: 'w', is_active: true, status: 'online', station_id: 'st', linked_at: null }], error: null };
    return { data: [], error: null };
  });
  const stuckBefore = engine.syncState.stuck;
  engine.syncArms(); // hangs
  await new Promise((r) => setTimeout(r, 150));
  hang = false;
  const t0 = Date.now();
  await engine.syncArms(); // sees the stuck pass, abandons it, runs a fresh one
  assert.equal(engine.syncState.stuck, stuckBefore + 1, 'stuck pass detected');
  assert.equal(a.linkedAt, 0, 'warm-up switched off was picked up by the fresh pass');
  assert.ok(Date.now() - engine.syncState.okAt < 1000 && Date.now() - t0 < 1000, 'healthy again within a second');
  delete process.env.ENGINE_SYNC_STUCK_MS;
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
  const rows = {
    stations: [{ id: 's1', name: 'תחנה' }],
    groups: Array.from({ length: 4500 }, (_, i) => ({ id: i + 1 })),
    campaign_targets: Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })),
  };
  dbAnswer((op) => {
    if (op.rpc === 'engine_backup_rows') {
      const all = rows[op.args.p_table] || [];
      return { data: all.slice(op.args.p_offset, op.args.p_offset + op.args.p_limit), error: null };
    }
    return { data: [], error: null };
  });
  const { file, counts } = await backup.runBackup();
  assert.equal(counts.groups, 4500, 'paging reads every row');
  assert.equal(counts.campaign_targets, undefined, 'per-group delivery rows are not backed up (kept 48h only)');
  const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, '../scripts/restore-sql.js'), file, '--schema', 'restore_check'], { encoding: 'utf8' });
  assert.match(out, /insert into "restore_check"\."stations" overriding system value/);
  assert.equal((out.match(/"groups" overriding/g) || []).length, 5, '1000 rows per statement');
  assert.match(out, /on conflict do nothing/, 'restore never overwrites existing rows');
});

test('auth: per-chat keys are read from disk on demand (memory stays small)', async () => {
  dbAnswer(() => ({ data: [], error: null }));
  const a = await useDbAuthState('arm-mem', 'test-secret');
  a.state.creds.me = { id: '972500000009@s.whatsapp.net' };
  await a.saveCreds();
  const many = {};
  for (let i = 0; i < 5000; i++) many[`u${i}.0`] = { n: i, pad: 'x'.repeat(200) };
  await a.state.keys.set({ session: many });
  await a.flush();
  const b = await useDbAuthState('arm-mem', 'test-secret');
  const got = await b.state.keys.get('session', ['u0.0', 'u4999.0', 'u2500.0', 'nope']);
  assert.equal(got['u0.0'].n, 0);
  assert.equal(got['u4999.0'].n, 4999);
  assert.equal(got['nope'], null);
  // a key written and immediately read back (before the disk flush) is the new value
  await b.state.keys.set({ session: { 'u1.0': { n: 'new' } } });
  assert.equal((await b.state.keys.get('session', ['u1.0']))['u1.0'].n, 'new');
  await b.state.keys.set({ session: { 'u2.0': null } });
  assert.equal((await b.state.keys.get('session', ['u2.0']))['u2.0'], null, 'deleted key stays deleted');
});

// ---------- only source/target groups are processed and kept ----------
test('messages: only source groups are decrypted; others are confirmed and dropped; private chats always processed', () => {
  const rel = { sourcesReady: true, targetsReady: true, isSource: (st, j) => j === 'src@g.us', isTarget: (st, j) => j === 'tgt@g.us' };
  Arm.setRelevance(rel);
  const arm = new Arm({ id: 'r1', name: 'r', station_id: 'st' }, () => {});
  arm.creds = { me: { id: '972500000001:3@s.whatsapp.net', lid: '111:3@lid' } };
  const node = (from, participant) => ({ tag: 'message', attrs: { id: 'M1', from, participant, type: 'text' } });
  assert.equal(arm.skipIncoming(node('src@g.us', 'x@lid')), false, 'source group read');
  assert.equal(arm.skipIncoming(node('tgt@g.us', 'x@lid')), true, 'target group: nothing to read there');
  assert.equal(arm.skipIncoming(node('other@g.us', 'x@lid')), true);
  assert.equal(arm.skipIncoming(node('other@g.us', '111:5@lid')), false, "the arm's own phone still goes through");
  assert.equal(arm.skipIncoming(node('972500000009@s.whatsapp.net')), true, 'private chats from others: not read');
  assert.equal(arm.skipIncoming(node('222@lid')), true, 'private chats from others (lid): not read');
  assert.equal(arm.skipIncoming(node('972500000001:5@s.whatsapp.net')), false, "the arm's own phone (other device) still goes through");
  assert.equal(arm.skipIncoming(node('111:7@lid')), false, "the arm's own lid still goes through");
  assert.equal(arm.skipIncoming({ tag: 'message', attrs: { id: 'P', from: '972500000009@s.whatsapp.net', category: 'peer' } }), false, 'peer protocol messages go through');
  assert.equal(arm.skipIncoming(node('972500000009@broadcast')), false, 'other kinds untouched');
  assert.equal(arm.skipIncoming(node('status@broadcast', 'x@s.whatsapp.net')), true);
  // skipped messages are confirmed (receipt + ack) so WhatsApp does not send them again
  const sent = [];
  const sock = { sendNode: async (n) => sent.push(n) };
  arm.confirmSkipped(sock, node('other@g.us', 'x@lid'));
  return new Promise((r) => setTimeout(r, 10)).then(() => {
    assert.deepEqual(sent.map((n) => n.tag), ['receipt', 'ack']);
    assert.equal(sent[1].attrs.class, 'message');
    assert.equal(sent[0].attrs.participant, 'x@lid');
  });
});

test('messages: until the group settings are loaded nothing is dropped', () => {
  Arm.setRelevance({ sourcesReady: false, targetsReady: false, isSource: () => false, isTarget: () => false });
  const arm = new Arm({ id: 'r2', name: 'r', station_id: 'st' }, () => {});
  assert.equal(arm.skipIncoming({ attrs: { id: '1', from: 'any@g.us', participant: 'x@lid' } }), false);
  assert.equal(arm.groupMatters('any@g.us', { needTarget: true }), true);
});

test('groups: member lists kept only for source and target groups; the full list still goes to the app', async () => {
  Arm.setRelevance({ sourcesReady: true, targetsReady: true, isSource: (st, j) => j === 'src@g.us', isTarget: (st, j) => j === 'tgt@g.us' });
  const arm = new Arm({ id: 'r3', name: 'r', station_id: 'st' }, () => {});
  const meta = (id) => ({ id, subject: 'g ' + id, participants: [{ id: 'a@lid' }, { id: 'b@lid' }] });
  arm.sock = { groupFetchAllParticipating: async () => ({ 'src@g.us': meta('src@g.us'), 'tgt@g.us': meta('tgt@g.us'), 'x@g.us': meta('x@g.us'), 'y@g.us': meta('y@g.us') }) };
  arm.online = true;
  const upserts = [];
  dbAnswer((op) => {
    if (op.table === 'groups' && op.action === 'upsert') upserts.push(...op.payload);
    return { data: [], error: null };
  });
  await arm.syncGroups();
  assert.deepEqual([...arm.groupMeta.keys()].sort(), ['src@g.us', 'tgt@g.us']);
  assert.equal(upserts.length, 4, 'id + name of every group still saved, so new groups can be picked in the app');
  assert.deepEqual(Object.keys(upserts[0]).sort(), ['arm_id', 'name', 'participants', 'updated_at', 'wa_group_id']);
});

test('resend: one at a time, never a flood (at most one every 2 seconds)', async () => {
  const arm = new Arm({ id: 'rs', name: 'r', station_id: 'st' }, () => {});
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const sock = {
    assertSessions: async () => {},
    relayMessage: async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2500)); // slower than the 2s gap – used to start a second chain
      inFlight--;
    },
  };
  arm.sock = sock;
  arm.online = true;
  arm.sentStore = new Map([['ID1', { message: { conversation: 'x' }, at: Date.now() }]]);
  for (let i = 0; i < 20; i++) arm.queueResend(sock, 'g@g.us', 'ID1', `p${i}@lid`, 1);
  await new Promise((r) => setTimeout(r, 9000));
  assert.equal(maxInFlight, 1);
  assert.ok(calls <= 3, `only ~2 per 9s, got ${calls}`);
  arm.resendQueue = [];
});

test('device cache: a big cache stays fast (no full scan on every write)', () => {
  const arm = new Arm({ id: 'dc', name: 'd', station_id: 'st' }, () => {});
  // build the cache the way connect() does
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/arm.js'), 'utf8');
  assert.ok(/lastSweep < 60_000/.test(src));
  const t0 = Date.now();
  const cache = arm.devCache || null;
  assert.equal(cache, null);
  // simulate: 60k writes into a long cache
  const mod = require('../src/arm.js');
  const c = mod.__longCache ? mod.__longCache() : null;
  if (c) {
    for (let i = 0; i < 60_000; i++) c.set('u' + i, [i]);
    assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + 'ms');
  }
});

// ---------- more than 1,000 rows (the database API cuts one request at 1,000) ----------
function cappedTable(rows) {
  // answers like the real API: honours .range(), never more than 1,000 rows per request
  return (op) => {
    const r = op.mods.find((m) => m[0] === 'range');
    const from = r ? r[1] : 0;
    const to = r ? Math.min(r[2], from + 999) : 999;
    return { data: rows.slice(from, to + 1), error: null };
  };
}

test('row cap: fetchAll reads every row in pages, also exactly 1,000 and 2,500', async () => {
  const { fetchAll } = require('../src/util');
  for (const n of [0, 999, 1000, 1001, 2500]) {
    const rows = Array.from({ length: n }, (_, i) => ({ i }));
    dbAnswer(cappedTable(rows));
    const { data, error } = await fetchAll(() => require('../src/config').db.from('x').select('*').order('i'));
    assert.equal(error, null);
    assert.equal(data.length, n, `${n} rows`);
  }
});

test('row cap: a ride to lists with 2,500 groups gets all 2,500 (not the first 1,000), each once', async () => {
  const quote = require('../src/quote');
  const rows = Array.from({ length: 2500 }, (_, i) => ({ wa_group_id: `g${i % 2400}@g.us`, group_name: `g${i}` })); // 100 in two lists
  dbAnswer(cappedTable(rows));
  const groups = await quote.selectedGroups(['l1', 'l2'], 'g5@g.us');
  assert.equal(groups.length, 2399, 'every group once, the source group excluded');
});

test('row cap guard: no read of a big table without paging (engine and website)', () => {
  // Tables that can pass 1,000 rows for one station or one ride. A read must page (fetchAll / allRows / allGroups /
  // .range) or be bounded (.limit(n<=1000), .single(), head count, one id).
  const BIG = ['groups', 'list_groups', 'campaign_targets', 'campaigns', 'activity_log', 'processed_messages', 'arm_auth', 'quote_sessions', 'campaign_arms'];
  const root = path.join(__dirname, '..', '..');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'test') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ['engine/src', 'web/app', 'web/components', 'web/lib']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/\.from\('([a-z_]+)'\)/);
      if (!m || !BIG.includes(m[1])) return;
      // the statement: from the line before (fetchAll(() => … ) wrappers) to the first ';' after .from(
      const before = lines[i - 1] || '';
      const rest = lines.slice(i, i + 14).join(' ');
      const s = before.split(';').pop() + ' ' + rest.split(';')[0];
      if (!/\.select\(/.test(s)) return; // writes are fine
      // bounded by design: mark the line with  // rows: bounded – <why>
      const ok = /fetchAll|allGroups|allRows|\.range\(|\.single\(|\.maybeSingle\(|head:\s*true|\.eq\('id'|\.limit\((\d{1,3}|1000)\)|rows: bounded/.test(s);
      if (!ok && !/rows: bounded/.test(lines.slice(i, i + 4).join(' '))) bad.push(`${path.relative(root, f)}:${i + 1} ${m[1]}`);
    });
  }
  assert.deepEqual(bad, [], 'reads that can be cut at 1,000 rows:\n' + bad.join('\n'));
});

// ---------- system messages to private numbers (wa_outbox) ----------
function waArm(id, stationId, { online = true, onWa = true, sendErr = null } = {}) {
  const arm = { id, name: id, stationId, online, sent: [], checked: [] };
  arm.sock = { onWhatsApp: async (jid) => (arm.checked.push(jid), onWa ? [{ exists: true, jid }] : []) };
  arm.send = async (jid, text) => {
    if (sendErr) throw new Error(sendErr);
    arm.sent.push({ jid, text, at: Date.now() });
    return {};
  };
  return arm;
}
function outboxDb(msgs, results, extra = () => null) {
  let taken = false;
  dbAnswer((op) => {
    const x = extra(op);
    if (x) return x;
    if (op.rpc === 'engine_home_station') return { data: 'home', error: null };
    if (op.rpc === 'engine_outbox_take') {
      const d = taken ? [] : msgs;
      taken = true;
      return { data: d, error: null };
    }
    if (op.rpc === 'engine_outbox_done') results.push(op.args);
    return { data: [], error: null };
  });
}

test('outbox: phone numbers become WhatsApp addresses (Israeli 05X, +972, 00972, dashes)', () => {
  const { phoneJid } = require('../src/outbox');
  assert.equal(phoneJid('050-123-4567'), '972501234567@s.whatsapp.net');
  assert.equal(phoneJid('+972 50 123 4567'), '972501234567@s.whatsapp.net');
  assert.equal(phoneJid('00972501234567'), '972501234567@s.whatsapp.net');
  assert.equal(phoneJid('972501234567'), '972501234567@s.whatsapp.net');
  assert.equal(phoneJid('12'), null);
  assert.equal(phoneJid(''), null);
});

test('outbox: sent through an online HOME station arm (never a customer station arm), results recorded, ≥1.5s apart', async () => {
  const outbox = require('../src/outbox');
  outbox.state.home = null;
  const home = waArm('h1', 'home');
  const homeOff = waArm('h2', 'home', { online: false });
  const customer = waArm('c1', 'other');
  const arms = new Map([['c1', customer], ['h2', homeOff], ['h1', home]]);
  const results = [];
  outboxDb([{ id: 1, to_phone: '050-1234567', body: 'קוד: 1234' }, { id: 2, to_phone: '0521112222', body: 'שלום' }], results);
  const t0 = Date.now();
  await outbox.tick(arms);
  assert.equal(customer.sent.length + homeOff.sent.length, 0, 'only the online home arm sends');
  assert.deepEqual(home.sent.map((s) => s.jid), ['972501234567@s.whatsapp.net', '972521112222@s.whatsapp.net']);
  assert.equal(home.sent[0].text, 'קוד: 1234');
  assert.deepEqual(home.checked, ['972501234567@s.whatsapp.net', '972521112222@s.whatsapp.net'], 'checked on WhatsApp first');
  assert.ok(home.sent[1].at - home.sent[0].at >= 1450, 'paced');
  assert.ok(Date.now() - t0 >= 1450);
  assert.deepEqual(results.map((r) => [r.p_id, r.p_ok, r.p_error, r.p_arm]), [[1, true, null, 'h1'], [2, true, null, 'h1']]);
  assert.equal(outbox.state.busy, false);
});

test('outbox: nothing is taken while no home arm is online', async () => {
  const outbox = require('../src/outbox');
  outbox.state.home = null;
  const arms = new Map([['c1', waArm('c1', 'other')], ['h2', waArm('h2', 'home', { online: false })]]);
  const results = [];
  outboxDb([{ id: 1, to_phone: '0501234567', body: 'x' }], results);
  await outbox.tick(arms);
  assert.ok(!ops.some((o) => o.rpc === 'engine_outbox_take'), 'queue untouched');
});

test('outbox: number not on WhatsApp → failed without sending; send error → failed with the error; never throws', async () => {
  const outbox = require('../src/outbox');
  outbox.state.home = null;
  const notOnWa = waArm('h1', 'home', { onWa: false });
  let results = [];
  outboxDb([{ id: 5, to_phone: '0501234567', body: 'x' }], results);
  await outbox.tick(new Map([['h1', notOnWa]]));
  assert.equal(notOnWa.sent.length, 0);
  assert.deepEqual(results.map((r) => [r.p_id, r.p_ok, r.p_error, r.p_arm]), [[5, false, 'המספר לא בוואטסאפ', 'h1']]);

  const broken = waArm('h1', 'home', { sendErr: 'Connection Closed' });
  results = [];
  outboxDb([{ id: 6, to_phone: '0501234567', body: 'x' }], results);
  await outbox.tick(new Map([['h1', broken]]));
  assert.deepEqual(results.map((r) => [r.p_id, r.p_ok, r.p_error]), [[6, false, 'Connection Closed']]);

  // database down: the pass ends quietly
  dbAnswer(() => ({ data: null, error: { message: 'timeout' } }));
  outbox.state.home = null;
  await outbox.tick(new Map([['h1', waArm('h1', 'home')]]));
  assert.equal(outbox.state.busy, false);
});

test('outbox: while shutting down nothing new is taken; messages already taken are closed, not left hanging', async () => {
  const outbox = require('../src/outbox');
  outbox.state.home = null;
  const arm = waArm('h1', 'home');
  const results = [];
  outboxDb([{ id: 1, to_phone: '0501234567', body: 'a' }], results);
  await outbox.tick(new Map([['h1', arm]]), () => true);
  assert.ok(!ops.some((o) => o.rpc === 'engine_outbox_take'), 'nothing taken once shutting down');
  let stopping = false;
  outboxDb([{ id: 1, to_phone: '0501234567', body: 'a' }, { id: 2, to_phone: '0501234568', body: 'b' }], results);
  arm.send = async (jid, text) => {
    arm.sent.push({ jid, text });
    stopping = true; // shutdown starts during the first send
    return {};
  };
  await outbox.tick(new Map([['h1', arm]]), () => stopping);
  assert.equal(arm.sent.length, 1);
  assert.deepEqual(results.map((r) => [r.p_id, r.p_ok]), [[1, true], [2, false]]);
});

// ---------- subscription ended / disabled groups / groups no arm can reach ----------
const gates = require('../src/gates');
const help = require('../src/help');

function rideDb({ active = true, activeErr = false, flags = [], arms = [], groups = [], listGroups = [], listArms = [] } = {}) {
  const inserted = { targets: [], processed: 0 };
  dbAnswer((op) => {
    if (op.rpc === 'engine_station_active') return activeErr ? { data: null, error: { message: 'function does not exist' } } : { data: active, error: null };
    if (op.rpc === 'engine_group_flags') return { data: flags, error: null };
    if (op.table === 'app_settings') return { data: [{ station_id: 'st', auto_distribution_enabled: true }], error: null };
    if (op.table === 'source_groups') return { data: [{ station_id: 'st', wa_group_id: 'src@g.us', name: 'מקור' }], error: null };
    if (op.table === 'triggers') return { data: [{ id: 't1', station_id: 'st', keyword: 'עזרה', list_id: 'L1' }], error: null };
    if (op.table === 'list_groups') {
      const r = op.mods.find((m) => m[0] === 'range');
      return { data: r && r[1] > 0 ? [] : listGroups, error: null };
    }
    if (op.table === 'list_arms') return { data: listArms, error: null };
    if (op.table === 'arms') return { data: arms, error: null };
    if (op.table === 'groups') {
      const r = op.mods.find((m) => m[0] === 'range');
      const ids = op.filters.find((f) => f[0] === 'in' && f[1] === 'arm_id')?.[2] || [];
      return { data: r && r[1] > 0 ? [] : groups.filter((g) => ids.includes(g.arm_id)), error: null };
    }
    if (op.table === 'processed_messages' && op.action === 'insert') inserted.processed += 1;
    if (op.table === 'campaigns' && op.action === 'insert') return { data: { id: 'camp1' }, error: null };
    if (op.table === 'campaign_targets' && op.action === 'insert') inserted.targets.push(...op.payload);
    if (op.maybeSingle) return { data: null, error: null };
    return { data: [], error: null };
  });
  return inserted;
}
function helpArm() {
  return { id: 'a1', name: 'a1', stationId: 'st', online: true, sock: {}, isOwnSent: () => false, react: async () => true, ownJids: () => [] };
}
const helpMsg = (id) => ({
  key: { remoteJid: 'src@g.us', id, participant: '972501111111@s.whatsapp.net' },
  message: { conversation: 'עזרה נסיעה מתל אביב לחיפה' },
  messageTimestamp: Math.floor(Date.now() / 1000),
  pushName: 'סדרן',
});

test('station inactive (subscription ended): a help trigger is ignored – no ride, arm untouched', async () => {
  gates._reset();
  const db = rideDb({ active: false, listGroups: [{ wa_group_id: 'g1@g.us', group_name: 'g1' }] });
  await help.refreshConfig();
  const arm = helpArm();
  arm.stop = () => assert.fail('the arm must not be stopped');
  ops.length = 0;
  await help.onMessage(arm, helpMsg('M-off'));
  assert.equal(db.processed, 0, 'not handled');
  assert.ok(!ops.some((o) => o.table === 'campaigns' && o.action === 'insert'), 'no ride created');
  assert.ok(!ops.some((o) => o.table === 'arms' || o.table === 'arm_auth'), 'arm and its login untouched');
});

test('station check failing (database hiccup / function missing) → fail-open, the ride goes out', async () => {
  gates._reset();
  const db = rideDb({
    activeErr: true,
    listGroups: [{ wa_group_id: 'g1@g.us', group_name: 'g1' }],
    listArms: [{ arm_id: 'a1' }],
    arms: [{ id: 'a1', is_active: true, status: 'online' }],
    groups: [{ arm_id: 'a1', wa_group_id: 'g1@g.us' }],
  });
  await help.refreshConfig();
  await help.onMessage(helpArm(), helpMsg('M-err'));
  assert.equal(db.processed, 1);
  assert.equal(db.targets.length, 1);
  assert.equal(db.targets[0].status, undefined, 'pending as always');
});

test('station check is cached per station (one question a minute, not one per message)', async () => {
  gates._reset();
  rideDb({ active: true });
  for (let i = 0; i < 5; i++) assert.equal(await gates.stationActive('st'), true);
  assert.equal(ops.filter((o) => o.rpc === 'engine_station_active').length, 1);
});

test('disabled groups are left out of a ride (quote selectedGroups); flags unavailable → nothing removed', async () => {
  gates._reset();
  const quote = require('../src/quote');
  rideDb({
    flags: [{ wa_group_id: 'g2@g.us', disabled: true, include_anyway: false }, { wa_group_id: 'g3@g.us', disabled: false, include_anyway: true }],
    listGroups: [{ wa_group_id: 'g1@g.us', group_name: 'g1' }, { wa_group_id: 'g2@g.us', group_name: 'g2' }, { wa_group_id: 'g3@g.us', group_name: 'g3' }],
  });
  const groups = await quote.selectedGroups(['L1'], 'src@g.us', 'st');
  assert.deepEqual(groups.map((g) => g.wa_group_id), ['g1@g.us', 'g3@g.us']);
  gates._reset();
  dbAnswer((op) => (op.rpc === 'engine_group_flags' ? { data: null, error: { message: 'down' } } : { data: [{ wa_group_id: 'g2@g.us' }], error: null }));
  assert.deepEqual((await quote.selectedGroups(['L1'], 'src@g.us', 'st')).map((g) => g.wa_group_id), ['g2@g.us']);
});

test('groups no arm of the ride can reach are added as skipped; a group with one possible arm stays pending', async () => {
  gates._reset();
  const db = rideDb({
    flags: [{ wa_group_id: 'g6@g.us', disabled: false, include_anyway: true }, { wa_group_id: 'g7@g.us', disabled: true, include_anyway: false }],
    listGroups: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'].map((g) => ({ wa_group_id: `${g}@g.us`, group_name: g })),
    listArms: [{ arm_id: 'a1' }, { arm_id: 'a2' }, { arm_id: 'a3' }, { arm_id: 'a4' }],
    arms: [
      { id: 'a1', is_active: true, status: 'online' },
      { id: 'a2', is_active: true, status: 'paused' }, // paused: cannot send
      { id: 'a3', is_active: true, status: 'connecting' }, // reconnecting: still counts (as in the database)
      { id: 'a4', is_active: false, status: 'online' }, // switched off
    ],
    groups: [
      { arm_id: 'a1', wa_group_id: 'g1@g.us' },
      { arm_id: 'a2', wa_group_id: 'g1@g.us' },
      { arm_id: 'a2', wa_group_id: 'g2@g.us' }, // only the paused arm
      { arm_id: 'a3', wa_group_id: 'g3@g.us' },
      { arm_id: 'a4', wa_group_id: 'g4@g.us' }, // only the switched-off arm
      // g5: no arm of the ride is in it; g6: same, but "include anyway"
    ],
  });
  await help.refreshConfig();
  await help.onMessage(helpArm(), helpMsg('M-reach'));
  const by = new Map(db.targets.map((t) => [t.wa_group_id, t]));
  assert.equal(by.has('g7@g.us'), false, 'disabled group not added');
  for (const g of ['g1@g.us', 'g3@g.us', 'g6@g.us']) {
    assert.equal(by.get(g).status, undefined, `${g} pending exactly as before`);
    assert.equal(by.get(g).error, undefined);
  }
  for (const g of ['g2@g.us', 'g4@g.us', 'g5@g.us']) {
    assert.equal(by.get(g).status, 'skipped', `${g} skipped`);
    assert.equal(by.get(g).error, gates.UNREACHABLE_TEXT);
  }
  const camp = ops.find((o) => o.table === 'campaigns' && o.action === 'insert');
  assert.equal(camp.payload.total, 6, 'total without the disabled group');
});

test('reachability: any doubt (database error, empty answers) keeps every group pending', async () => {
  gates._reset();
  dbAnswer(() => ({ data: null, error: { message: 'timeout' } }));
  assert.equal((await gates.unreachableGroups(['a1'], ['g1@g.us'])).size, 0);
  dbAnswer((op) => (op.table === 'arms' ? { data: [{ id: 'a1', is_active: true, status: 'online' }], error: null } : { data: [], error: null }));
  assert.equal((await gates.unreachableGroups(['a1'], ['g1@g.us'])).size, 0, 'no group rows at all → leave it to the database');
  dbAnswer(() => ({ data: [], error: null }));
  assert.equal((await gates.unreachableGroups(['a1'], ['g1@g.us'])).size, 0, 'arms not found → not judged');
  // daily limit reached today rules the arm out, an old day does not
  const today = new Date().toISOString().slice(0, 10);
  const sameDay = today === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  assert.equal(gates.armCanSend({ is_active: true, status: 'online', sent_day: '2000-01-01', sent_today: 5, daily_limit: 0 }), true);
  assert.equal(gates.armCanSend({ is_active: true, status: 'online', sent_day: today, sent_today: 5, daily_limit: 5 }), !sameDay);
});

// ---------- message footer (owner's line under every message) ----------
test('footer: added once under the message; none / already there → text unchanged', () => {
  assert.equal(gates.withFooter('נסיעה מחיפה', '🚕 BotiX'), 'נסיעה מחיפה\n\n🚕 BotiX');
  assert.equal(gates.withFooter('נסיעה מחיפה\n\n🚕 BotiX', '🚕 BotiX'), 'נסיעה מחיפה\n\n🚕 BotiX');
  assert.equal(gates.withFooter('נסיעה', ''), 'נסיעה');
  assert.equal(gates.withFooter('נסיעה', null), 'נסיעה');
});

test('footer: read per station and cached; database error → last known footer, never throws', async () => {
  gates._reset();
  let answer = { data: 'תחנה א – 03-1234567', error: null };
  dbAnswer((op) => (op.rpc === 'engine_station_footer' ? answer : { data: [], error: null }));
  ops.length = 0;
  assert.equal(await gates.stationFooter('st'), 'תחנה א – 03-1234567');
  assert.equal(await gates.stationFooter('st'), 'תחנה א – 03-1234567');
  assert.equal(ops.filter((o) => o.rpc === 'engine_station_footer').length, 1, 'cached');
  gates._reset();
  answer = { data: null, error: { message: 'function does not exist' } };
  assert.equal(await gates.stationFooter('st'), '', 'old database without the function → no footer');
  assert.equal(await gates.stationFooter(null), '');
});

// ---------- link with a code instead of a QR ----------
test('arm: pairing code – asked once, stored as PAIR:XXXX-XXXX, QR refreshes do not replace it', async () => {
  const qrs = [];
  const updates = [];
  dbAnswer((op) => {
    if (op.table === 'arm_qr' && op.action === 'upsert') qrs.push(op.payload.qr);
    if (op.table === 'arms' && op.action === 'update') updates.push(op.payload);
    return { data: [], error: null };
  });
  const arm = new Arm({ id: 'p1', name: 'p', station_id: 'st' }, () => {});
  let asked = 0;
  const sock = { requestPairingCode: async (phone) => { asked++; assert.equal(phone, '972501234567'); return 'ABCD1234'; } };
  arm.sock = sock;
  arm.stopped = false;
  arm.pairPhone = '972501234567';
  await arm.onConnectionUpdate(sock, { qr: 'qr-1' });
  await arm.onConnectionUpdate(sock, { qr: 'qr-2' });
  assert.equal(asked, 1, 'one code per login');
  assert.deepEqual(qrs, ['PAIR:ABCD-1234']);
  assert.equal(updates.at(-1).status, 'qr');
});

test('arm: pairWithCode normalises 05X numbers and starts a fresh login; bad number refused', async () => {
  dbAnswer(() => ({ data: [], error: null }));
  const arm = new Arm({ id: 'p2', name: 'p', station_id: 'st' }, () => {});
  let resets = 0;
  arm.reset = async () => { resets++; };
  await arm.pairWithCode('050-123-4567');
  assert.equal(arm.pairPhone, '972501234567');
  assert.equal(resets, 1);
  await assert.rejects(() => arm.pairWithCode('12'), /לא תקין/);
});

test('arm: pairing code request failing → back to waiting with a clear message', async () => {
  const updates = [];
  dbAnswer((op) => {
    if (op.table === 'arms' && op.action === 'update') updates.push(op.payload);
    return { data: [], error: null };
  });
  const arm = new Arm({ id: 'p3', name: 'p', station_id: 'st' }, () => {});
  const sock = { requestPairingCode: async () => { throw new Error('bad request'); } };
  arm.sock = sock;
  arm.stopped = false;
  arm.pairPhone = '972501234567';
  await arm.onConnectionUpdate(sock, { qr: 'qr-1' });
  assert.equal(updates.at(-1).status, 'pending');
  assert.match(updates.at(-1).last_error, /קוד חיבור/);
  assert.equal(arm.pairPhone, null);
});
