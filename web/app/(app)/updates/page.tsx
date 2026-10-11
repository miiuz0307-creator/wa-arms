'use client';
// Update center: nothing reaches production before the owner approves it here.
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Database, HeartPulse, Moon, Rocket, RotateCcw, Smartphone, Monitor, XCircle, AlertTriangle } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Card, Empty, PageHeader, Spinner, Stat, cx, toast } from '@/components/ui';

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
  deploying: { label: 'בפריסה', tone: 'violet' },
  verifying: { label: 'בבדיקת תקינות', tone: 'violet' },
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
  if (!isSuper || station?.acting) return <div className="py-20 text-center text-slate-500">המסך הזה זמין רק למנהל הראשי.</div>;
  return <Updates />;
}

function Updates() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('owner_releases');
    if (error) return toast(error.message, 'error');
    setData(data);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(r: Release, action: string, confirmText: string) {
    if (!confirm(confirmText)) return;
    setBusy(`${r.id}${action}`);
    const { data: res, error } = await sb().rpc('owner_release_decide', { p_id: r.id, p_action: action });
    setBusy(null);
    if (error || res?.error) return toast(res?.error || error?.message || 'שגיאה', 'error');
    toast('נשמר');
    load();
  }

  if (!data) return <Spinner />;
  const h = data.health;
  const engAge = h.engine_seen ? (Date.now() - Date.parse(h.engine_seen)) / 1000 : null;
  const engOk = engAge !== null && engAge < 120;
  const waiting = data.releases.filter((r) => r.status === 'pending');
  const inFlight = data.releases.filter((r) => ['approved', 'deploying', 'verifying', 'rollback_requested'].includes(r.status));
  const history = data.releases.filter((r) => !waiting.includes(r) && !inFlight.includes(r));
  const live = (c: string) => data.live.find((l) => l.component === c);

  return (
    <>
      <PageHeader title="ניהול עדכונים" subtitle="שום עדכון לא עולה לאוויר בלי אישור שלך. כל עדכון נבדק אחרי העלייה, ואם משהו לא תקין – חוזר אוטומטית לגרסה הקודמת." />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="גרסת הממשק" value={live('web')?.version || live('web')?.commit || '—'} sub={live('web') ? `מאז ${fmt(live('web')!.since)}` : 'עוד לא עודכן דרך המרכז'} icon={<Monitor className="h-5 w-5" />} tone="sky" />
        <Stat label="גרסת המנוע" value={live('engine')?.version || live('engine')?.commit || '—'} sub={live('engine') ? `מאז ${fmt(live('engine')!.since)}` : 'עוד לא עודכן דרך המרכז'} icon={<Smartphone className="h-5 w-5" />} tone="violet" />
        <Stat label="זרועות מחוברות" value={`${h.arms_online}/${h.arms_active}`} sub={engOk ? 'המנוע מדווח' : 'המנוע לא דיווח לאחרונה'} icon={<HeartPulse className="h-5 w-5" />} tone={h.arms_online === h.arms_active && engOk ? 'green' : 'red'} />
        <Stat label="הפצות פעילות" value={h.campaigns_running} sub="עדכון מנוע ממתין לסיומן" icon={<Rocket className="h-5 w-5" />} tone="amber" />
      </div>

      <h2 className="mb-2 mt-6 text-lg font-semibold">ממתינים לאישור</h2>
      {waiting.length === 0 ? (
        <Card>
          <Empty icon={<CheckCircle2 className="h-8 w-8" />} title="אין עדכונים שממתינים" text="כשיהיה עדכון חדש הוא יופיע כאן עם הסבר מה משתנה." />
        </Card>
      ) : (
        <div className="space-y-3">
          {waiting.map((r) => (
            <ReleaseCard key={r.id} r={r}>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="success"
                  loading={busy === `${r.id}approve_now`}
                  onClick={() => act(r, 'approve_now', r.restart_engine ? 'העדכון יפעיל מחדש את מנוע הזרועות (ניתוק קצר). לפרוס עכשיו?' : 'לפרוס את העדכון עכשיו?')}
                >
                  <Rocket className="h-4 w-4" />
                  אישור – עכשיו
                </Button>
                <Button variant="secondary" loading={busy === `${r.id}approve_night`} onClick={() => act(r, 'approve_night', 'לפרוס הלילה ב־03:00?')}>
                  <Moon className="h-4 w-4" />
                  אישור – הלילה 03:00
                </Button>
                <Button variant="danger" loading={busy === `${r.id}reject`} onClick={() => act(r, 'reject', 'לדחות את העדכון? הוא לא יעלה.')}>
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
          <h2 className="mb-2 mt-6 text-lg font-semibold">בתהליך</h2>
          <div className="space-y-3">
            {inFlight.map((r) => (
              <ReleaseCard key={r.id} r={r}>
                {r.status === 'approved' && (
                  <Button className="mt-4" variant="danger" size="sm" onClick={() => act(r, 'reject', 'לבטל את העדכון לפני שהוא עולה?')}>
                    ביטול
                  </Button>
                )}
                {r.status === 'verifying' && (
                  <Button className="mt-4" variant="danger" size="sm" onClick={() => act(r, 'rollback', 'לחזור עכשיו לגרסה הקודמת?')}>
                    <RotateCcw className="h-4 w-4" />
                    חזרה לגרסה הקודמת
                  </Button>
                )}
              </ReleaseCard>
            ))}
          </div>
        </>
      )}

      <h2 className="mb-2 mt-6 text-lg font-semibold">היסטוריית עדכונים</h2>
      {history.length === 0 ? (
        <Card>
          <Empty title="עדיין אין היסטוריה" />
        </Card>
      ) : (
        <div className="space-y-3">
          {history.map((r) => (
            <ReleaseCard key={r.id} r={r} compact>
              {r.status === 'live' && (
                <Button className="mt-3" variant="danger" size="sm" onClick={() => act(r, 'rollback', 'לחזור לגרסה שהייתה לפני העדכון הזה?')}>
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

function ReleaseCard({ r, compact, children }: { r: Release; compact?: boolean; children?: React.ReactNode }) {
  const [open, setOpen] = useState(!compact);
  const st = STATUS[r.status] || { label: r.status, tone: 'slate' };
  const risk = RISK[r.disconnect_risk];
  const samples = r.health?.samples || [];
  const last = samples[samples.length - 1];
  return (
    <Card className="p-4 md:p-5">
      <button className="flex w-full flex-wrap items-center gap-2 text-right" onClick={() => setOpen(!open)}>
        <span className="font-mono text-sm text-slate-500">{r.version}</span>
        <span className="flex-1 font-semibold">{r.title}</span>
        <Badge tone={st.tone} dot>
          {st.label}
        </Badge>
      </button>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {r.components.map((c) => {
              const C = COMP[c];
              return (
                <Badge key={c} tone="slate">
                  <C.icon className="h-3.5 w-3.5" />
                  {C.label}
                </Badge>
              );
            })}
            <Badge tone={risk.tone}>{risk.label}</Badge>
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
            <div className="flex gap-2 rounded-xl bg-amber-50 p-3 text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
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
            <span className="font-mono">{r.commit}</span>
          </div>
          {last && (
            <div className={cx('rounded-xl p-3 text-xs', r.health?.bad ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800')}>
              תקינות אחרי העדכון: זרועות מחוברות {last.arms_online}/{last.arms_active}
              {last.engine_age_s !== null && ` · המנוע דיווח לפני ${last.engine_age_s} שניות`} · דגימות חריגות: {r.health?.bad || 0} מתוך {samples.length}
            </div>
          )}
          {r.log.length > 0 && (
            <ol className="space-y-0.5 border-r-2 border-slate-200 pr-3 text-xs text-slate-500">
              {r.log.map((l, i) => (
                <li key={i}>
                  {fmt(l.at)} – {l.msg}
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
