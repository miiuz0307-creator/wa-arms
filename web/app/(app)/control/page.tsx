'use client';
// Control center: every station on one screen – numbers, live distributions, today's numbers.
// Owner only. Buttons act on any station without entering it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, Ban, LogIn, PauseCircle, PlayCircle, Plug, QrCode, RefreshCw, Send, Smartphone, XCircle } from 'lucide-react';
import { sb, actAsStation } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/hooks';
import { ARM_STATUS, CAMPAIGN_STATUS, KIND_LABEL, firstLine, fmtTime, timeAgo } from '@/lib/format';
import { Badge, Button, Card, Empty, PageHeader, Progress, Select, Spinner, Stat, cx, toast } from '@/components/ui';

type Arm = {
  arm_id: string;
  arm_name: string;
  station_id: string;
  station_name: string;
  is_home: boolean;
  phone: string | null;
  status: string;
  is_active: boolean;
  last_error: string | null;
  last_seen_at: string | null;
  sent_today: number;
  daily_limit: number;
  linked_at: string | null;
  groups_count: number;
};
type Camp = {
  campaign_id: string;
  station_id: string;
  station_name: string;
  kind: string;
  status: string;
  text_preview: string;
  sent: number;
  failed: number;
  total: number;
  created_at: string;
  source_group_name: string | null;
};
type Day = { station_id: string; station_name: string; rides: number; sent: number; failed: number; refused: number };

export default function ControlPage() {
  const { isSuper, loading, station } = useAuth();
  if (loading) return <Spinner />;
  if (!isSuper || station?.acting) return <div className="py-20 text-center text-slate-500">המסך הזה זמין רק למנהל הראשי (מחוץ לתחנה).</div>;
  return <Control />;
}

function Control() {
  const [arms, setArms] = useState<Arm[] | null>(null);
  const [camps, setCamps] = useState<Camp[]>([]);
  const [days, setDays] = useState<Day[]>([]);
  const [only, setOnly] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, c, d] = await Promise.all([sb().rpc('owner_arms'), sb().rpc('owner_active_campaigns'), sb().rpc('owner_today')]);
    if (a.error) toast(a.error.message, 'error');
    setArms((a.data as Arm[]) || []);
    setCamps((c.data as Camp[]) || []);
    setDays((d.data as Day[]) || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['control'], load);

  const stations = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of arms || []) m.set(a.station_id, a.station_name);
    for (const d of days) m.set(d.station_id, d.station_name);
    return [...m.entries()];
  }, [arms, days]);

  const shownArms = (arms || []).filter((a) => !only || a.station_id === only);
  const shownCamps = camps.filter((c) => !only || c.station_id === only);
  const shownDays = days.filter((d) => !only || d.station_id === only);
  const online = shownArms.filter((a) => a.status === 'online').length;
  const problems = shownArms.filter((a) => a.is_active && a.status !== 'online').length;
  const sentToday = shownDays.reduce((s, d) => s + d.sent, 0);

  async function run(key: string, fn: () => PromiseLike<{ error: any }>, ok: string) {
    setBusy(key);
    const { error } = await fn();
    setBusy(null);
    if (error) return toast(error.message, 'error');
    toast(ok);
    load();
  }

  const command = (a: Arm, cmd: 'connect' | 'refresh_groups' | 'reset', ok: string) =>
    run(a.arm_id + cmd, () => sb().rpc('owner_arm_command', { p_arm: a.arm_id, p_command: cmd }), ok);

  return (
    <>
      <PageHeader
        title="מרכז בקרה"
        subtitle="כל התחנות במסך אחד – זרועות, הפצות פעילות ופעילות היום"
        actions={
          <Select value={only} onChange={(e) => setOnly(e.target.value)} className="w-56">
            <option value="">כל התחנות</option>
            {stations.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="זרועות מחוברות" value={`${online}/${shownArms.length}`} icon={<Smartphone className="h-5 w-5" />} tone="green" />
        <Stat label="זרועות עם תקלה" value={problems} icon={<Plug className="h-5 w-5" />} tone={problems ? 'red' : 'slate'} />
        <Stat label="הפצות פעילות" value={shownCamps.length} icon={<Activity className="h-5 w-5" />} tone="violet" />
        <Stat label="נשלחו היום" value={sentToday.toLocaleString('he-IL')} icon={<Send className="h-5 w-5" />} tone="sky" />
      </div>

      {/* live distributions */}
      <Card className="mb-6">
        <div className="border-b border-slate-100 px-5 py-4 font-semibold">הפצות פעילות עכשיו</div>
        {shownCamps.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">אין הפצות פעילות כרגע</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shownCamps.map((c) => (
              <li key={c.campaign_id} className="flex flex-col gap-2 px-5 py-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="slate">{c.station_name}</Badge>
                    <span className="truncate font-medium">{firstLine(c.text_preview, 50) || '—'}</span>
                    <Badge tone={CAMPAIGN_STATUS[c.status]?.tone || 'slate'} dot>
                      {CAMPAIGN_STATUS[c.status]?.label || c.status}
                    </Badge>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3">
                    <div className="flex-1">
                      <Progress sent={c.sent} failed={c.failed} total={c.total} />
                    </div>
                    <span className="text-xs tabular-nums text-slate-500">
                      {c.sent}/{c.total}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {KIND_LABEL[c.kind] || c.kind}
                    {c.source_group_name ? ` · ${c.source_group_name}` : ''} · {fmtTime(c.created_at)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  loading={busy === c.campaign_id}
                  onClick={() =>
                    confirm(`לבטל את ההפצה של ${c.station_name}? מה שנשלח כבר יישאר.`) &&
                    run(c.campaign_id, () => sb().rpc('owner_cancel_campaign', { p_id: c.campaign_id }), 'ההפצה בוטלה')
                  }
                >
                  <XCircle className="h-4 w-4" />
                  ביטול
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* arms of every station */}
      <Card className="mb-6">
        <div className="border-b border-slate-100 px-5 py-4 font-semibold">כל הזרועות</div>
        {!arms ? (
          <Spinner />
        ) : shownArms.length === 0 ? (
          <Empty icon={<Smartphone className="h-7 w-7" />} title="אין זרועות" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {shownArms.map((a) => {
              const st = ARM_STATUS[a.status] || { label: a.status, tone: 'slate' as const };
              const stopped = a.daily_limit === 0;
              const warming = a.linked_at && Date.now() - new Date(a.linked_at).getTime() < 24 * 3600_000;
              const bad = a.is_active && a.status !== 'online';
              return (
                <li key={a.arm_id} className={cx('flex flex-col gap-3 px-5 py-3 lg:flex-row lg:items-center', bad && 'bg-rose-50/40')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.arm_name}</span>
                      <Badge tone="slate">{a.station_name}</Badge>
                      <Badge tone={st.tone} dot={a.status === 'online'}>
                        {st.label}
                      </Badge>
                      {stopped && <Badge tone="amber">שליחה עצורה</Badge>}
                      {warming && !stopped && <Badge tone="sky">חימום – מספר חדש</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                      <span dir="ltr">{a.phone || 'לא מחובר'}</span>
                      <span>נשלחו היום: {a.sent_today}</span>
                      <span>{a.groups_count} קבוצות</span>
                      <span>נראתה: {timeAgo(a.last_seen_at)}</span>
                    </div>
                    {a.last_error && <div className="mt-1 text-xs text-rose-700">{a.last_error}</div>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {a.status !== 'online' && (
                      <Button size="sm" variant="secondary" loading={busy === a.arm_id + 'connect'} onClick={() => command(a, 'connect', 'מתחבר מחדש…')}>
                        <PlayCircle className="h-4 w-4" />
                        התחבר
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" title="רענון רשימת הקבוצות" loading={busy === a.arm_id + 'refresh_groups'} onClick={() => command(a, 'refresh_groups', 'מרענן קבוצות…')}>
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    {stopped ? (
                      <Button
                        size="sm"
                        variant="success"
                        loading={busy === a.arm_id + 'limit'}
                        onClick={() => run(a.arm_id + 'limit', () => sb().rpc('owner_arm_limit', { p_arm: a.arm_id, p_limit: 500 }), 'השליחה חודשה (עד 500 ביום)')}
                      >
                        <PlayCircle className="h-4 w-4" />
                        חידוש שליחה
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        title="עצירת שליחה – הזרוע נשארת מחוברת וממשיכה להאזין"
                        loading={busy === a.arm_id + 'limit'}
                        onClick={() =>
                          confirm(`לעצור את השליחה מ-${a.arm_name}? הזרוע נשארת מחוברת, וההפצות עוברות לזרועות האחרות.`) &&
                          run(a.arm_id + 'limit', () => sb().rpc('owner_arm_limit', { p_arm: a.arm_id, p_limit: 0 }), 'השליחה נעצרה')
                        }
                      >
                        <PauseCircle className="h-4 w-4 text-amber-600" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      title="QR חדש – מנתק את המספר ומבקש סריקה מחדש"
                      onClick={() => {
                        if (!confirm(`QR חדש ל-${a.arm_name}? המספר ינותק ויהיה צריך לסרוק מחדש.`)) return;
                        command(a, 'reset', 'מייצר QR חדש – פותח את מסך החיבור של התחנה');
                        setTimeout(() => (a.is_home ? (window.location.href = '/arms') : actAsStation(a.station_id, '/arms')), 800);
                      }}
                    >
                      <QrCode className="h-4 w-4" />
                    </Button>
                    {!a.is_home && (
                      <Button size="sm" variant="ghost" title="כניסה לתחנה" onClick={() => actAsStation(a.station_id, '/arms')}>
                        <LogIn className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* today per station */}
      <Card>
        <div className="border-b border-slate-100 px-5 py-4 font-semibold">היום לפי תחנה</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-5 py-2 text-right font-medium">תחנה</th>
                <th className="px-3 py-2 text-center font-medium">נסיעות</th>
                <th className="px-3 py-2 text-center font-medium">קבוצות שקיבלו</th>
                <th className="px-3 py-2 text-center font-medium">נכשלו</th>
                <th className="px-3 py-2 text-center font-medium">בקשות שנדחו</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shownDays.map((d) => {
                const home = (arms || []).find((a) => a.station_id === d.station_id)?.is_home;
                return (
                  <tr key={d.station_id}>
                    <td className="px-5 py-2.5 font-medium">{d.station_name}</td>
                    <td className="px-3 py-2.5 text-center tabular-nums">{d.rides}</td>
                    <td className="px-3 py-2.5 text-center tabular-nums">{d.sent.toLocaleString('he-IL')}</td>
                    <td className={cx('px-3 py-2.5 text-center tabular-nums', d.failed > 0 && 'text-rose-600')}>{d.failed}</td>
                    <td className={cx('px-3 py-2.5 text-center tabular-nums', d.refused > 0 && 'text-amber-700')}>{d.refused}</td>
                    <td className="px-3 py-2.5 text-left">
                      {home ? (
                        <Link href="/history" className="text-xs font-medium text-indigo-600">
                          היסטוריה
                        </Link>
                      ) : (
                        <button onClick={() => actAsStation(d.station_id, '/history')} className="text-xs font-medium text-indigo-600">
                          כניסה
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
        <Ban className="h-3.5 w-3.5" />
        עצירת שליחה לא מנתקת את המספר: הוא ממשיך להאזין, וההפצות עוברות לזרועות האחרות של התחנה.
      </p>
    </>
  );
}
