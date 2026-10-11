const test = require('node:test');
const assert = require('node:assert');
const { useDbAuthState, hasSession, ignoredJid } = require('../src/wa');
const { createMemoryStore } = require('../src/store/memory');

const SECRET = 's'.repeat(40);

test('session keys: a write is readable at once, persisted in a batch, survives reload', async () => {
  const store = createMemoryStore();
  const a = await useDbAuthState(store, SECRET);
  await a.state.keys.set({ session: { '972501234567.0': { counter: 1 } } });
  assert.deepEqual((await a.state.keys.get('session', ['972501234567.0']))['972501234567.0'], { counter: 1 });
  await a.state.keys.set({ session: { '972501234567.0': { counter: 2 } } });
  assert.deepEqual((await a.state.keys.get('session', ['972501234567.0']))['972501234567.0'], { counter: 2 });
  assert.equal((await store.authAll()).length, 0, 'not written yet – batched');
  a.state.creds.me = { id: '972504107826:1@s.whatsapp.net' };
  await a.saveCreds();
  await a.flush();
  assert.ok(await hasSession(store, SECRET));
  assert.ok(!(await hasSession(store, 'x'.repeat(40))), 'wrong secret = no session');
  const b = await useDbAuthState(store, SECRET);
  assert.deepEqual((await b.state.keys.get('session', ['972501234567.0']))['972501234567.0'], { counter: 2 });
  await b.state.keys.set({ session: { '972501234567.0': null } });
  await b.flush();
  assert.equal((await store.authAll()).filter((r) => r.key.startsWith('session-')).length, 0);
});

test('sender keys come back as bytes for this Baileys version', async () => {
  const store = createMemoryStore();
  const a = await useDbAuthState(store, SECRET);
  await a.state.keys.set({ 'sender-key': { g1: { chains: [1] } } });
  const v = (await a.state.keys.get('sender-key', ['g1'])).g1;
  assert.ok(Buffer.isBuffer(v));
});

test('groups, status and channels are ignored', () => {
  for (const j of ['123@g.us', 'status@broadcast', '1@newsletter']) assert.ok(ignoredJid(j));
  for (const j of ['972501234567@s.whatsapp.net', '123@lid']) assert.ok(!ignoredJid(j));
});
