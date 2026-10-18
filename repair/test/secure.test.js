const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/secure');
const { parseCommand } = require('../src/intake');
const { classify } = require('../src/classify');
const { parseResult } = require('../src/claude');
const { toIntl, senderOf, formatLocal } = require('../src/phones');

test('encrypt/decrypt round trip, wrong secret fails', () => {
  const enc = s.encrypt('secret-a', 'שלום');
  assert.equal(s.decrypt('secret-a', enc), 'שלום');
  assert.throws(() => s.decrypt('secret-b', enc));
});

test('admin session: valid, tampered, expired', () => {
  const tok = s.signSession('k'.repeat(40));
  assert.ok(s.verifySession('k'.repeat(40), tok));
  assert.ok(!s.verifySession('z'.repeat(40), tok));
  assert.ok(!s.verifySession('k'.repeat(40), tok.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))));
  assert.ok(!s.verifySession('k'.repeat(40), s.signSession('k'.repeat(40), -1000)));
  assert.ok(!s.verifySession('k'.repeat(40), undefined));
});

test('approval codes: 6 digits, hash bound to ticket', () => {
  const c = s.newCode();
  assert.match(c, /^\d{6}$/);
  assert.notEqual(s.hashCode('k', 1, c), s.hashCode('k', 2, c));
});

test('redact hides keys, tokens, db urls and phone numbers', () => {
  const line = [
    'key sk-ant-api03-abcdefghijklmnopqrstuv',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl',
    'postgres://user:pass@db.example.com:5432/x',
    'SESSION_SECRET=supersecretvalue',
    'Authorization: Bearer abcdefghijklmnop1234',
    'customer 052-123-4567 and +972521234567',
  ].join('\n');
  const out = s.redact(line, ['my-own-secret-value']);
  for (const leak of ['sk-ant-api03', 'ghp_abc', 'eyJhbGci', 'user:pass', 'supersecretvalue', 'abcdefghijklmnop1234', '1234567']) {
    assert.ok(!out.includes(leak), `leaked: ${leak}\n${out}`);
  }
  assert.ok(out.includes('*****67'));
  assert.equal(s.redact('hello my-own-secret-value', ['my-own-secret-value']), 'hello [הוסתר]');
});

test('diffAddsSecret looks only at added lines', () => {
  assert.ok(s.diffAddsSecret('+++ b/x.js\n+const k = "sk-ant-api03-abcdefghijklmnopqrstu";'));
  assert.ok(!s.diffAddsSecret('-const k = "sk-ant-api03-abcdefghijklmnopqrstu";\n+const k = process.env.KEY;'));
});

test('commands are matched exactly; anything else is just text', () => {
  assert.deepEqual(parseCommand('עזרה'), { cmd: 'help' });
  assert.deepEqual(parseCommand('*סטטוס*'), { cmd: 'status' });
  assert.deepEqual(parseCommand('אשר 123456'), { cmd: 'approve', code: '123456' });
  assert.deepEqual(parseCommand('אשר'), { cmd: 'approve_nocode' });
  assert.deepEqual(parseCommand('החזר #12'), { cmd: 'rollback', id: 12 });
  assert.deepEqual(parseCommand('פניה 3'), { cmd: 'show', id: 3 });
  assert.deepEqual(parseCommand('בטל 4'), { cmd: 'cancel', id: 4 });
  assert.equal(parseCommand('rm -rf / ; אשר 123456').cmd, 'text');
  assert.equal(parseCommand('ההפצה לא עובדת').cmd, 'text');
});

test('classify Hebrew descriptions', () => {
  assert.equal(classify('ההפצה לא עובדת').id, 'distribution');
  assert.equal(classify('זרוע 2 מנותקת, צריך QR').id, 'connection');
  assert.equal(classify('לא מצליח להיכנס עם קוד תחנה').id, 'login');
  assert.equal(classify('סדרן כתב עזרה ולא קרה כלום').id, 'help');
  assert.equal(classify('משהו מוזר').id, 'general');
});

test('parse Claude result json', () => {
  const r = parseResult('done\n```json\n{"changed":true,"summary_he":"תוקן","root_cause_he":"באג","risk":"low","files":["engine/src/arm.js"]}\n```');
  assert.equal(r.changed, true);
  assert.equal(r.risk, 'low');
  assert.deepEqual(r.files, ['engine/src/arm.js']);
  assert.equal(parseResult('no json here'), null);
  assert.equal(parseResult('```json\n{"changed":false,"risk":"weird"}\n```').risk, 'medium');
});

test('phones', () => {
  assert.equal(toIntl('050-123-4567'), '972501234567');
  assert.equal(toIntl('+972 50 123 4567'), '972501234567');
  assert.equal(formatLocal('972501234567'), '050-1234567');
  assert.deepEqual(senderOf({ remoteJid: '123@lid', senderPn: '972501234567@s.whatsapp.net' }), { phone: '972501234567', lid: '123' });
  assert.deepEqual(senderOf({ remoteJid: '972501234567:3@s.whatsapp.net' }), { phone: '972501234567', lid: null });
});

test('log details keep the engine arm list and drop noise fields', () => {
  const { logDetails } = require('../src/railway');
  const d = logDetails([{ key: 'level', value: '"info"' }, { key: 'pid', value: '1' }, { key: 'arms', value: '[{"arm":"זרוע 1","online":true}]' }]);
  assert.ok(d.startsWith('arms='));
  assert.ok(d.includes('"online":true'));
  assert.ok(!d.includes('level'));
});
