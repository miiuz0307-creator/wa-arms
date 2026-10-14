const test = require('node:test');
const assert = require('node:assert');
const { toIntl, pretty } = require('../src/phone');
const { participantIds } = require('../src/arm');

test('phone numbers', () => {
  assert.equal(toIntl('050-1234567'), '972501234567');
  assert.equal(toIntl('+972 50 123 4567'), '972501234567');
  assert.equal(toIntl('00972501234567'), '972501234567');
  assert.equal(toIntl('02-6234567'), '97226234567');
  assert.equal(toIntl('12'), null);
  assert.equal(pretty('972501234567'), '050-1234567');
});

test('participant ids: phone and lid, device suffix dropped', () => {
  const ids = participantIds({ id: '123456789@lid', jid: '972501234567:4@s.whatsapp.net', admin: null });
  assert.deepEqual([...ids].sort(), ['123456789@lid', '972501234567@s.whatsapp.net']);
});
