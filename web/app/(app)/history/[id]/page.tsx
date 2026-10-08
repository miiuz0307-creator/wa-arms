'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Pause, Play, XCircle, RotateCcw, ShieldAlert, Gauge } from 'lucide-react';
import { explain, fmtDuration, fullStats, loadSpeedHistory, speedAt, SettingsSnap } from '@/lib/speed';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { CAMPAIGN_STATUS, TARGET_STATUS, fmtTime } from '@/lib/format';

const TITLE: Record<string, string> = { manual: 'הפצה ידנית', help: 'הפצת עזרה', quote: 'הפצה מציטוט' };
import { Badge, Button, Card, Progress, Spinner, cx, toast } from '@/components/ui';

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const [c, setC] = useState<any>(null);
  const [targets, setTargets] = useState<any[]>([]);
  const [arms, setArms] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    const [cr, tr, ar, ca] = await Promise.all([
      sb().from('campaigns').select('*').eq('id', id).single(),
      sb().from('campaign_targets').select('*').eq('campaign_id', id).order('id').limit(5000),
      sb().from('arms').select('id,name'),
      sb().from('campaign_arms').select('arm_id').eq('campaign_id', id),
    ]);
    setC({ ...cr.data, armIds: (ca.data || []).map((r: any) => r.arm_id) });
    setTargets(tr.data || []);
    setArms(Object.fromEntries((ar.data || []).map((a: any) => [a.id, a.name])));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['campaign_targets'], load, `campaign_id=eq.${id}`);
  useRealtime(['campaigns'], load, `id=eq.${id}`);

  const counts = useMemo(() => {
    const r: Record<string, number> = {};
    for (const t of targets) r[t.status] = (r[t.status] || 0) + 1;
    return r;
  }, [targets]);

  if (!c) return <Spinner />;
  if (!c.id) return <div className="py-20 text-center text-slate-500">ההפצה לא נמצאה</div>;

  const sent = counts.sent || 0;
  const failed = counts.failed || 0;
  const done = sent + failed + (counts.skipped || 0);
  const inProgress = c.total - done;
  const active = ['queued', 'running'].includes(c.status);

  async function setStatus(status: string, action: string) {
    const { error } = await sb().from('campaigns').update({ status, ...(status === 'cancelled' ? { finished_at: new Date().toISOString() } : {}) }).eq('id', id);
    if (error) return toast(error.message, 'error');
    if (status === 'cancelled') await sb().from('campaign_targets').update({ status: 'skipped' }).eq('campaign_id', id).eq('status', 'pending');
    await logAct(action, 'campaign', id);
    load();
  }
  async function retry() {
    const { data, error } = await sb().rpc('retry_failed', { p_campaign: id });
    if (error) return toast(error.message, 'error');
    toast(`${data} קבוצות נשלחות שוב`);
    load();
  }

  const shown = filter ? targets.filter((t) => t.status === filter) : targets;

  return (
    <>
      <Link href="/history" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowRight className="h-4 w-4" />
        להיסטוריה
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{TITLE[c.kind] || 'הפצה'}</h1>
            <Badge tone={CAMPAIGN_STATUS[c.status]?.tone} dot>
              {CAMPAIGN_STATUS[c.status]?.label}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            נוצרה {fmtTime(c.created_at)}
            {c.finished_at && ` · הסתיימה ${fmtTime(c.finished_at)}`}
          </p>
        </div>
        {can('operator') && (
          <div className="flex flex-wrap gap-2">
            {active && (
              <Button variant="secondary" onClick={() => setStatus('paused', 'campaign_paused')}>
                <Pause className="h-4 w-4" />
                השהה
              </Button>
            )}
            {c.status === 'paused' && (
              <Button variant="success" onClick={() => setStatus('running', 'campaign_resumed')}>
                <Play className="h-4 w-4" />
                המשך
              </Button>
            )}
            {(active || c.status === 'paused' || c.status === 'pending_phone') && (
              <Button variant="danger" onClick={() => confirm('לבטל את ההפצה? מה שנשלח כבר יישאר.') && setStatus('cancelled', 'campaign_cancelled')}>
                <XCircle className="h-4 w-4" />
                ביטול
              </Button>
            )}
            {failed > 0 && !active && (
              <Button onClick={retry}>
                <RotateCcw className="h-4 w-4" />
                שלח שוב ל-{failed} שנכשלו
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Big label="נשלחו" value={`${done}/${c.total}`} />
            <Big label="הצליחו" value={sent} cls="text-emerald-600" />
            <Big label="נכשלו" value={failed} cls="text-rose-600" />
            <Big label="בתהליך" value={inProgress} cls="text-violet-600" />
          </div>
          <Progress sent={sent} failed={failed} total={c.total} />
          <dl className="mt-5 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {c.kind !== 'manual' && (
              <>
                <Info label="מבקש" value={c.requester_name} />
                <Info label="מספר" value={<span dir="ltr">{c.requester_phone || '—'}</span>} />
                <Info label="מקור" value={c.source_group_name} />
              </>
            )}
            <Info label="זרועות" value={c.armIds.map((a: string) => arms[a]).filter(Boolean).join(', ') || '—'} />
            <Info label="התחילה" value={fmtTime(c.started_at)} />
          </dl>
        </Card>
        <Card className="bg-[#efeae2] p-5">
          <div className="mb-2 text-xs font-medium text-slate-500">{c.kind === 'quote' ? 'ההודעה שנשלחה (בלי מספר הלקוח)' : 'ההודעה שנשלחה'}</div>
          <div className="wa-bubble mr-auto max-w-full p-3 text-sm shadow-sm">{c.final_text || c.message_text}</div>
          {c.final_text && c.final_text !== c.message_text && (
            <details className="mt-3 text-xs text-slate-600">
              <summary className="cursor-pointer">ההודעה המקורית</summary>
              <div className="mt-2 whitespace-pre-wrap rounded-lg bg-white/70 p-2">{c.message_text}</div>
            </details>
          )}
        </Card>
      </div>

      <SpeedSummary c={c} targets={targets} arms={arms} />

      {!active && can('operator') && <NoPermissionReview targets={targets} />}

      <Card className="mt-4">
        <div className="scroll-thin flex gap-1 overflow-x-auto border-b border-slate-100 p-2">
          {[['', 'הכול', targets.length], ...Object.entries(TARGET_STATUS).map(([k, v]) => [k, v.label, counts[k] || 0])].map(([k, label, n]) => (
            <button
              key={k as string}
              onClick={() => setFilter(k as string)}
              className={cx('shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium', filter === k ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-50')}
            >
              {label} <span className="text-xs opacity-70">{n}</span>
            </button>
          ))}
        </div>
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-right text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">קבוצה</th>
                <th className="px-4 py-2.5 font-medium">זרוע</th>
                <th className="px-4 py-2.5 font-medium">סטטוס</th>
                <th className="px-4 py-2.5 font-medium">זמן</th>
                <th className="px-4 py-2.5 font-medium">סיבה</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((t) => (
                <tr key={t.id}>
                  <td className="max-w-56 truncate px-4 py-2.5 font-medium">{t.group_name || t.wa_group_id}</td>
                  <td className="px-4 py-2.5 text-slate-600">{arms[t.arm_id] || '—'}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={TARGET_STATUS[t.status]?.tone}>{TARGET_STATUS[t.status]?.label}</Badge>
                    {t.attempts > 1 && <span className="mr-1 text-xs text-slate-400">({t.attempts} ניסיונות)</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">{fmtTime(t.sent_at)}</td>
                  <td className="max-w-72 px-4 py-2.5 text-xs text-rose-700">{t.status !== 'sent' ? t.error : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <div className="p-8 text-center text-sm text-slate-500">אין שורות</div>}
        </div>
      </Card>
    </>
  );
}

function Big({ label, value, cls }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={cx('text-2xl font-bold tabular-nums', cls)}>{value}</div>
    </div>
  );
}
function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500">{label}:</dt>
      <dd className="font-medium">{value || '—'}</dd>
    </div>
  );
}

const isNoPermission = (t: any) => /אין הרשאה|רק מנהלים/i.test(t.error || '') && t.status !== 'sent';

function NoPermissionReview({ targets }: { targets: any[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, any>();
    for (const t of targets) if (isNoPermission(t) && !m.has(t.wa_group_id)) m.set(t.wa_group_id, t);
    return [...m.values()];
  }, [targets]);
  const [inLists, setInLists] = useState<Record<string, string[]>>({});
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!groups.length) return;
    const ids = groups.map((g) => g.wa_group_id);
    sb()
      .from('list_groups')
      .select('wa_group_id, distribution_lists(name)')
      .in('wa_group_id', ids)
      .then(({ data }) => {
        const m: Record<string, string[]> = {};
        for (const r of (data as any[]) || []) (m[r.wa_group_id] ||= []).push(r.distribution_lists?.name || '');
        setInLists(m);
        setSel(new Set(Object.keys(m)));
      });
  }, [groups]);

  const stillListed = groups.filter((g) => inLists[g.wa_group_id]?.length);
  if (done || !stillListed.length) return null;

  async function remove() {
    if (!sel.size) return;
    setBusy(true);
    const { error } = await sb().from('list_groups').delete().in('wa_group_id', [...sel]);
    setBusy(false);
    if (error) return toast(error.message, 'error');
    await logAct('list_saved', 'list', null as any, { removed_no_permission: sel.size });
    toast(`${sel.size} קבוצות הוסרו מרשימות ההפצה`);
    setDone(true);
  }

  return (
    <Card className="mt-4 border-amber-200">
      <div className="flex items-start gap-3 border-b border-amber-100 bg-amber-50/70 px-5 py-4">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div>
          <div className="font-semibold text-amber-900">
            ב-{stillListed.length} קבוצות אין לזרוע הרשאה לשלוח
          </div>
          <div className="text-sm text-amber-800">להסיר אותן מרשימות ההפצה, כדי שההפצות הבאות יהיו מהירות ובלי כישלונות?</div>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {stillListed.map((g) => (
          <li key={g.wa_group_id}>
            <label className="flex cursor-pointer items-center gap-3 px-5 py-3">
              <input
                type="checkbox"
                className="h-4 w-4 accent-indigo-600"
                checked={sel.has(g.wa_group_id)}
                onChange={(e) => {
                  const n = new Set(sel);
                  e.target.checked ? n.add(g.wa_group_id) : n.delete(g.wa_group_id);
                  setSel(n);
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{g.group_name || g.wa_group_id}</div>
                <div className="truncate text-xs text-slate-500">ברשימות: {inLists[g.wa_group_id].join(', ')}</div>
              </div>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 p-3">
        <Button variant="ghost" onClick={() => setDone(true)}>
          השאר אותן
        </Button>
        <Button onClick={remove} loading={busy} disabled={!sel.size}>
          הסר {sel.size} מרשימות ההפצה
        </Button>
      </div>
    </Card>
  );
}

function SpeedSummary({ c, targets, arms }: { c: any; targets: any[]; arms: Record<string, string> }) {
  const [hist, setHist] = useState<SettingsSnap[]>([]);
  useEffect(() => {
    loadSpeedHistory().then(setHist);
  }, []);
  const s = useMemo(() => fullStats(c, targets), [c, targets]);
  const why = useMemo(() => explain(c, s, targets), [c, s, targets]);
  const perArm = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of targets) if (t.status === 'sent' && t.arm_id) m[t.arm_id] = (m[t.arm_id] || 0) + 1;
    return Object.entries(m);
  }, [targets]);
  const maxBar = Math.max(1, ...s.perMinute.map((p) => p.n));

  return (
    <Card className="mt-4 p-5">
      <div className="mb-4 flex items-center gap-2 font-semibold">
        <Gauge className="h-5 w-5 text-indigo-500" />
        סיכום מהירות
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Mini label="מהירות שהוגדרה" value={speedAt(hist, c.created_at)} />
        <Mini label="מהירות בפועל" value={s.perMin != null ? `${s.perMin.toFixed(1)} בדקה` : '—'} />
        <Mini label="זמן שליחה" value={fmtDuration(s.sendSec)} hint="מההודעה הראשונה עד האחרונה" />
        <Mini label="המתנה בתור" value={fmtDuration(s.waitSec)} hint="מהבקשה עד תחילת השליחה" />
        <Mini label="זמן כולל" value={fmtDuration(s.totalSec)} />
        <Mini label="ניסיונות חוזרים" value={s.retries} />
      </div>

      {perArm.length > 0 && (
        <div className="mt-4 text-sm text-slate-600">
          לפי זרוע: {perArm.map(([id, n]) => `${arms[id] || 'זרוע'} – ${n}`).join(' · ')}
        </div>
      )}

      {s.perMinute.length > 1 && (
        <div className="mt-5">
          <div className="mb-2 text-xs font-medium text-slate-500">הודעות שיצאו בכל דקה</div>
          <div className="flex h-24 items-end gap-1" dir="ltr">
            {s.perMinute.map((p) => (
              <div key={p.label} className="flex flex-1 flex-col items-center justify-end" title={`דקה ${p.label}: ${p.n}`}>
                <span className="mb-0.5 text-[10px] tabular-nums text-slate-500">{p.n || ''}</span>
                <div className="w-full rounded-t bg-indigo-400" style={{ height: `${(p.n / maxBar) * 72}px`, minHeight: p.n ? 2 : 0 }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-slate-400" dir="ltr">
            <span>דקה 1</span>
            <span>דקה {s.perMinute.length}</span>
          </div>
        </div>
      )}

      {s.reasons.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-xs font-medium text-slate-500">למה קבוצות לא קיבלו את ההודעה</div>
          <ul className="space-y-1 text-sm">
            {s.reasons.map(([r, n]) => (
              <li key={r} className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5">
                <span>{r}</span>
                <b className="tabular-nums">{n}</b>
              </li>
            ))}
          </ul>
        </div>
      )}

      {why.length > 0 && (
        <div className="mt-5 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          <div className="mb-1 font-semibold">מה קרה בהפצה הזו</div>
          <ul className="list-disc space-y-1 pr-5">
            {why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Mini({ label, value, hint }: { label: string; value: any; hint?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3" title={hint}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
    </div>
  );
}
