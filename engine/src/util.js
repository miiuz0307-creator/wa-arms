const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const randomBetween = (min, max) => min + Math.random() * Math.max(0, max - min);

const digits = (s) => String(s || '').replace(/\D/g, '');

// 972501234567 -> 050-1234567 ; other countries -> +<digits>
function formatPhone(raw) {
  let d = digits(raw);
  if (!d) return null;
  if (d.startsWith('972') && d.length === 12) d = '0' + d.slice(3);
  if (d.startsWith('0') && d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return '+' + d;
}

const jidUser = (jid) => (jid ? String(jid).split('@')[0].split(':')[0] : null);

function extractText(message) {
  if (!message) return '';
  const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\s.,!?:;\\-–—()\\[\\]"\'״׳]';

function keywordRegex(keyword) {
  return new RegExp(`(^|${SEP})${escapeRe(keyword.trim())}(?=$|${SEP})`, 'u');
}

function containsKeyword(text, keyword) {
  if (!keyword || !keyword.trim()) return false;
  return keywordRegex(keyword).test(text);
}

function stripKeyword(text, keyword) {
  const kw = keyword.trim();
  const re = new RegExp(`(^|${SEP})${escapeRe(kw)}(?=$|${SEP})`, 'gu');
  return text
    .split('\n')
    .filter((line) => line.trim() !== kw)
    .map((line) => line.replace(re, '$1').replace(/ {2,}/g, ' ').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildHelpText({ body, keyword, strip, template, phone }) {
  const main = strip && keyword ? stripKeyword(body, keyword) : body.trim();
  const fill = (s) => (s || '').split('{PHONE}').join(phone || '');
  const parts = [];
  if (template?.prefix?.trim()) parts.push(fill(template.prefix).trim());
  parts.push(main);
  if (template?.suffix?.trim()) parts.push(fill(template.suffix).trim());
  return parts.join('\n\n');
}

module.exports = {
  sleep,
  randomBetween,
  digits,
  formatPhone,
  jidUser,
  extractText,
  containsKeyword,
  stripKeyword,
  buildHelpText,
};
