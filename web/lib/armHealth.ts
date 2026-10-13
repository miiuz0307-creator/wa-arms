import type { Tone } from './format';

// Plain-language health of an arm (one WhatsApp number) and of a WhatsApp group, for station owners.
// One place, so home, arms and groups say exactly the same thing.

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'action';
export type ArmHealth = {
  level: HealthLevel;
  tone: Tone;
  /** short status ("מחוברת ופועלת") */
  title: string;
  /** one sentence: what is going on */
  explain: string;
  /** what to do now (null = nothing) */
  action: string | null;
  /** the raw technical error, for the "פרטים טכניים" disclosure */
  raw: string | null;
};

export const LEVEL_TONE: Record<HealthLevel, Tone> = { ok: 'green', warn: 'amber', bad: 'red', action: 'sky' };

type ArmLike = {
  status?: string | null;
  is_active?: boolean | null;
  phone?: string | null;
  last_error?: string | null;
  daily_limit?: number | null;
  sent_today?: number | null;
  sent_day?: string | null;
};

export type ArmExtras = {
  /** sends that failed recently through this arm (from group_problems: send_error) */
  failedRecent?: number;
  /** a QR code is waiting to be scanned right now */
  hasQr?: boolean;
};

const RECONNECT = "ודא שהטלפון מחובר לאינטרנט ושוואטסאפ פתוח בו, ולחץ 'חיבור מחדש'.";
const SCAN = "לחץ 'QR חדש', ובטלפון: WhatsApp ← הגדרות ← מכשירים מקושרים ← קישור מכשיר, וסרוק את הקוד.";

/** Common Baileys / WhatsApp errors in plain Hebrew + what to do. null = not recognised. */
export function friendlyError(raw?: string | null): { text: string; action: string; rescan?: boolean } | null {
  const e = (raw || '').trim();
  if (!e) return null;
  if (/logged ?out|loggedout|\b401\b|device_removed|unauthori[sz]ed/i.test(e))
    return { text: 'WhatsApp ניתק את המכשיר המקושר (כנראה הוסר מהטלפון).', action: SCAN, rescan: true };
  if (/conflict|replaced|\b440\b/i.test(e))
    return { text: 'המספר נפתח במקום אחר (WhatsApp Web או מחשב נוסף) והחיבור שלנו הוחלף.', action: "סגור את WhatsApp Web במחשבים אחרים ולחץ 'חיבור מחדש'." };
  if (/stream errored|restart required|\b515\b/i.test(e))
    return { text: 'WhatsApp ביקש לאתחל את החיבור. בדרך כלל הזרוע חוזרת לבד תוך דקה.', action: "אם הזרוע לא חזרה תוך שתי דקות – לחץ 'חיבור מחדש'." };
  if (/connection (closed|lost|terminated)|\b428\b|econnreset|socket hang up/i.test(e))
    return { text: 'החיבור לשרתי WhatsApp נסגר.', action: RECONNECT };
  if (/timed? ?out|\b408\b|etimedout/i.test(e)) return { text: 'WhatsApp לא ענה בזמן – בדרך כלל בעיית אינטרנט בטלפון.', action: RECONNECT };
  if (/banned|\b403\b|forbidden|blocked/i.test(e))
    return { text: 'WhatsApp חסם או הגביל את המספר.', action: 'פתח את WhatsApp בטלפון ובדוק אם המספר חסום. אם כן – חבר מספר אחר כזרוע.' };
  if (/bad ?mac|decrypt|session error/i.test(e))
    return { text: 'בעיית הצפנה זמנית מול WhatsApp.', action: "לרוב נפתרת לבד. אם חוזרת – לחץ 'חיבור מחדש'." };
  if (/[֐-׿]/.test(e)) return { text: e, action: RECONNECT };
  return null;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export function limitReached(a: ArmLike) {
  return a.sent_day === todayIso() && (a.sent_today || 0) >= (a.daily_limit || Infinity);
}

/** What an arm's state means for a station owner, and what to do about it. */
export function armHealth(a: ArmLike, x: ArmExtras = {}): ArmHealth {
  const raw = a.last_error?.trim() || null;
  const fe = friendlyError(raw);
  const mk = (level: HealthLevel, title: string, explain: string, action: string | null): ArmHealth => ({
    level,
    tone: LEVEL_TONE[level],
    title,
    explain,
    action,
    raw,
  });
  const st = a.status || 'pending';

  if (!a.is_active) {
    return st === 'online'
      ? mk('warn', 'מחוברת אך יש בעיית שליחה', 'הזרוע הושבתה ידנית, ולכן לא שולחת הודעות.', "לחץ 'חיבור' כדי להחזיר אותה לשליחה.")
      : mk('warn', 'מושבתת', 'הזרוע נותקה ידנית ולא שולחת הודעות.', "לחץ 'חיבור' כדי להחזיר אותה לשליחה.");
  }

  if (st === 'online') {
    if (limitReached(a))
      return mk(
        'warn',
        'מחוברת אך יש בעיית שליחה',
        `הגבלת השליחה היומית הושגה (${a.sent_today}/${a.daily_limit}) – הזרוע לא שולחת עד חצות, והזרועות האחרות ממשיכות.`,
        'ההגבלה תתאפס בחצות. אפשר להעלות אותה בעריכת הזרוע.',
      );
    if ((x.failedRecent || 0) > 0)
      return mk(
        'warn',
        'מחוברת אך יש בעיית שליחה',
        `${x.failedRecent} שליחות דרך הזרוע נכשלו לאחרונה${fe ? ` – ${fe.text}` : '.'}`,
        fe?.action || 'בדוק בהיסטוריה אילו קבוצות לא קיבלו את ההודעה. אם זה חוזר – לחץ \'חיבור מחדש\'.',
      );
    if (raw) return mk('warn', 'מחוברת אך יש בעיית שליחה', fe?.text || 'הזרוע דיווחה על תקלה אחרונה בשליחה.', fe?.action || null);
    return mk('ok', 'מחוברת ופועלת', 'מחוברת ל-WhatsApp ושולחת כרגיל.', null);
  }

  if (st === 'qr' || (st === 'pending' && !a.phone && !raw))
    return mk('action', 'דורשת סריקת QR', x.hasQr ? 'קוד QR מוכן לסריקה.' : 'הזרוע ממתינה לקישור לטלפון.', SCAN);

  if (st === 'pending' && !raw)
    return mk('action', 'ממתינה לחיבור', 'הזרוע אמורה להתחבר תוך דקה. אם זה לא קורה – צריך לקשר אותה מחדש.', SCAN);

  if (st === 'connecting') return mk('action', 'מתחברת…', 'מתחברת לשרת WhatsApp. זה לוקח בדרך כלל עד דקה.', null);

  if (st === 'paused') return mk('warn', 'מושהית', 'הזרוע מושהית ולא שולחת הודעות.', "לחץ 'חיבור מחדש' כדי להחזיר אותה לפעולה.");

  if (st === 'offline')
    return mk('bad', 'מנותקת', fe?.text || 'הזרוע לא מחוברת ל-WhatsApp ולא שולחת הודעות.', fe?.rescan ? SCAN : RECONNECT);

  // error, or pending with an error
  return mk('bad', 'תקלה שדורשת טיפול', fe?.text || 'הזרוע נתקלה בתקלה ולא שולחת הודעות.', fe?.action || RECONNECT);
}

// ---------------------------------------------------------------------------------------------
// Groups: why a WhatsApp group will not get rides
// ---------------------------------------------------------------------------------------------

export type GroupReason = 'disabled' | 'no_arm' | 'no_list_arm' | 'arm_offline' | 'no_permission' | 'send_error' | 'unknown';

export const GROUP_REASON: Record<GroupReason, string> = {
  disabled: 'הושבתה ידנית',
  no_arm: 'אף זרוע אינה חברה בקבוצה',
  no_list_arm: 'אף זרוע שולחת של הרשימה אינה בקבוצה',
  arm_offline: 'זרוע מנותקת',
  no_permission: 'אין הרשאת שליחה (רק מנהלים)',
  send_error: 'שגיאת שליחה',
  unknown: 'סיבה לא ידועה',
};

/** group_problems rows, indexed: `${arm_id}|${group}` (arm-specific) and `*|${group}` (no arm). */
export type ProblemIndex = Map<string, string>;
export function indexProblems(rows: { wa_group_id: string; arm_id: string | null; reason: string }[]): ProblemIndex {
  const m: ProblemIndex = new Map();
  // rows come newest first – keep the newest reason per (arm, group)
  for (const r of rows || []) {
    const k = `${r.arm_id || '*'}|${r.wa_group_id}`;
    if (!m.has(k)) m.set(k, r.reason);
  }
  return m;
}

const PRIORITY: GroupReason[] = ['no_permission', 'send_error'];

/**
 * Why a group cannot get rides now (null = available).
 * armIds = arms that are members; pool = the list's sending arms (null/empty = any arm);
 * a group is usable when some live member arm has no open problem in it.
 */
export function groupReason(
  g: { id: string; armIds: string[] },
  armById: Record<string, any>,
  problems: ProblemIndex,
  disabled: boolean,
  pool?: string[] | null,
): GroupReason | null {
  if (disabled) return 'disabled';
  if (g.armIds.length === 0) return 'no_arm';
  const members = pool && pool.length ? g.armIds.filter((id) => pool.includes(id)) : g.armIds;
  if (members.length === 0) return 'no_list_arm';
  const live = members.filter((id) => armById[id]?.is_active && armById[id]?.status === 'online');
  if (live.length === 0) return 'arm_offline';
  // with a live member arm, only what the group itself answered still counts (no permission / send error);
  // "no arm" / "arm offline" from history describe the arms at that time and the arm state above replaces them
  const sticky = (p?: string | null) => (p === 'no_permission' || p === 'send_error' ? p : null);
  const general = sticky(problems.get(`*|${g.id}`));
  const per = live.map((id) => sticky(problems.get(`${id}|${g.id}`)) || general);
  if (per.some((p) => !p)) return null;
  for (const p of PRIORITY) if ((per as string[]).includes(p)) return p;
  return 'unknown';
}
