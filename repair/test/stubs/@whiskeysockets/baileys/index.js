// test stand-in for Baileys: no network. Tests set global.__makeSocket to control the fake socket.
const { EventEmitter } = require('events');
const BufferJSON = {
  replacer: (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? { type: 'Buffer', data: Buffer.from(v.data).toString('base64') } : v),
  reviver: (k, v) => (v && v.type === 'Buffer' && typeof v.data === 'string' ? Buffer.from(v.data, 'base64') : v),
};
const initAuthCreds = () => ({ noiseKey: { private: Buffer.alloc(32, 1) }, registrationId: 1, me: undefined });
const proto = { Message: { AppStateSyncKeyData: { fromObject: (o) => o } } };
const DisconnectReason = { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, loggedOut: 401, badSession: 500, restartRequired: 515, forbidden: 403 };
const Browsers = { ubuntu: (b) => ['Ubuntu', b, '1'] };
function makeWASocket(opts) {
  if (global.__makeSocket) return global.__makeSocket(opts);
  const ev = new EventEmitter();
  return { ev, user: { id: '972500000000:1@s.whatsapp.net' }, end() {}, logout: async () => {}, sent: [], async sendMessage(jid, c) { this.sent.push({ jid, c }); } };
}
const downloadMediaMessage = async () => Buffer.from('fake-image');
module.exports = { default: makeWASocket, makeWASocket, BufferJSON, initAuthCreds, proto, DisconnectReason, Browsers, downloadMediaMessage };
