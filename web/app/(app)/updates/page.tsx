'use client';
// Update center: nothing reaches production before the owner approves it here.
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Clock, Database, HeartPulse, History, Moon, Rocket, RotateCcw, ShieldCheck, Smartphone, Monitor, XCircle, AlertTriangle } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Card, Empty, PageHeader, Skeleton, Spinner, Stat, ask, cx, toast } from '@/components/ui';

type Release = {
  id: number;
  version: string;
  title: string;
  changes: string[];
  components: string[];
  affects_arms: boolean;
  disconnect_risk: 'none' | 'short' | 'high';
  restart_engine: boolean;
  risk_notes: string | null;
  commit: string;
  has_db: boolean;
  has_undo: boolean;
  status: string;
  deploy_after: string | null;
  decided_at: string | null;
  started_at: string | null;
  deployed_at: string | null;
  verify_until: string | null;
  health: { samples?: any[]; bad?: number } | null;
  log: { at: string; msg: string }[];
  created_at: string;
};
type Data = {
  releases: Release[];
  live: { component: string; commit: string; since: string; version: string | null }[];
  health: { engine_seen: string | null; arms_online: number; arms_active: number; campaigns_running: number };
};

const STATUS: Record<string, { label: string; tone: any }> = {
  pending: { label: 'ממתין לאישור שלך', tone: 'amber' },
  approved: { label: 'אושר – ממתין לזמן הפריסה', tone: 'sky' },
  rejected: { label: 'נדחה', tone: 'slate' },
  deploying: { label: 'בפריסה', tone: 'sky' },
  verifying: { label: 'בבדיקת תקינות', tone: 'sky' },
  live: { label: 'פעיל ותקין', tone: 'green' },
  failed: { label: 'נכשל – לא הוחל', tone: 'red' },
  rolled_back: { label: 'הוחזר לגרסה הקודמת', tone: 'red' },
  rollback_requested: { label: 'חוזר לגרסה הקודמת…', tone: 'red' },
  superseded: { label: 'הוחלף בגרסה חדשה', tone: 'slate' },
};
const COMP: Record<string, { label: string; icon: any }> = {
  web: { label: 'ממשק האפליקציה', icon: Monitor },
  engine: { label: 'מנוע הזרועות', icon: Smartphone },
  db: { label: 'מסד הנתונים', icon: Database },
};
const RISK: Record<string, { label: string; tone: any }> = {
  none: { label: 'אין ניתוק מכשירים', tone: 'green' },
  short: { label: 'ניתוק קצר (כ־30 שניות, בלי QR)', tone: 'amber' },
  high: { label: 'סיכון לניתוק מכשירים', tone: 'red' },
};
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export default function UpdatesPage() {
  const { isSuper, loading, station } = useAuth();
  if (loading) return <Spinner />;
  if (!isSuper || station?.acting)
    return (
      <Card>
        <Empty icon={<ShieldCheck className="h-7 w-7" />} title="המסך הזה זמין רק למנהל הראשי" text="אישור עדכונים נעשה מחוץ לתחנה, מהחשבון שלך." />
      </Card>
    );
  return <Updates />;
}

function Updates() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('owner_releases');
    if (error) return toast(`העדכונים לא נטענו: ${error.message}`, 'error');
    setData(data);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(r: Release, action: string, q: { title: string; text?: string; ok: string; danger?: boolean }, done: string) {
    if (!(await ask(q))) return;
    setBusy(`${r.id}${action}`);
    const { data: res, error } = await sb().rpc('owner_release_decide', { p_id: r.id, p_action: action });
    setBusy(null);
    if (error || res?.error) return toast(res?.error || error?.message || 'הפעולה לא נשמרה. נסה שוב.', 'error');
    toast(done);
    load();
  }

  const header = (
    <PageHeader title="ניהול עדכונים" subtitle="שום עדכון לא עולה לאוויר בלי אישור שלך. כל עדכון נבדק אחרי העלייה, ואם משהו לא תקין – הוא חוזר אוטומטית לגרסה הקודמת." />
  );

  if (!data)
    return (
      <>
        {header}
        <div className="space-y-4" role="status" aria-label="טוען">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-48" />
        </div>
      </>
    );
  const h = data.health;
  const engAge = h.engine_seen ? (Date.now() - Date.parse(h.engine_seen)) / 1000 : null;
  const engOk = engAge !== null && engAge < 120;
  const waiting = data.releases.filter((r) => r.status === 'pending');
  const inFlight = data.releases.filter((r) => ['approved', 'deploying', 'verifying', 'rollback_requested'].includes(r.status));
  const history = data.releases.filter((r) => !waiting.includes(r) && !inFlight.includes(r));
  const live = (c: string) => data.live.find((l) => l.component === c);

  return (
    <>
      {header}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="גרסת הממשק" value={live('web')?.version || live('web')?.commit || '—'} sub={live('web') ? `מאז ${fmt(live('web')!.since)}` : 'עוד לא עודכן דרך המרכז'} icon={<Monitor className="h-5 w-5" />} tone="sky" />
        <Stat label="גרסת המנוע" value={live('engine')?.version || live('engine')?.commit || '—'} sub={live('engine') ? `מאז ${fmt(live('engine')!.since)}` : 'עוד לא עודכן דרך המרכז'} icon={<Smartphone className="h-5 w-5" />} tone="sky" />
        <Stat label="זרועות מחוברות" value={`${h.arms_online}/${h.arms_active}`} sub={engOk ? 'המנוע מדווח' : 'המנוע לא דיווח לאחרונה'} icon={<HeartPulse className="h-5 w-5" />} tone={h.arms_online === h.arms_active && engOk ? 'green' : 'red'} />
        <Stat label="הפצות פעילות" value={h.campaigns_running} sub="עדכון מנוע ממתין לסיומן" icon={<Rocket className="h-5 w-5" />} tone={h.campaigns_running ? 'amber' : 'slate'} />
      </div>

      <GroupTitle icon={<Clock className="h-4 w-4" />} count={waiting.length}>
        ממתינים לאישור
      </GroupTitle>
      {waiting.length === 0 ? (
        <Card>
          <Empty icon={<CheckCircle2 className="h-7 w-7" />} title="אין עדכונים שממתינים" text="כשיהיה עדכון חדש הוא יופיע כאן, עם הסבר מה משתנה והאם הוא מנתק את הזרועות." />
        </Card>
      ) : (
        <div className="space-y-3">
          {waiting.map((r) => (
            <ReleaseCard key={r.id} r={r}>
              <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:flex-wrap">
                <Button
                  loading={busy === `${r.id}approve_now`}
                  onClick={() =>
                    act(
                      r,
                      'approve_now',
                      {
                        title: 'לפרוס את העדכון עכשיו?',
                        text: r.restart_engine ? 'העדכון יפעיל מחדש את מנוע הזרועות: ניתוק קצר של כ־30 שניות, בלי צורך ב-QR.' : 'העדכון יעלה בדקה הקרובה וייבדק אוטומטית.',
                        ok: 'פריסה עכשיו',
                      },
                      'העדכון אושר – עולה עכשיו',
                    )
                  }
                >
                  <Rocket className="h-4 w-4" />
                  אישור – עכשיו
                </Button>
                <Button
                  variant="secondary"
                  loading={busy === `${r.id}approve_night`}
                  onClick={() => act(r, 'approve_night', { title: 'לפרוס הלילה ב־03:00?', text: 'העדכון יעלה בשעה שקטה וייבדק אוטומטית.', ok: 'אישור ל־03:00' }, 'העדכון אושר ל־03:00')}
                >
                  <Moon className="h-4 w-4" />
                  אישור – הלילה 03:00
                </Button>
                <Button
                  variant="danger"
                  className="sm:ms-auto"
                  loading={busy === `${r.id}reject`}
                  onClick={() => act(r, 'reject', { title: 'לדחות את העדכון?', text: 'הוא לא יעלה לאוויר.', ok: 'דחיית העדכון', danger: true }, 'העדכון נדחה')}
                >
                  <XCircle className="h-4 w-4" />
                  דחייה
                </Button>
              </div>
            </ReleaseCard>
          ))}
        </div>
      )}

      {inFlight.length > 0 && (
        <>
          <GroupTitle icon={<Rocket className="h-4 w-4" />} count={inFlight.length}>
            בתהליך
          </GroupTitle>
          <div className="space-y-3">
            {inFlight.map((r) => (
              <ReleaseCard key={r.id} r={r}>
                {r.status === 'approved' && (
                  <Button
                    className="mt-4"
                    variant="danger"
                    size="sm"
                    loading={busy === `${r.id}reject`}
                    onClick={() => act(r, 'reject', { title: 'לבטל את העדכון לפני שהוא עולה?', ok: 'ביטול העדכון', danger: true }, 'העדכון בוטל')}
                  >
                    <XCircle className="h-4 w-4" />
                    ביטול העדכון
                  </Button>
                )}
                {r.status === 'verifying' && (
                  <Button
                    className="mt-4"
                    variant="danger"
                    size="sm"
                    loading={busy === `${r.id}rollback`}
                    onClick={() => act(r, 'rollback', { title: 'לחזור עכשיו לגרסה הקודמת?', ok: 'חזרה לגרסה הקודמת', danger: true }, 'חוזר לגרסה הקודמת')}
                  >
                    <RotateCcw className="h-4 w-4" />
                    חזרה לגרסה הקודמת
                  </Button>
                )}
              </ReleaseCard>
            ))}
          </div>
        </>
      )}

      <GroupTitle icon={<History className="h-4 w-4" />}>היסטוריית עדכונים</GroupTitle>
      {history.length === 0 ? (
        <Card>
          <Empty icon={<History className="h-7 w-7" />} title="עדיין אין היסטוריה" text="עדכונים שעלו, נדחו או הוחזרו יופיעו כאן." />
        </Card>
      ) : (
        <div className="space-y-3">
          {history.map((r) => (
            <ReleaseCard key={r.id} r={r} compact>
              {r.status === 'live' && (
                <Button
                  className="mt-3"
                  variant="danger"
                  size="sm"
                  loading={busy === `${r.id}rollback`}
                  onClick={() => act(r, 'rollback', { title: 'לחזור לגרסה שהייתה לפני העדכון הזה?', ok: 'חזרה לגרסה הקודמת', danger: true }, 'חוזר לגרסה הקודמת')}
                >
                  <RotateCcw className="h-4 w-4" />
                  חזרה לגרסה הקודמת
                </Button>
              )}
            </ReleaseCard>
          ))}
        </div>
      )}
    </>
  );
}

function GroupTitle({ icon, count, children }: { icon: React.ReactNode; count?: number; children: React.ReactNode }) {
  return (
    <h2 className="mb-2.5 mt-7 flex items-center gap-2 text-[15px] font-semibold text-slate-900">
      <span className="text-slate-400">{icon}</span>
      {children}
      {count ? <span className="rounded-full bg-slate-100 px-2 text-xs tabular-nums text-slate-600">{count}</span> : null}
    </h2>
  );
}

function ReleaseCard({ r, compact, children }: { r: Release; compact?: boolean; children?: React.ReactNode }) {
  const [open, setOpen] = useState(!compact);
  const st = STATUS[r.status] || { label: r.status, tone: 'slate' };
  const risk = RISK[r.disconnect_risk];
  const samples = r.health?.samples || [];
  const last = samples[samples.length - 1];
  return (
    <Card className="p-4 md:p-5">
      <button type="button" aria-expanded={open} className="flex w-full flex-wrap items-center gap-2 text-right" onClick={() => setOpen(!open)}>
        <span className="font-mono text-sm tabular-nums text-slate-500" dir="ltr">
          {r.version}
        </span>
        <span className="min-w-0 flex-1 font-semibold text-slate-900">{r.title}</span>
        <Badge tone={st.tone} dot>
          {st.label}
        </Badge>
        <ChevronDown className={cx('h-4 w-4 shrink-0 text-slate-400 transition', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {r.components.map((c) => {
              const C = COMP[c];
              if (!C) return <Badge key={c}>{c}</Badge>;
              return (
                <Badge key={c} tone="slate">
                  <C.icon className="h-3.5 w-3.5" />
                  {C.label}
                </Badge>
              );
            })}
            {risk && (
              <Badge tone={risk.tone} dot>
                {risk.label}
              </Badge>
            )}
            <Badge tone={r.affects_arms ? 'amber' : 'green'}>{r.affects_arms ? 'משפיע על הזרועות' : 'לא משפיע על הזרועות'}</Badge>
            <Badge tone={r.restart_engine ? 'amber' : 'green'}>{r.restart_engine ? 'דורש הפעלה מחדש של המנוע' : 'בלי הפעלה מחדש של המנוע'}</Badge>
            {r.has_db && <Badge tone={r.has_undo ? 'sky' : 'amber'}>{r.has_undo ? 'שינוי במסד – יש שחזור' : 'שינוי במסד – בלי שחזור אוטומטי'}</Badge>}
          </div>
          {r.changes.length > 0 && (
            <ul className="list-disc space-y-1 pr-5 text-slate-700">
              {r.changes.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {r.risk_notes && (
            <div className="flex gap-2 rounded-xl bg-amber-50 p-3 leading-relaxed text-amber-900 ring-1 ring-inset ring-amber-600/20">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              {r.risk_notes}
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>נוצר {timeAgo(r.created_at)}</span>
            {r.deploy_after && r.status === 'approved' && (
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                ייפרס ב־{fmt(r.deploy_after)}
              </span>
            )}
            {r.deployed_at && <span>עלה {fmt(r.deployed_at)}</span>}
            <span className="font-mono" dir="ltr">
              {r.commit}
            </span>
          </div>
          {last && (
            <div className={cx('flex items-start gap-2 rounded-xl p-3 text-xs tabular-nums', r.health?.bad ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800')}>
              <HeartPulse className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
              {r.health?.bad ? 'נמצאו בעיות אחרי העדכון' : 'תקין אחרי העדכון'}: זרועות מחוברות {last.arms_online}/{last.arms_active}
              {last.engine_age_s !== null && ` · המנוע דיווח לפני ${last.engine_age_s} שניות`} · דגימות חריגות: {r.health?.bad || 0} מתוך {samples.length}
              </span>
            </div>
          )}
          {r.log.length > 0 && (
            <ol className="space-y-1 border-r-2 border-slate-200 pr-3 text-xs text-slate-500">
              {r.log.map((l, i) => (
                <li key={i}>
                  <span className="tabular-nums">{fmt(l.at)}</span> – {l.msg}
                </li>
              ))}
            </ol>
          )}
          {children}
        </div>
      )}
    </Card>
  );
}
