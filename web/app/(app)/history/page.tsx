'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { History as HistoryIcon, Search, LifeBuoy, Send, Quote } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { CAMPAIGN_STATUS, firstLine, fmtTime } from '@/lib/format';
import { Badge, Card, Empty, Input, PageHeader, Progress, Select, Spinner } from '@/components/ui';

export default function HistoryPage() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
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

  return (
    <>
      <PageHeader title="היסטוריה" subtitle="כל ההפצות – ידניות ואוטומטיות" />
      <Card className="mb-4 grid gap-3 p-4 md:grid-cols-4">
        <div className="relative">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input placeholder="חיפוש בהודעה, שם או מספר" value={q} onChange={(e) => setQ(e.target.value)} className="pr-9" />
        </div>
        <Select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">כל הסוגים</option>
          <option value="manual">ידני</option>
          <option value="help">עזרה (אוטומטי)</option>
          <option value="quote">ציטוט מקבוצה</option>
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">כל הסטטוסים</option>
          {Object.entries(CAMPAIGN_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="מתאריך" />
      </Card>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <Empty icon={<HistoryIcon className="h-7 w-7" />} title="אין הפצות להצגה" />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {rows.map((c) => (
              <li key={c.id}>
                <Link href={`/history/${c.id}`} className="flex flex-col gap-3 px-5 py-4 hover:bg-slate-50 md:flex-row md:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl ${c.kind === 'help' ? 'bg-pink-50 text-pink-600' : c.kind === 'quote' ? 'bg-amber-50 text-amber-600' : 'bg-indigo-50 text-indigo-600'}`}>
                      {c.kind === 'help' ? <LifeBuoy className="h-4 w-4" /> : c.kind === 'quote' ? <Quote className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        <span className="text-slate-500">{fmtTime(c.created_at)} – </span>
                        {firstLine(c.message_text)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-500">
                        {c.kind !== 'manual' && (
                          <>
                            <span>מבקש: {c.requester_name || '—'}</span>
                            <span dir="ltr">{c.requester_phone || 'אין מספר'}</span>
                            <span>מקור: {c.source_group_name || '—'}</span>
                          </>
                        )}
                        <span>זרועות: {c.campaign_arms?.[0]?.count ?? 0}</span>
                        <span>יעדים: {c.total}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 md:w-80">
                    <div className="flex-1">
                      <Progress sent={c.sent} failed={c.failed} total={c.total} />
                      <div className="mt-1 flex gap-3 text-xs">
                        <span className="text-emerald-700">הצליח {c.sent}</span>
                        <span className="text-rose-700">נכשל {c.failed}</span>
                      </div>
                    </div>
                    <Badge tone={CAMPAIGN_STATUS[c.status]?.tone} dot>
                      {CAMPAIGN_STATUS[c.status]?.label}
                    </Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
