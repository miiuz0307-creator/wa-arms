// Speed summaries for distributions: which speed was set at the time, how fast it actually went, why groups failed.
import { sb } from '@/lib/supabase';

export type SettingsSnap = { at: number; rate: number | null; min: number; max: number };

// every "settings saved" entry in the activity log (newest first) – tells what speed was set at any moment
export async function loadSpeedHistory(): Promise<SettingsSnap[]> {
  const [log, cur] = await Promise.all([
    sb().from('activity_log').select('created_at,details').eq('action', 'settings_saved').order('created_at', { ascending: false }).limit(300),
    sb().from('app_settings').select('rate_per_minute,min_delay_sec,max_delay_sec').limit(1).single(),
  ]);
  const snaps = (log.data || [])
    .filter((r: any) => r.details)
    .map((r: any) => ({
      at: new Date(r.created_at).getTime(),
      rate: r.details.rate_per_minute ?? null,
      min: Number(r.details.min_delay_sec ?? 0),
      max: Number(r.details.max_delay_sec ?? 0),
    }));
  if (!snaps.length && cur.data) {
    snaps.push({ at: 0, rate: cur.data.rate_per_minute ?? null, min: cur.data.min_delay_sec, max: cur.data.max_delay_sec });
  }
  return snaps;
}

export function speedAt(history: SettingsSnap[], when: string | null): string {
  const t = when ? new Date(when).getTime() : Date.now();
  const s = history.find((h) => h.at <= t) || history[history.length - 1];
  if (!s) return '—';
  if (s.rate) return `${s.rate} הודעות בדקה`;
  return s.min === s.max ? `${s.min} שניות בין הודעות` : `${s.min}–${s.max} שניות בין הודעות`;
}

export function fmtDuration(sec: number | null): string {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} שנ׳`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m} דק׳ ${s} שנ׳` : `${m} דק׳`;
  return `${Math.floor(m / 60)} שע׳ ${m % 60} דק׳`;
}

// rough numbers from the campaign row only (for the history list)
export function quickStats(c: any) {
  const start = c.started_at ? new Date(c.started_at).getTime() : null;
  const end = c.finished_at ? new Date(c.finished_at).getTime() : c.last_claim_at ? new Date(c.last_claim_at).getTime() : null;
  const sec = start && end ? (end - start) / 1000 : null;
  const perMin = sec && sec > 0 ? (c.sent / sec) * 60 : null;
  return { sec, perMin };
}

const REASONS: [RegExp, string][] = [
  [/מהר מדי|not-acceptable/i, 'וואטסאפ דחה את ההודעה (המספר שלח יותר מדי / מהר מדי)'],
  [/רק מנהלים/, 'בקבוצה רק מנהלים יכולים לכתוב'],
  [/אין הרשאה/, 'אין לזרוע הרשאה לשלוח בקבוצה'],
  [/Timed Out|timeout/i, 'השליחה נתקעה ולא הסתיימה בזמן'],
  [/rate-overlimit/i, 'וואטסאפ הגביל את קצב השליחה'],
  [/אין זרוע פנויה/, 'אין זרוע פנויה שנמצאת בקבוצה (או שהגיעה למגבלה היומית)'],
  [/בוטלה/, 'ההפצה בוטלה'],
];

export function reasonOf(error: string | null, status: string) {
  if (!error) return status === 'skipped' ? 'דולג (ההפצה בוטלה)' : 'שגיאה לא ידועה';
  for (const [re, label] of REASONS) if (re.test(error)) return label;
  return error;
}

// full numbers from the targets (for one distribution)
export function fullStats(c: any, targets: any[]) {
  const sentTimes = targets.filter((t) => t.sent_at).map((t) => new Date(t.sent_at).getTime()).sort((a, b) => a - b);
  const start = c.started_at ? new Date(c.started_at).getTime() : c.created_at ? new Date(c.created_at).getTime() : null;
  const created = c.created_at ? new Date(c.created_at).getTime() : null;
  const last = sentTimes.length ? sentTimes[sentTimes.length - 1] : null;
  const end = c.finished_at ? new Date(c.finished_at).getTime() : last;
  const sendSec = start && last ? (last - start) / 1000 : null;
  const perMin = sendSec && sendSec > 0 ? (sentTimes.length / sendSec) * 60 : null;

  const retries = targets.reduce((s, t) => s + Math.max(0, (t.attempts || 0) - 1), 0);
  const reasons = new Map<string, number>();
  for (const t of targets) {
    if (t.status === 'failed' || t.status === 'skipped') {
      const r = reasonOf(t.error, t.status);
      reasons.set(r, (reasons.get(r) || 0) + 1);
    }
  }

  // messages per minute over time
  const perMinute: { label: string; n: number }[] = [];
  if (sentTimes.length && start) {
    const minutes = Math.min(120, Math.ceil(((last as number) - start) / 60000) || 1);
    for (let i = 0; i < minutes; i++) perMinute.push({ label: `${i + 1}`, n: 0 });
    for (const t of sentTimes) {
      const i = Math.min(minutes - 1, Math.floor((t - start) / 60000));
      perMinute[i].n++;
    }
  }

  return {
    waitSec: created && start ? (start - created) / 1000 : null,
    firstSec: sentTimes.length && start ? (sentTimes[0] - start) / 1000 : null,
    sendSec,
    totalSec: created && end ? (end - created) / 1000 : null,
    perMin,
    retries,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    perMinute,
  };
}

// a plain-language "why" for the summary
export function explain(c: any, s: ReturnType<typeof fullStats>, targets: any[]): string[] {
  const out: string[] = [];
  const total = targets.length || c.total || 0;
  const rejected = targets.filter((t) => /מהר מדי|not-acceptable/i.test(t.error || '') && t.status !== 'sent').length;
  const timeouts = targets.filter((t) => /Timed Out|timeout/i.test(t.error || '')).length;
  const cancelledSkips = targets.filter((t) => t.status === 'skipped' && !t.error).length;
  if (rejected > total * 0.2)
    out.push(
      `וואטסאפ דחה ${rejected} קבוצות ("not-acceptable"). זה קורה כשהמספר שולח הרבה הודעות בזמן קצר – וואטסאפ מגביל אותו זמנית. כל קבוצה כזו נוסתה שוב עד 8 פעמים, ולכן ההפצה גם התארכה.`,
    );
  if (timeouts) out.push(`${timeouts} שליחות נתקעו (לא קיבלו אישור מוואטסאפ תוך 45 שניות) – כל אחת כזו עיכבה את ההפצה.`);
  if (cancelledSkips) out.push(`${cancelledSkips} קבוצות לא קיבלו את ההודעה כי ההפצה בוטלה באמצע.`);
  if (s.waitSec != null && s.waitSec > 60)
    out.push(`ההפצה חיכתה ${fmtDuration(s.waitSec)} בתור לפני שהתחילה – כנראה שהזרוע הגיעה למגבלה היומית, הייתה מנותקת, או עסוקה בהפצה אחרת.`);
  if (!out.length && c.status === 'completed') out.push('ההפצה עברה בלי בעיות מיוחדות.');
  return out;
}
