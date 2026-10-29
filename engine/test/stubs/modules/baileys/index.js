// Test stand-in for Baileys: no network. Tests can set global.__makeSocket to control the fake socket.
const BufferJSON = {
  replacer: (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? { type: 'Buffer', data: Buffer.from(v.data).toString('base64') } : v),
  reviver: (k, v) => (v && v.type === 'Buffer' && typeof v.data === 'string' ? Buffer.from(v.data, 'base64') : v),
};
const initAuthCreds = () => ({ noiseKey: { private: Buffer.alloc(32, 1) }, registrationId: 1, me: undefined });
const proto = { Message: { AppStateSyncKeyData: { fromObject: (o) => o } } };
const DisconnectReason = { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, loggedOut: 401, badSession: 500, restartRequired: 515, multideviceMismatch: 411, forbidden: 403 };
const Browsers = { ubuntu: (b) => ['Ubuntu', b, '1'] };
const fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 1] });
const makeCacheableSignalKeyStore = (s) => s;
function makeWASocket(opts) {
  if (global.__makeSocket) return global.__makeSocket(opts);
  const { EventEmitter } = require('events');
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  return { ev: Object.assign(ev, { isBuffering: () => false, flush() {} }), ws, user: { id: '972500000000:1@s.whatsapp.net' }, end() {}, logout: async () => {}, sendMessage: async (jid, c, o) => ({ key: { id: o?.messageId || 'X', remoteJid: jid, fromMe: true }, message: { conversation: c.text } }) };
}
module.exports = { default: makeWASocket, makeWASocket, BufferJSON, initAuthCreds, proto, DisconnectReason, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore };
