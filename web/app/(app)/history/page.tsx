'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, History as HistoryIcon, Search, LifeBuoy, Send, Quote } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { CAMPAIGN_STATUS, firstLine, fmtTime } from '@/lib/format';
import { Badge, Button, Card, Empty, Input, PageHeader, Progress, Select, Skeleton, cx } from '@/components/ui';
import { fmtDuration, loadSpeedHistory, quickStats, speedAt, SettingsSnap } from '@/lib/speed';

const KIND: Record<string, { label: string; icon: any; cls: string }> = {
  manual: { label: 'ידני', icon: Send, cls: 'bg-indigo-50 text-indigo-600' },
  help: { label: 'עזרה', icon: LifeBuoy, cls: 'bg-sky-50 text-sky-700' },
  quote: { label: 'ציטוט', icon: Quote, cls: 'bg-slate-100 text-slate-600' },
};

export default function HistoryPage() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [q, setQ] = useState('');
  const [hist, setHist] = useState<SettingsSnap[]>([]);
  useEffect(() => {
    loadSpeedHistory().then(setHist);
  }, []);

  const load = useCallback(async () => {
    // rows: bounded – the latest 200 rides (limit)
    let query = sb().from('campaigns').select('*, campaign_arms(count)').order('created_at', { ascending: false }).limit(200);
    if (kind) query = query.eq('kind', kind);
    if (status) query = query.eq('status', status);
    if (from) query = query.gte('created_at', new Date(from).toISOString());
    if (q.trim()) query = query.or(`message_text.ilike.%${q.trim()}%,requester_name.ilike.%${q.trim()}%,requester_phone.ilike.%${q.trim()}%`);
    const { data } = await query;
    setRows(data || []);
  }, [kind, status, from, q]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  useRealtime(['campaigns'], load);

  const filtered = !!(kind || status || from || q.trim());
  const clear = () => {
    setKind('');
    setStatus('');
    setFrom('');
    setQ('');
  };

  return (
    <>
      <PageHeader title="היסטוריה" subtitle="כל ההפצות של התחנה – ידניות, מ&quot;עזרה&quot; ומציטוט. לחיצה על הפצה מראה לאן הגיעה ולמה נכשלה." />
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-2 md:p-4 lg:grid-cols-4">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input placeholder="חיפוש בהודעה, שם או מספר" aria-label="חיפוש" value={q} onChange={(e) => setQ(e.target.value)} className="pr-9" />
        </div>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="סוג הפצה">
          <option value="">כל הסוגים</option>
          <option value="manual">ידני</option>
          <option value="help">עזרה (אוטומטי)</option>
          <option value="quote">ציטוט מקבוצה</option>
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="סטטוס">
          <option value="">כל הסטטוסים</option>
          {Object.entries(CAMPAIGN_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="מתאריך" aria-label="מתאריך" />
      </Card>

      {!rows ? (
        <Card>
          <ul className="divide-y divide-slate-100" role="status" aria-label="טוען">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="flex items-start gap-3 px-5 py-4">
                <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-2 w-full md:w-80" />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          {filtered ? (
            <Empty
              icon={<Search className="h-7 w-7" />}
              title="אין הפצות שמתאימות לסינון"
              text="נסה מילה אחרת או תאריך מוקדם יותר."
              action={
                <Button variant="secondary" onClick={clear}>
                  ניקוי הסינון
                </Button>
              }
            />
          ) : (
            <Empty
              icon={<HistoryIcon className="h-7 w-7" />}
              title="עדיין לא היו הפצות"
              text="כל הפצה – ידנית או מ&quot;עזרה&quot; בוואטסאפ – תופיע כאן עם הפירוט המלא."
              action={
                <Link
                  href="/send"
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Send className="h-4 w-4" />
                  שליחת הודעה
                </Link>
              }
            />
          )}
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {rows.map((c) => {
              const k = KIND[c.kind] || KIND.manual;
              const st = CAMPAIGN_STATUS[c.status];
              const qs = quickStats(c);
              return (
                <li key={c.id}>
                  <Link href={`/history/${c.id}`} className="group flex flex-col gap-3 px-4 py-4 transition hover:bg-slate-50 md:flex-row md:items-center md:px-5">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div className={cx('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl', k.cls)} title={k.label}>
                        <k.icon className="h-4 w-4" aria-hidden />
                        <span className="sr-only">{k.label}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 truncate font-medium text-slate-900">
                            <span className="tabular-nums text-slate-500">{fmtTime(c.created_at)} · </span>
                            {firstLine(c.message_text) || '—'}
                          </div>
                          <span className="shrink-0 md:hidden">
                            <Badge tone={st?.tone} dot>
                              {st?.label || c.status}
                            </Badge>
                          </span>
                        </div>
                        {c.kind !== 'manual' && (
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600">
                            <span>מבקש: {c.requester_name || '—'}</span>
                            <span dir="ltr" className="tabular-nums">
                              {c.requester_phone || 'אין מספר'}
                            </span>
                            <span className="min-w-0 truncate">מקור: {c.source_group_name || '—'}</span>
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-slate-500">
                          <span>זרועות {c.campaign_arms?.[0]?.count ?? 0}</span>
                          <span>יעדים {c.total}</span>
                          <span>קצב שהוגדר {speedAt(hist, c.created_at)}</span>
                          <span>משך {fmtDuration(qs.sec)}</span>
                          <span>בפועל {qs.perMin != null ? `${qs.perMin.toFixed(1)} בדקה` : '—'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 ps-12 md:w-80 md:ps-0">
                      <div className="flex-1">
                        <Progress sent={c.sent} failed={c.failed} total={c.total} />
                        <div className="mt-1 flex gap-3 text-xs tabular-nums">
                          <span className="text-emerald-700">הצליחו {c.sent}</span>
                          <span className={c.failed ? 'text-rose-700' : 'text-slate-500'}>נכשלו {c.failed}</span>
                        </div>
                      </div>
                      <span className="hidden md:inline-flex">
                        <Badge tone={st?.tone} dot>
                          {st?.label || c.status}
                        </Badge>
                      </span>
                      <ChevronLeft className="hidden h-4 w-4 shrink-0 text-slate-300 group-hover:text-slate-500 md:block" aria-hidden />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {rows && rows.length >= 200 && <p className="mt-3 text-center text-xs text-slate-500">מוצגות 200 ההפצות האחרונות. לתקופה מוקדמת יותר, בחר תאריך בסינון.</p>}
    </>
  );
}
