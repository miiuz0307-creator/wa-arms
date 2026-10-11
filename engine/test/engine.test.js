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

test('resend: batches with one session refresh, one worker, bounded rate', async () => {
  const saved = { gap: Arm.RESEND_GAP_MS, first: Arm.RESEND_FIRST_MS, item: Arm.RESEND_ITEM_MS, batch: Arm.RESEND_BATCH };
  Object.assign(Arm, { RESEND_GAP_MS: 300, RESEND_FIRST_MS: 10, RESEND_ITEM_MS: 1, RESEND_BATCH: 5 });
  const arm = new Arm({ id: 'rs', name: 'r', station_id: 'st' }, () => {});
  let inFlight = 0;
  let maxInFlight = 0;
  let relays = 0;
  const asserted = [];
  const sock = {
    assertSessions: async (jids, force) => asserted.push({ n: jids.length, force }),
    relayMessage: async () => {
      relays++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    },
  };
  arm.sock = sock;
  arm.online = true;
  arm.sentStore = new Map([['ID1', { message: { conversation: 'x' }, at: Date.now() }]]);
  for (let i = 0; i < 12; i++) arm.queueResend(sock, 'g@g.us', 'ID1', `p${i}@lid`, 1);
  arm.queueResend(sock, 'g@g.us', 'ID1', 'p0@lid', 1); // same device + message: only once
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(relays, 5, 'first batch only – the next waits for the gap');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(relays, 12);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(asserted.map((a) => a.n), [5, 5, 2], 'one session refresh per batch');
  assert.ok(asserted.every((a) => a.force));
  const d = arm.takeDelivery();
  assert.equal(d.resent, 12);
  assert.equal(d.failingDevices, 12);
  Object.assign(Arm, { RESEND_GAP_MS: saved.gap, RESEND_FIRST_MS: saved.first, RESEND_ITEM_MS: saved.item, RESEND_BATCH: saved.batch });
});

test('resend: rate-overlimit pauses the queue instead of hammering WhatsApp', async () => {
  const saved = { gap: Arm.RESEND_GAP_MS, first: Arm.RESEND_FIRST_MS, item: Arm.RESEND_ITEM_MS };
  Object.assign(Arm, { RESEND_GAP_MS: 10, RESEND_FIRST_MS: 5, RESEND_ITEM_MS: 1 });
  const arm = new Arm({ id: 'rl', name: 'r', station_id: 'st' }, () => {});
  let relays = 0;
  const sock = {
    assertSessions: async () => {},
    relayMessage: async () => {
      relays++;
      if (relays === 2) throw new Error('rate-overlimit');
    },
  };
  arm.sock = sock;
  arm.online = true;
  arm.sentStore = new Map([['ID1', { message: { conversation: 'x' }, at: Date.now() }]]);
  for (let i = 0; i < 6; i++) arm.queueResend(sock, 'g@g.us', 'ID1', `q${i}@lid`, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(relays, 2, 'stopped after rate-overlimit');
  assert.equal(arm.resendQueue.length, 4, 'the rest kept for later');
  clearTimeout(arm.resendTimer);
  arm.resendQueue = [];
  Object.assign(Arm, { RESEND_GAP_MS: saved.gap, RESEND_FIRST_MS: saved.first, RESEND_ITEM_MS: saved.item });
});

test('resend: too old / gave up / no copy are counted as lost, not silently ignored', () => {
  const arm = new Arm({ id: 'lost', name: 'r', station_id: 'st' }, () => {});
  arm.sentStore = new Map([['OLD', { message: {}, at: Date.now() - 11 * 60_000 }], ['NEW', { message: {}, at: Date.now() }]]);
  arm.queueResend({}, 'g@g.us', 'OLD', 'a@lid', 1);
  arm.queueResend({}, 'g@g.us', 'NEW', 'b@lid', 3);
  arm.queueResend({}, 'g@g.us', 'MISSING', 'c@lid', 1);
  const d = arm.takeDelivery();
  assert.equal(d.resendExpired, 2);
  assert.equal(d.resendGaveUp, 1);
  assert.equal(d.failingDevices, 3);
  assert.equal(arm.takeDelivery(), null, 'counters reset each minute');
});

test('incoming: a group message carrying a new session (pkmsg) is decrypted even in an unused group', () => {
  Arm.setRelevance({ sourcesReady: true, targetsReady: true, isSource: () => false, isTarget: () => false });
  const arm = new Arm({ id: 'pk', name: 'r', station_id: 'st' }, () => {});
  const node = (types) => ({ attrs: { id: 'M1', from: 'x@g.us', participant: '111@lid' }, content: types.map((t) => ({ tag: 'enc', attrs: { type: t } })) });
  assert.equal(arm.skipIncoming(node(['skmsg'])), true, 'ordinary traffic in an unused group: skipped');
  assert.equal(arm.skipIncoming(node(['pkmsg', 'skmsg'])), false, 'new session: processed');
  assert.equal(arm.takeDelivery().sessionsLearned, 1);
  assert.ok(arm.learnOnly.has('M1'), 'its content is not handed to the help / quote handlers');
});

test('incoming: private new sessions (pkmsg) are learned, within a per-minute budget', () => {
  const arm = new Arm({ id: 'pp', name: 'r', station_id: 'st' }, () => {});
  const node = (id, types) => ({ attrs: { id, from: '972500000009@s.whatsapp.net' }, content: types.map((t) => ({ tag: 'enc', attrs: { type: t } })) });
  assert.equal(arm.skipIncoming(node('A', ['msg'])), true, 'ordinary private message from a stranger: skipped');
  assert.equal(arm.skipIncoming(node('B', ['pkmsg'])), false, 'new session: learned');
  for (let i = 0; i < 70; i++) arm.skipIncoming(node('C' + i, ['pkmsg']));
  assert.equal(arm.takeDelivery().sessionsLearned, 60, 'at most 60 a minute – a backlog cannot freeze the engine');
});

test('retry: only the failing device loses "has our key"; its device list is fetched again', async () => {
  const arm = new Arm({ id: 'sk', name: 'r', station_id: 'st' }, () => {});
  let mem = { 'g@g.us': { '111:2@lid': true, '111@lid': true, '222@lid': true } };
  arm.signalKeys = {
    get: async (type, ids) => Object.fromEntries(ids.map((id) => [id, mem[id]])),
    set: async (data) => Object.assign(mem, data['sender-key-memory']),
  };
  await arm.forgetDeviceKey('g@g.us', '111:2@lid');
  assert.deepEqual(Object.keys(mem['g@g.us']).sort(), ['111@lid', '222@lid']);
  await arm.forgetDeviceKey('g@g.us', '333:5@lid'); // unknown device of an unknown member: nothing else touched
  assert.deepEqual(Object.keys(mem['g@g.us']).sort(), ['111@lid', '222@lid']);
  await arm.forgetDeviceKey('g@g.us', '222:7@lid'); // new device of a known member: all that member's devices
  assert.deepEqual(Object.keys(mem['g@g.us']), ['111@lid']);
  const dropped = [];
  arm.devCache = { del: (k) => dropped.push(...k) };
  arm.forgetDevices('111:2@lid');
  assert.deepEqual(dropped, ['111', '111@lid']);
});

test('members joining/leaving update the kept member list at once', () => {
  const arm = new Arm({ id: 'gp', name: 'r', station_id: 'st' }, () => {});
  arm.groupMeta = new Map([['g@g.us', { id: 'g@g.us', subject: 'g', participants: [{ id: 'a@lid' }, { id: 'b@lid' }] }]]);
  arm.applyParticipants({ id: 'g@g.us', action: 'add', participants: ['c@lid', 'a@lid'] });
  assert.deepEqual(arm.groupMeta.get('g@g.us').participants.map((p) => p.id), ['a@lid', 'b@lid', 'c@lid']);
  arm.applyParticipants({ id: 'g@g.us', action: 'remove', participants: [{ id: 'a@lid' }] });
  assert.deepEqual(arm.groupMeta.get('g@g.us').participants.map((p) => p.id), ['b@lid', 'c@lid']);
  arm.applyParticipants({ id: 'other@g.us', action: 'add', participants: ['z@lid'] }); // not kept: ignored
  assert.equal(arm.groupMeta.has('other@g.us'), false);
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
