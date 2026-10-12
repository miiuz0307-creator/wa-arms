// Phone helpers. Stored form: international digits, e.g. 972501234567.

function toIntl(raw) {
  let x = String(raw || '').replace(/\D/g, '');
  if (x.startsWith('00')) x = x.slice(2);
  if (/^0\d{8,9}$/.test(x)) x = '972' + x.slice(1);
  return x;
}

const isValidIntl = (x) => /^\d{10,15}$/.test(x);

function formatLocal(intl) {
  const x = String(intl || '');
  if (/^972\d{9}$/.test(x)) {
    const l = '0' + x.slice(3);
    return `${l.slice(0, 3)}-${l.slice(3)}`;
  }
  return x ? `+${x}` : '';
}

/** The sender of a private WhatsApp message: { phone, lid } (either may be null). */
function senderOf(key = {}) {
  const ids = [key.remoteJid, key.senderPn, key.remoteJidAlt, key.participant, key.participantPn, key.participantAlt].filter(Boolean);
  let phone = null;
  let lid = null;
  for (const id of ids) {
    const s = String(id).replace(/:\d+(?=@)/, '');
    if (!phone && (s.endsWith('@s.whatsapp.net') || s.endsWith('@hosted'))) phone = s.split('@')[0];
    if (!lid && (s.endsWith('@lid') || s.endsWith('@hosted.lid'))) lid = s.split('@')[0];
  }
  return { phone, lid };
}

const jidOf = (phone) => `${phone}@s.whatsapp.net`;

module.exports = { toIntl, isValidIntl, formatLocal, senderOf, jidOf };
