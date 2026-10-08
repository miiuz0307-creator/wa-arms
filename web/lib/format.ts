export function timeAgo(iso?: string | null) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 45) return 'עכשיו';
  if (diff < 3600) return `לפני ${Math.round(diff / 60)} דק׳`;
  if (diff < 86400) return `לפני ${Math.round(diff / 3600)} שע׳`;
  return new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
}

export function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const firstLine = (s?: string | null, n = 60) => {
  const l = (s || '').split('\n').find((x) => x.trim()) || '';
  return l.length > n ? l.slice(0, n) + '…' : l;
};

export const ARM_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'ממתינה לחיבור', tone: 'amber' },
  qr: { label: 'ממתינה לסריקה', tone: 'violet' },
  connecting: { label: 'מתחברת…', tone: 'sky' },
  online: { label: 'מחוברת', tone: 'green' },
  offline: { label: 'מנותקת', tone: 'red' },
  error: { label: 'שגיאה', tone: 'red' },
  paused: { label: 'מושהית', tone: 'slate' },
};

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'בתור', tone: 'sky' },
  running: { label: 'בשליחה', tone: 'violet' },
  paused: { label: 'מושהה', tone: 'amber' },
  completed: { label: 'הושלם', tone: 'green' },
  cancelled: { label: 'בוטל', tone: 'slate' },
  failed: { label: 'נכשל', tone: 'red' },
  pending_phone: { label: 'ממתין למספר', tone: 'amber' },
};

export const TARGET_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'ממתין', tone: 'slate' },
  sending: { label: 'נשלח כעת', tone: 'violet' },
  sent: { label: 'נשלח', tone: 'green' },
  failed: { label: 'נכשל', tone: 'red' },
  skipped: { label: 'דולג', tone: 'slate' },
};

export type Tone = 'green' | 'red' | 'amber' | 'sky' | 'violet' | 'slate' | 'pink';

export const ACTION_LABEL: Record<string, string> = {
  campaign_created: 'יצר הפצה ידנית',
  campaign_retry: 'שלח שוב לקבוצות שנכשלו',
  campaign_paused: 'השהה הפצה',
  campaign_resumed: 'חידש הפצה',
  campaign_cancelled: 'ביטל הפצה',
  arm_added: 'הוסיף זרוע',
  arm_deleted: 'מחק זרוע',
  arm_reset: 'ביקש QR חדש לזרוע',
  arm_paused: 'ניתק זרוע',
  arm_resumed: 'חיבר מחדש זרוע',
  list_saved: 'שמר רשימת הפצה',
  list_deleted: 'מחק רשימת הפצה',
  settings_saved: 'עדכן הגדרות',
  help_settings: 'עדכן הגדרות הפצה אוטומטית',
  help_received: 'קיבל בקשת עזרה והתחיל הפצה',
  help_pending_phone: 'קיבל בקשת עזרה – חסר מספר טלפון',
  help_no_list: 'זיהה טריגר בלי רשימת יעד',
  phone_resolved: 'השלים מספר לבקשת עזרה',
  user_updated: 'עדכן הרשאות משתמש',
  quote_received: 'קיבל בקשת הפצה מציטוט',
  quote_distributed: 'התחיל הפצה מציטוט',
  quote_manual_approved: 'אישר ידנית טקסט שנחשד כמכיל מספר',
  quote_operator_pending: 'מספר לא מאושר ביקש הפצה מציטוט',
  operator_updated: 'עדכן מפעיל מורשה',
  quote_blocked: 'הפצה מציטוט לא יצאה (❌)',
  quote_cancelled: 'הפצה בוטלה מוואטסאפ (🛑)',
  quote_cancel_denied: 'ניסיון ביטול ממספר לא מורשה',
  quote_duplicate: 'נסיעה שכבר הופצה – לא נשלחה שוב (🔁)',
};

export const KIND_LABEL: Record<string, string> = {
  manual: 'ידני',
  help: 'עזרה (אוטומטי)',
  quote: 'ציטוט מקבוצה',
};
