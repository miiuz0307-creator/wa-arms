'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Pause, Play, XCircle, RotateCcw } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { CAMPAIGN_STATUS, TARGET_STATUS, fmtTime } from '@/lib/format';
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
            <h1 className="text-2xl font-bold">{c.kind === 'help' ? 'הפצת עזרה' : 'הפצה ידנית'}</h1>
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
            {c.kind === 'help' && (
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
          <div className="mb-2 text-xs font-medium text-slate-500">ההודעה שנשלחה</div>
          <div className="wa-bubble mr-auto max-w-full p-3 text-sm shadow-sm">{c.final_text || c.message_text}</div>
          {c.final_text && c.final_text !== c.message_text && (
            <details className="mt-3 text-xs text-slate-600">
              <summary className="cursor-pointer">ההודעה המקורית</summary>
              <div className="mt-2 whitespace-pre-wrap rounded-lg bg-white/70 p-2">{c.message_text}</div>
            </details>
          )}
        </Card>
      </div>

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
