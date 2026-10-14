// Phone number helpers. Israeli numbers are typed as 050-1234567; WhatsApp wants 972501234567.
const digits = (s) => String(s || '').replace(/\D/g, '');

/** Any typed number -> international digits (972...) or null if it can't be a phone. */
function toIntl(raw) {
  let d = digits(raw);
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && (d.length === 10 || d.length === 9)) d = '972' + d.slice(1);
  if (d.length < 9 || d.length > 15) return null;
  return d;
}

/** 972501234567 -> 050-1234567 ; others -> +digits */
function pretty(raw) {
  const d = digits(raw);
  if (!d) return '';
  if (d.startsWith('972') && d.length === 12) return `0${d.slice(3, 5)}-${d.slice(5)}`;
  if (d.startsWith('972') && d.length === 11) return `0${d.slice(3, 4)}-${d.slice(4)}`;
  return '+' + d;
}

/** "972501234567:3@s.whatsapp.net" -> "972501234567@s.whatsapp.net" */
const bareJid = (jid) => (jid ? String(jid).replace(/:\d+(?=@)/, '') : '');
const jidUser = (jid) => bareJid(jid).split('@')[0];

module.exports = { digits, toIntl, pretty, bareJid, jidUser };
