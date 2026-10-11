// Encryption, admin sessions, approval codes and secret redaction.
const crypto = require('crypto');

const deriveKey = (secret, purpose) => crypto.createHash('sha256').update(`${purpose}:${secret}`).digest();

function encrypt(secret, text) {
  const key = deriveKey(secret, 'wa-session');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(secret, b64) {
  const key = deriveKey(secret, 'wa-session');
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---- admin session cookie: "<expiresMs>.<hmac>" ----
function signSession(secret, ttlMs = 12 * 3600_000) {
  const exp = String(Date.now() + ttlMs);
  const mac = crypto.createHmac('sha256', deriveKey(secret, 'admin')).update(exp).digest('base64url');
  return `${exp}.${mac}`;
}

function verifySession(secret, token) {
  if (!token || typeof token !== 'string') return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', deriveKey(secret, 'admin')).update(exp).digest('base64url');
  return safeEqual(mac, want);
}

// ---- one-time approval codes (only the hash is stored) ----
const newCode = () => String(crypto.randomInt(100000, 1000000));
const hashCode = (secret, ticketId, code) =>
  crypto.createHmac('sha256', deriveKey(secret, 'approval')).update(`${ticketId}:${code}`).digest('hex');

// ---- redaction: applied to every log line and every diff before Claude or WhatsApp sees it ----
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_\-]{10,}/g, '[מפתח-הוסתר]'],
  [/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[מפתח-הוסתר]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[מפתח-הוסתר]'],
  [/eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '[JWT-הוסתר]'],
  [/(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi, '[כתובת-מסד-הוסתרה]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]{12,}/gi, '$1 [הוסתר]'],
  [
    /\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|PWD)[A-Z0-9_]*)\s*([=:])\s*["']?[^\s"',]{6,}["']?/gi,
    '$1$2[הוסתר]',
  ],
  [/\b[a-f0-9]{40,}\b/gi, '[hex-הוסתר]'],
  [/\b[A-Za-z0-9+\/]{48,}={0,2}(?![A-Za-z0-9+\/=])/g, '[base64-הוסתר]'],
];

// Customer phone numbers in logs are personal data: keep the prefix and last 2 digits only.
const PHONE_RE = /(?<![\d])(?:\+?972|0)5\d[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g;
const maskPhone = (m) => {
  const digits = m.replace(/\D/g, '');
  return `${digits.slice(0, digits.length - 7)}*****${digits.slice(-2)}`;
};

function redact(text, extraSecrets = []) {
  let out = String(text ?? '');
  for (const s of extraSecrets) {
    if (s && s.length >= 6) out = out.split(s).join('[הוסתר]');
  }
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out.replace(PHONE_RE, maskPhone);
}

/** Does a diff look like it adds a secret? (checked on added lines only) */
function diffAddsSecret(diff) {
  const added = String(diff)
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  return SECRET_PATTERNS.slice(0, 7).some(([re]) => {
    re.lastIndex = 0;
    return re.test(added);
  });
}

module.exports = { encrypt, decrypt, safeEqual, signSession, verifySession, newCode, hashCode, redact, diffAddsSecret };
