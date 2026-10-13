'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Pause, Play, XCircle, RotateCcw, ShieldAlert, Gauge, SearchX } from 'lucide-react';
import { explain, fmtDuration, fullStats, loadSpeedHistory, speedAt, SettingsSnap } from '@/lib/speed';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { CAMPAIGN_STATUS, TARGET_STATUS, fmtTime } from '@/lib/format';

const TITLE: Record<string, string> = { manual: 'הפצה ידנית', help: 'הפצת עזרה', quote: 'הפצה מציטוט' };
import { Badge, Button, Card, Empty, PageHeader, Progress, Section, Segmented, Skeleton, ask, cx, toast } from '@/components/ui';
import { allRows } from '@/lib/allRows';

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
      allRows(() => sb().from('campaign_targets').select('*').eq('campaign_id', id).order('id')),
      sb().from('arms').select('id,name'),
      sb().from('campaign_arms').select('arm_id').eq('campaign_id', id), // rows: bounded – the arms of one ride
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

  const back = (
    <Link href="/history" className="mb-3 inline-flex h-8 items-center gap-1 rounded-lg text-sm font-medium text-slate-500 hover:text-slate-900">
      <ArrowRight className="h-4 w-4" />
      חזרה להיסטוריה
    </Link>
  );

  if (!c)
    return (
      <>
        {back}
        <div className="space-y-4" role="status" aria-label="טוען">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
          <div className="grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-56 lg:col-span-2" />
            <Skeleton className="h-56" />
          </div>
          <Skeleton className="h-64" />
        </div>
      </>
    );
  if (!c.id)
    return (
      <>
        {back}
        <Card>
          <Empty icon={<SearchX className="h-7 w-7" />} title="ההפצה לא נמצאה" text="ייתכן שהיא נמחקה, או שהקישור שייך לתחנה אחרת." />
        </Card>
      </>
    );

  const sent = counts.sent || 0;
  const failed = counts.failed || 0;
  const done = sent + failed + (counts.skipped || 0);
  const inProgress = c.total - done;
  const active = ['queued', 'running'].includes(c.status);
  const st = CAMPAIGN_STATUS[c.status];

  async function setStatus(status: string, action: string) {
    const { error } = await sb().from('campaigns').update({ status, ...(status === 'cancelled' ? { finished_at: new Date().toISOString() } : {}) }).eq('id', id);
    if (error) return toast(`הפעולה לא בוצעה: ${error.message}`, 'error');
    if (status === 'cancelled') await sb().from('campaign_targets').update({ status: 'skipped' }).eq('campaign_id', id).eq('status', 'pending');
    await logAct(action, 'campaign', id);
    toast(status === 'paused' ? 'ההפצה הושהתה' : status === 'running' ? 'ההפצה ממשיכה' : 'ההפצה בוטלה');
    load();
  }
  async function retry() {
    const { data, error } = await sb().rpc('retry_failed', { p_campaign: id });
    if (error) return toast(`השליחה החוזרת לא התחילה: ${error.message}`, 'error');
    toast(`${data} קבוצות נשלחות שוב`);
    load();
  }
  async function cancel() {
    if (await ask({ title: 'לבטל את ההפצה?', text: 'מה שכבר נשלח יישאר בקבוצות. הקבוצות שעוד לא קיבלו – לא יקבלו.', ok: 'ביטול ההפצה', danger: true }))
      setStatus('cancelled', 'campaign_cancelled');
  }

  const shown = filter ? targets.filter((t) => t.status === filter) : targets;
  const tabs = [{ value: '', label: 'הכול', count: targets.length }, ...Object.entries(TARGET_STATUS).map(([k, v]) => ({ value: k, label: v.label, count: counts[k] || 0 }))];

  return (
    <>
      {back}
      <PageHeader
        title={TITLE[c.kind] || 'הפצה'}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={st?.tone} dot>
              {st?.label || c.status}
            </Badge>
            <span className="tabular-nums">
              נוצרה {fmtTime(c.created_at)}
              {c.finished_at && ` · הסתיימה ${fmtTime(c.finished_at)}`}
            </span>
          </span>
        }
        actions={
          can('operator') ? (
            <>
              {active && (
                <Button variant="secondary" onClick={() => setStatus('paused', 'campaign_paused')}>
                  <Pause className="h-4 w-4" />
                  השהיה
                </Button>
              )}
              {c.status === 'paused' && (
                <Button variant="success" onClick={() => setStatus('running', 'campaign_resumed')}>
                  <Play className="h-4 w-4" />
                  המשך שליחה
                </Button>
              )}
              {(active || c.status === 'paused' || c.status === 'pending_phone') && (
                <Button variant="danger" onClick={cancel}>
                  <XCircle className="h-4 w-4" />
                  ביטול ההפצה
                </Button>
              )}
              {failed > 0 && !active && (
                <Button onClick={retry}>
                  <RotateCcw className="h-4 w-4" />
                  שליחה חוזרת ל-<span className="tabular-nums">{failed}</span> שנכשלו
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 md:p-5 lg:col-span-2">
          <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Big label="טופלו" value={`${done}/${c.total}`} />
            <Big label="הצליחו" value={sent} cls="text-emerald-700" />
            <Big label="נכשלו" value={failed} cls={failed ? 'text-rose-700' : undefined} />
            <Big label="בתהליך" value={inProgress} cls={inProgress ? 'text-indigo-600' : undefined} />
          </div>
          <Progress sent={sent} failed={failed} total={c.total} />
          <dl className="mt-5 grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
            {c.kind !== 'manual' && (
              <>
                <Info label="מבקש" value={c.requester_name} />
                <Info label="מספר" value={c.requester_phone ? <span dir="ltr" className="tabular-nums">{c.requester_phone}</span> : null} />
                <Info label="מקור" value={c.source_group_name} />
              </>
            )}
            <Info label="זרועות" value={c.armIds.map((a: string) => arms[a]).filter(Boolean).join(', ') || null} />
            <Info label="התחילה" value={c.started_at ? <span className="tabular-nums">{fmtTime(c.started_at)}</span> : null} />
          </dl>
        </Card>
        <div className="rounded-2xl border border-slate-200/70 bg-[#efeae2] p-4 dark:bg-[#0b141a] md:p-5">
          <div className="mb-3 text-xs font-medium text-[#54656f] dark:text-[#8696a0]">{c.kind === 'quote' ? 'ההודעה שנשלחה (בלי מספר הלקוח)' : 'ההודעה שנשלחה'}</div>
          <div className="wa-bubble mr-auto max-w-full p-3 text-sm shadow-sm">{c.final_text || c.message_text}</div>
          {c.final_text && c.final_text !== c.message_text && (
            <details className="mt-3 text-xs text-[#54656f] dark:text-[#8696a0]">
              <summary className="cursor-pointer py-1 font-medium">ההודעה המקורית</summary>
              <div className="mt-2 whitespace-pre-wrap rounded-lg bg-white/70 p-2.5 text-slate-700 dark:bg-black/20">{c.message_text}</div>
            </details>
          )}
        </div>
      </div>

      <SpeedSummary c={c} targets={targets} arms={arms} />

      {!active && can('operator') && <NoPermissionReview targets={targets} />}

      <Section title="פירוט לפי קבוצה" className="mt-4">
        <div className="scroll-thin overflow-x-auto border-b border-slate-100 px-3 py-2.5">
          <Segmented value={filter} onChange={setFilter} options={tabs} />
        </div>

        {shown.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-500">
            {targets.length === 0 && !active && c?.total > 0
              ? `הפירוט לפי קבוצות נשמר 48 שעות אחרי סיום ההפצה. הסיכום נשמר: נשלח ${c.sent ?? 0} מתוך ${c.total}, נכשל ${c.failed ?? 0}.`
              : 'אין קבוצות בסטטוס הזה.'}
          </div>
        ) : (
          <>
            {/* desktop table */}
            <table className="hidden w-full text-sm md:table">
              <thead className="bg-slate-50 text-right text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 font-medium">קבוצה</th>
                  <th className="px-4 py-2.5 font-medium">זרוע</th>
                  <th className="px-4 py-2.5 font-medium">סטטוס</th>
                  <th className="px-4 py-2.5 font-medium">זמן</th>
                  <th className="px-4 py-2.5 font-medium">סיבה</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((t) => (
                  <tr key={t.id}>
                    <td className="max-w-64 truncate px-5 py-2.5 font-medium text-slate-900">{t.group_name || t.wa_group_id}</td>
                    <td className="px-4 py-2.5 text-slate-600">{arms[t.arm_id] || '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <Badge tone={TARGET_STATUS[t.status]?.tone}>{TARGET_STATUS[t.status]?.label || t.status}</Badge>
                      {t.attempts > 1 && <span className="mr-1.5 text-xs tabular-nums text-slate-500">{t.attempts} ניסיונות</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-500">{fmtTime(t.sent_at)}</td>
                    <td className="max-w-72 px-4 py-2.5 text-xs text-rose-700">{t.status !== 'sent' ? t.error : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* phone: stacked rows */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {shown.map((t) => (
                <li key={t.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 truncate text-sm font-medium text-slate-900">{t.group_name || t.wa_group_id}</div>
                    <Badge tone={TARGET_STATUS[t.status]?.tone}>{TARGET_STATUS[t.status]?.label || t.status}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs tabular-nums text-slate-500">
                    <span>{arms[t.arm_id] || '—'}</span>
                    <span>{fmtTime(t.sent_at)}</span>
                    {t.attempts > 1 && <span>{t.attempts} ניסיונות</span>}
                  </div>
                  {t.status !== 'sent' && t.error && <div className="mt-1 text-xs text-rose-700">{t.error}</div>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </>
  );
}

function Big({ label, value, cls }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={cx('mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-slate-900', cls)}>{value}</div>
    </div>
  );
}
function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-slate-500">{label}:</dt>
      <dd className="min-w-0 break-words font-medium text-slate-900">{value || '—'}</dd>
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
    allRows(() => sb().from('list_groups').select('wa_group_id, distribution_lists(name)').in('wa_group_id', ids).order('wa_group_id').order('list_id'))
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
    if (error) return toast(`הקבוצות לא הוסרו: ${error.message}`, 'error');
    await logAct('list_saved', 'list', null as any, { removed_no_permission: sel.size });
    toast(`${sel.size} קבוצות הוסרו מרשימות ההפצה`);
    setDone(true);
  }

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex items-start gap-3 border-b border-amber-200/70 bg-amber-50 px-4 py-4 md:px-5">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div>
          <div className="font-semibold text-amber-900">
            ב-<span className="tabular-nums">{stillListed.length}</span> קבוצות אין לזרוע הרשאה לשלוח
          </div>
          <div className="mt-0.5 text-sm text-amber-800">להסיר אותן מרשימות ההפצה, כדי שההפצות הבאות יהיו מהירות יותר ובלי כישלונות?</div>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {stillListed.map((g) => (
          <li key={g.wa_group_id}>
            <label className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-3 hover:bg-slate-50 md:px-5">
              <input
                type="checkbox"
                className="h-[18px] w-[18px] shrink-0 rounded border-slate-300 accent-indigo-600"
                checked={sel.has(g.wa_group_id)}
                onChange={(e) => {
                  const n = new Set(sel);
                  e.target.checked ? n.add(g.wa_group_id) : n.delete(g.wa_group_id);
                  setSel(n);
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-900">{g.group_name || g.wa_group_id}</div>
                <div className="truncate text-xs text-slate-500">ברשימות: {inLists[g.wa_group_id].join(', ')}</div>
              </div>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-4 py-3 md:px-5">
        <Button variant="ghost" onClick={() => setDone(true)}>
          להשאיר אותן
        </Button>
        <Button onClick={remove} loading={busy} disabled={!sel.size}>
          הסרת <span className="tabular-nums">{sel.size}</span> מרשימות ההפצה
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
    <Section title="סיכום מהירות" icon={<Gauge className="h-4 w-4" />} className="mt-4" bodyClass="p-4 md:p-5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Mini label="קצב שהוגדר" value={speedAt(hist, c.created_at)} />
        <Mini label="קצב בפועל" value={s.perMin != null ? `${s.perMin.toFixed(1)} בדקה` : '—'} />
        <Mini label="זמן שליחה" value={fmtDuration(s.sendSec)} hint="מההודעה הראשונה עד האחרונה" />
        <Mini label="המתנה בתור" value={fmtDuration(s.waitSec)} hint="מהבקשה עד תחילת השליחה" />
        <Mini label="זמן כולל" value={fmtDuration(s.totalSec)} />
        <Mini label="ניסיונות חוזרים" value={s.retries} />
      </div>

      {perArm.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 text-sm">
          <span className="text-slate-500">לפי זרוע:</span>
          {perArm.map(([id, n]) => (
            <span key={id} className="rounded-lg bg-slate-100 px-2 py-0.5 text-slate-700">
              {arms[id] || 'זרוע'} · <b className="font-semibold tabular-nums">{n}</b>
            </span>
          ))}
        </div>
      )}

      {s.perMinute.length > 1 && (
        <div className="mt-5">
          <div className="mb-2 text-xs font-medium text-slate-500">הודעות שיצאו בכל דקה</div>
          <div className="flex h-24 items-end gap-1" dir="ltr" role="img" aria-label="גרף הודעות לדקה">
            {s.perMinute.map((p) => (
              <div key={p.label} className="flex flex-1 flex-col items-center justify-end" title={`דקה ${p.label}: ${p.n}`}>
                <span className="mb-0.5 text-[10px] tabular-nums text-slate-500">{p.n || ''}</span>
                <div className="w-full rounded-t bg-indigo-400" style={{ height: `${(p.n / maxBar) * 72}px`, minHeight: p.n ? 2 : 0 }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] tabular-nums text-slate-500" dir="ltr">
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
              <li key={r} className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
                <span className="min-w-0">{r}</span>
                <b className="shrink-0 tabular-nums">{n}</b>
              </li>
            ))}
          </ul>
        </div>
      )}

      {why.length > 0 && (
        <div className="mt-5 flex gap-2.5 rounded-xl bg-amber-50 p-3.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0">
            <div className="mb-1 font-semibold">מה קרה בהפצה הזו</div>
            <ul className="list-disc space-y-1 pr-5">
              {why.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Section>
  );
}

function Mini({ label, value, hint }: { label: string; value: any; hint?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3" title={hint}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] leading-snug text-slate-500 lg:hidden">{hint}</div>}
    </div>
  );
}
