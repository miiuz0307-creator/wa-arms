// Detect and remove Israeli phone numbers from ride text.
// Rule of thumb: remove every phone we are sure about, keep everything else
// (addresses, prices, times), and flag anything that *might* still be a phone.

const SEP = '[\\s\\-.\\u2013\\u2014]{0,3}'; // spaces, dashes, dots between digits
const d = (n) => `(?:${SEP}\\d){${n}}`;

// +972 / 972 / 00972 / 0 prefixes, optional "(0)"
const PREFIX = `(?:(?:\\+|00)?\\s?972${SEP}(?:\\(0\\)${SEP})?|\\(?0)`;
// mobile 05X, VoIP/virtual 07X: 10 digits; landline 02/03/04/08/09: 9 digits
const BODY = `(?:5\\d${d(7)}|7\\d${d(7)}|[23489]\\)?${d(7)})`;
// toll numbers 1-800 / 1-700 etc.
const TOLL = `1[5-8]00${d(6)}`;

const PHONE_RE = new RegExp(`(?<![\\d+])(?:${PREFIX}${SEP}${BODY}|${TOLL})(?!${SEP}\\d)`, 'g');
const WA_LINK_RE = /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\+?\d+\S*/gi;
const TEL_LINK_RE = /tel:\+?[\d\-]+/gi;

// words that only label a phone number – a line left with just these is dropped
const LABEL_WORDS =
  "טלפון|טל['׳]?|נייד|פלאפון|פלא|קווי|מספר|מס['׳]?|לפרטים|פרטים|ליצירת\\s*קשר|צור\\s*קשר|להזמנה|להזמנות|לקוח|הלקוח|של\\s*הלקוח|נוסע|הנוסע|ווטסאפ|וואטסאפ|whatsapp|tel|phone|call|ב?וואצפ|בווצאפ|להתקשר|תתקשרו|תתקשר|לתיאום";
const LABEL_RE = new RegExp(`(${LABEL_WORDS})`, 'giu');

const normalize = (raw) => {
  let x = String(raw || '').replace(/\D/g, '');
  if (x.startsWith('00972')) x = x.slice(2);
  if (x.startsWith('972')) x = '0' + x.slice(3);
  return x;
};

const isPhone = (digits) => /^0(5|7)\d{8}$/.test(digits) || /^0[23489]\d{7}$/.test(digits) || /^1[5-8]00\d{6}$/.test(digits);

const formatPhone = (raw) => {
  const x = normalize(raw);
  if (/^0\d{9}$/.test(x)) return `${x.slice(0, 3)}-${x.slice(3)}`;
  if (/^0\d{8}$/.test(x)) return `${x.slice(0, 2)}-${x.slice(2)}`;
  return x;
};

/** All confident phone numbers in the text (normalized digits). */
function findPhones(text) {
  const out = [];
  for (const m of String(text || '').matchAll(PHONE_RE)) {
    const n = normalize(m[0]);
    if (isPhone(n)) out.push({ raw: m[0], digits: n, index: m.index });
  }
  return out;
}

// dates and times are digit runs that are NOT phones
const DATE_RE = /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/g;
const TIME_RE = /\b\d{1,2}:\d{2}\b/g;
// 7+ digits in a row (allowing light separators) that we could not classify
const SUSPICIOUS_RE = /\d(?:[\s\-.]{0,2}\d){6,}/g;

/** Digit runs that look like they could be a phone but did not match a known format. */
function findSuspicious(text) {
  const masked = String(text || '').replace(DATE_RE, ' ').replace(TIME_RE, ' ');
  return [...masked.matchAll(SUSPICIOUS_RE)].map((m) => m[0].trim());
}

function cleanLine(line) {
  const rest = line
    .replace(LABEL_RE, '')
    .replace(/[\s:：\-–—|•·.,;()\[\]{}"'׳״]+/g, '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '');
  return rest.length > 0;
}

/**
 * Remove customer phones.
 * @param {string} text
 * @param {{allow?: string[]}} opts phones that are allowed to stay (e.g. the operator's own number)
 * @returns {{text: string, removed: string[], suspicious: string[]}}
 */
function sanitize(text, opts = {}) {
  const allow = new Set((opts.allow || []).map(normalize).filter(Boolean));
  const removed = [];
  let out = String(text || '')
    .replace(WA_LINK_RE, (m) => {
      removed.push(normalize(m));
      return '';
    })
    .replace(TEL_LINK_RE, (m) => {
      removed.push(normalize(m));
      return '';
    });

  const lines = out.split('\n').map((line) => {
    let changed = false;
    const next = line.replace(PHONE_RE, (m) => {
      const n = normalize(m);
      if (!isPhone(n) || allow.has(n)) return m;
      removed.push(n);
      changed = true;
      return '';
    });
    if (!changed) return { text: line, drop: false };
    let tidy = next.replace(/[ \t]{2,}/g, ' ').trim();
    // drop labels / connectors left dangling where the number used to be
    for (let i = 0; i < 4; i++) {
      const before = tidy;
      tidy = tidy
        .replace(/[\s:：\-–—|,/]+$/u, '')
        .replace(new RegExp(`(?:^|\\s)(?:${LABEL_WORDS}|או|or|\\p{Extended_Pictographic}\\uFE0F?)$`, 'iu'), '')
        .trim();
      if (tidy === before) break;
    }
    return { text: tidy, drop: !cleanLine(tidy) };
  });

  out = lines
    .filter((l) => !l.drop)
    .map((l) => l.text)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // second pass – nothing confident may remain (except allowed numbers)
  const leftover = findPhones(out).filter((p) => !allow.has(p.digits));
  const suspicious = findSuspicious(out).filter((s) => !allow.has(normalize(s)));
  return { text: out, removed, suspicious: [...leftover.map((p) => p.raw.trim()), ...suspicious] };
}

/** Final gate before sending: returns problems (empty array = safe). */
function verifyNoCustomerPhone(text, allow = []) {
  const allowSet = new Set(allow.map(normalize).filter(Boolean));
  const phones = findPhones(text).filter((p) => !allowSet.has(p.digits)).map((p) => p.raw.trim());
  const links = (String(text).match(WA_LINK_RE) || []).concat(String(text).match(TEL_LINK_RE) || []);
  return [...phones, ...links];
}

module.exports = { sanitize, verifyNoCustomerPhone, findPhones, findSuspicious, normalize, isPhone, formatPhone };
