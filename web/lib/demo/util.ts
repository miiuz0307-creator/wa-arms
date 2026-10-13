// Small helpers for the in-browser demo database (no network, no WhatsApp).

/** Seeded PRNG (mulberry32): the same seed always gives the same demo data. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)];
  const chance = (p: number) => next() < p;
  const uuid = () => {
    const h = () => Math.floor(next() * 16).toString(16);
    let s = '';
    for (let i = 0; i < 32; i++) s += i === 12 ? '4' : i === 16 ? '89ab'[Math.floor(next() * 4)] : h();
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };
  const shuffle = <T,>(arr: T[]): T[] => {
    const a2 = arr.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [a2[i], a2[j]] = [a2[j], a2[i]];
    }
    return a2;
  };
  return { next, int, pick, chance, uuid, shuffle };
}
export type Rng = ReturnType<typeof prng>;

let rt: Rng | null = null;
/** runtime randomness (ids of rows created while clicking around) */
export const rand = () => (rt ||= prng((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0));
export const newUuid = () => {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return rand().uuid();
};

export const iso = (ms: number = Date.now()) => new Date(ms).toISOString();
const pad = (n: number) => String(n).padStart(2, '0');
/** local calendar date YYYY-MM-DD (the demo assumes the device is in Israel time) */
export const localDate = (d: Date = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (date: string, n: number) => {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
};
export const addMonths = (date: string, n: number) => {
  const d = new Date(date + 'T12:00:00');
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return localDate(d);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86400000);
export const midnightMs = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const ddmmyyyy = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

/** 054-1234567 / +972... → 972541234567 (like public.norm_phone) */
export function normPhone(p?: string | null): string | null {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return d;
}

/** numbers like Postgres trim_scale: 349.00 → "349" */
export const trimNum = (n: any) => String(Number(n));

export const b64 = (s: string) => {
  try {
    return btoa(unescape(encodeURIComponent(s)));
  } catch {
    return '';
  }
};
export const svgData = (svg: string) => 'data:image/svg+xml;base64,' + b64(svg);

export class DemoError extends Error {
  code: string;
  constructor(message: string, code = 'P0001') {
    super(message);
    this.code = code;
  }
}
export const raise = (msg: string, code?: string): never => {
  throw new DemoError(msg, code);
};
