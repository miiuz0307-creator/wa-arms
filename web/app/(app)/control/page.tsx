'use client';
// Control center: every station on one screen – numbers, live distributions, today's numbers.
// Owner only. Buttons act on any station without entering it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, Ban, CalendarDays, CheckCircle2, LogIn, Megaphone, PauseCircle, PlayCircle, Plug, Plus, QrCode, RefreshCw, Send, ShieldCheck, Smartphone, XCircle } from 'lucide-react';
import { sb, actAsStation } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/hooks';
import { ARM_STATUS, CAMPAIGN_STATUS, KIND_LABEL, firstLine, fmtTime, timeAgo } from '@/lib/format';
import { Badge, Button, Card, Empty, Field, Input, Lamp, PageHeader, Progress, Section, Select, Skeleton, Spinner, Stat, Textarea, ask, cx, toast } from '@/components/ui';

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
  if (!isSuper || station?.acting)
    return (
      <Card>
        <Empty icon={<ShieldCheck className="h-7 w-7" />} title="המסך הזה זמין רק למנהל הראשי" text="מרכז הבקרה מוצג מחוץ לתחנה. חזור לחשבון שלך כדי לראות את כל התחנות." />
      </Card>
    );
  return <Control />;
}

const iconBtn = '!h-9 !w-9 !px-0';

function Control() {
  const [arms, setArms] = useState<Arm[] | null>(null);
  const [camps, setCamps] = useState<Camp[]>([]);
  const [days, setDays] = useState<Day[]>([]);
  const [only, setOnly] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [a, c, d] = await Promise.all([sb().rpc('owner_arms'), sb().rpc('owner_active_campaigns'), sb().rpc('owner_today')]);
    if (a.error) toast(`הזרועות לא נטענו: ${a.error.message}`, 'error');
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
    if (error) return toast(`הפעולה לא בוצעה: ${error.message}`, 'error');
    toast(ok);
    load();
  }

  const command = (a: Arm, cmd: 'connect' | 'refresh_groups' | 'reset', ok: string) =>
    run(a.arm_id + cmd, () => sb().rpc('owner_arm_command', { p_arm: a.arm_id, p_command: cmd }), ok);

  const enterStation = (stationId: string, home: boolean | undefined, path: string) => (home ? (window.location.href = path) : actAsStation(stationId, path));

  return (
    <>
      <PageHeader
        title="מרכז בקרה"
        subtitle="כל התחנות במסך אחד: מצב הזרועות, הפצות שרצות עכשיו ומה נשלח היום. הפעולות כאן עובדות בלי להיכנס לתחנה."
        actions={
          <Select value={only} onChange={(e) => setOnly(e.target.value)} className="w-full sm:w-56" aria-label="סינון לפי תחנה">
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
        <Stat label="זרועות מחוברות" value={arms ? `${online}/${shownArms.length}` : '—'} icon={<Smartphone className="h-5 w-5" />} tone="green" />
        <Stat label="זרועות עם תקלה" value={arms ? problems : '—'} icon={<Plug className="h-5 w-5" />} tone={problems ? 'red' : 'slate'} sub={arms && problems === 0 ? 'הכול תקין' : undefined} />
        <Stat label="הפצות פעילות" value={shownCamps.length} icon={<Activity className="h-5 w-5" />} tone="sky" />
        <Stat label="נשלחו היום" value={sentToday.toLocaleString('he-IL')} icon={<Send className="h-5 w-5" />} tone="slate" />
      </div>

      <Messages stations={stations} />

      {/* live distributions */}
      <Section
        title="הפצות פעילות עכשיו"
        icon={<Activity className="h-4 w-4" />}
        className="mb-6"
        action={shownCamps.length > 0 ? <span className="text-xs tabular-nums text-slate-500">{shownCamps.length}</span> : undefined}
      >
        {shownCamps.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-5 py-8 text-sm text-slate-500">
            <CheckCircle2 className="h-4 w-4 text-slate-400" />
            אין הפצות פעילות כרגע. כשתחנה תפיץ נסיעה, היא תופיע כאן בזמן אמת.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shownCamps.map((c) => (
              <li key={c.campaign_id} className="flex flex-col gap-2.5 px-5 py-3.5 md:flex-row md:items-center md:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="slate">{c.station_name}</Badge>
                    <Badge tone={CAMPAIGN_STATUS[c.status]?.tone || 'slate'} dot>
                      {CAMPAIGN_STATUS[c.status]?.label || c.status}
                    </Badge>
                  </div>
                  <div className="mt-1.5 truncate font-medium text-slate-900">{firstLine(c.text_preview, 50) || '—'}</div>
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
                    {c.source_group_name ? ` · ${c.source_group_name}` : ''} · <span className="tabular-nums">{fmtTime(c.created_at)}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  className="self-start md:self-center"
                  loading={busy === c.campaign_id}
                  onClick={async () => {
                    if (await ask({ title: `לבטל את ההפצה של ${c.station_name}?`, text: 'מה שכבר נשלח יישאר בקבוצות. הקבוצות שעוד לא קיבלו – לא יקבלו.', ok: 'ביטול ההפצה', danger: true }))
                      run(c.campaign_id, () => sb().rpc('owner_cancel_campaign', { p_id: c.campaign_id }), 'ההפצה בוטלה');
                  }}
                >
                  <XCircle className="h-4 w-4" />
                  ביטול ההפצה
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* arms of every station */}
      <Section
        title="כל הזרועות"
        icon={<Smartphone className="h-4 w-4" />}
        className="mb-6"
        action={arms && shownArms.length > 0 ? <span className="text-xs tabular-nums text-slate-500">{shownArms.length}</span> : undefined}
      >
        {!arms ? (
          <ul className="divide-y divide-slate-100" role="status" aria-label="טוען">
            {[0, 1, 2].map((i) => (
              <li key={i} className="space-y-2 px-5 py-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </li>
            ))}
          </ul>
        ) : shownArms.length === 0 ? (
          <Empty icon={<Smartphone className="h-7 w-7" />} title="אין זרועות" text="תחנה מחברת מספר וואטסאפ במסך הזרועות שלה, והוא יופיע כאן." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {shownArms.map((a) => {
              const st = ARM_STATUS[a.status] || { label: a.status, tone: 'slate' as const };
              const stopped = a.daily_limit === 0;
              const warming = a.linked_at && Date.now() - new Date(a.linked_at).getTime() < 24 * 3600_000;
              const bad = a.is_active && a.status !== 'online';
              return (
                <li key={a.arm_id} className={cx('flex flex-col gap-3 px-5 py-3.5 lg:flex-row lg:items-center', bad && 'bg-rose-50/50')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-2 font-medium text-slate-900">
                        <Lamp tone={st.tone} pulse={a.status === 'online'} />
                        {a.arm_name}
                      </span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      <Badge tone="slate">{a.station_name}</Badge>
                      {stopped && (
                        <Badge tone="amber" dot>
                          שליחה עצורה
                        </Badge>
                      )}
                      {warming && !stopped && <Badge tone="sky">חימום – מספר חדש</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      <span dir="ltr" className="tabular-nums">
                        {a.phone || 'לא מחובר'}
                      </span>
                      <span>
                        נשלחו היום: <span className="tabular-nums">{a.sent_today}</span>
                      </span>
                      <span>
                        <span className="tabular-nums">{a.groups_count}</span> קבוצות
                      </span>
                      <span>נראתה: {timeAgo(a.last_seen_at)}</span>
                    </div>
                    {a.last_error && <div className="mt-1 text-xs text-rose-700">{a.last_error}</div>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {a.status !== 'online' && (
                      <Button size="sm" variant="secondary" className="!h-9" loading={busy === a.arm_id + 'connect'} onClick={() => command(a, 'connect', 'מתחבר מחדש…')}>
                        <PlayCircle className="h-4 w-4" />
                        חיבור מחדש
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      className={iconBtn}
                      title="רענון רשימת הקבוצות"
                      aria-label={`רענון הקבוצות של ${a.arm_name}`}
                      loading={busy === a.arm_id + 'refresh_groups'}
                      onClick={() => command(a, 'refresh_groups', 'מרענן קבוצות…')}
                    >
                      {busy !== a.arm_id + 'refresh_groups' && <RefreshCw className="h-4 w-4" />}
                    </Button>
                    {stopped ? (
                      <Button
                        size="sm"
                        variant="success"
                        className="!h-9"
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
                        className={iconBtn}
                        title="עצירת שליחה – הזרוע נשארת מחוברת וממשיכה להאזין"
                        aria-label={`עצירת השליחה מ-${a.arm_name}`}
                        loading={busy === a.arm_id + 'limit'}
                        onClick={async () => {
                          if (
                            await ask({
                              title: `לעצור את השליחה מ-${a.arm_name}?`,
                              text: 'הזרוע נשארת מחוברת וממשיכה להאזין, וההפצות עוברות לזרועות האחרות של התחנה.',
                              ok: 'עצירת השליחה',
                            })
                          )
                            run(a.arm_id + 'limit', () => sb().rpc('owner_arm_limit', { p_arm: a.arm_id, p_limit: 0 }), 'השליחה נעצרה');
                        }}
                      >
                        {busy !== a.arm_id + 'limit' && <PauseCircle className="h-4 w-4 text-amber-600" />}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      className={iconBtn}
                      title="QR חדש – מנתק את המספר ומבקש סריקה מחדש"
                      aria-label={`QR חדש ל-${a.arm_name}`}
                      onClick={async () => {
                        if (!(await ask({ title: `QR חדש ל-${a.arm_name}?`, text: 'המספר ינותק, ויהיה צריך לסרוק את הקוד מחדש בטלפון.', ok: 'ניתוק ו-QR חדש', danger: true }))) return;
                        command(a, 'reset', 'מייצר QR חדש – פותח את מסך החיבור של התחנה');
                        setTimeout(() => (a.is_home ? (window.location.href = '/arms') : actAsStation(a.station_id, '/arms')), 800);
                      }}
                    >
                      <QrCode className="h-4 w-4" />
                    </Button>
                    {!a.is_home && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={iconBtn}
                        title="כניסה לתחנה"
                        aria-label={`כניסה לתחנה ${a.station_name}`}
                        onClick={() => actAsStation(a.station_id, '/arms')}
                      >
                        <LogIn className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* today per station */}
      <Section title="היום לפי תחנה" icon={<CalendarDays className="h-4 w-4" />}>
        {shownDays.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">עדיין לא היו הפצות היום.</div>
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2.5 text-right font-medium">תחנה</th>
                  <th className="px-3 py-2.5 text-center font-medium">נסיעות</th>
                  <th className="px-3 py-2.5 text-center font-medium">קבוצות שקיבלו</th>
                  <th className="px-3 py-2.5 text-center font-medium">נכשלו</th>
                  <th className="px-3 py-2.5 text-center font-medium">בקשות שנדחו</th>
                  <th className="px-5 py-2.5">
                    <span className="sr-only">פעולות</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shownDays.map((d) => {
                  const home = (arms || []).find((a) => a.station_id === d.station_id)?.is_home;
                  return (
                    <tr key={d.station_id}>
                      <td className="px-5 py-3 font-medium text-slate-900">{d.station_name}</td>
                      <td className="px-3 py-3 text-center tabular-nums">{d.rides}</td>
                      <td className="px-3 py-3 text-center tabular-nums">{d.sent.toLocaleString('he-IL')}</td>
                      <td className={cx('px-3 py-3 text-center tabular-nums', d.failed > 0 ? 'text-rose-700' : 'text-slate-500')}>{d.failed}</td>
                      <td className={cx('px-3 py-3 text-center tabular-nums', d.refused > 0 ? 'text-amber-700' : 'text-slate-500')}>{d.refused}</td>
                      <td className="px-5 py-3 text-left">
                        {home ? (
                          <Link href="/history" className="text-xs font-medium text-indigo-600 hover:underline">
                            להיסטוריה
                          </Link>
                        ) : (
                          <button type="button" onClick={() => actAsStation(d.station_id, '/history')} className="text-xs font-medium text-indigo-600 hover:underline">
                            כניסה לתחנה
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {/* phone: stacked cards */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {shownDays.map((d) => {
                const home = (arms || []).find((a) => a.station_id === d.station_id)?.is_home;
                return (
                  <li key={d.station_id} className="px-4 py-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-medium text-slate-900">{d.station_name}</span>
                      <button
                        type="button"
                        onClick={() => enterStation(d.station_id, home, '/history')}
                        className="h-9 shrink-0 rounded-lg px-2 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
                      >
                        {home ? 'להיסטוריה' : 'כניסה לתחנה'}
                      </button>
                    </div>
                    <dl className="mt-2 grid grid-cols-4 gap-2 text-center">
                      <MiniNum label="נסיעות" value={d.rides} />
                      <MiniNum label="קיבלו" value={d.sent.toLocaleString('he-IL')} />
                      <MiniNum label="נכשלו" value={d.failed} cls={d.failed > 0 ? 'text-rose-700' : undefined} />
                      <MiniNum label="נדחו" value={d.refused} cls={d.refused > 0 ? 'text-amber-700' : undefined} />
                    </dl>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>
      <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-slate-500">
        <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        עצירת שליחה לא מנתקת את המספר: הוא ממשיך להאזין, וההפצות עוברות לזרועות האחרות של התחנה.
      </p>
    </>
  );
}

function MiniNum({ label, value, cls }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-1 py-1.5">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className={cx('font-semibold tabular-nums text-slate-900', cls)}>{value}</dd>
    </div>
  );
}

type Msg = { id: number; title: string; body: string | null; level: string; station_id: string | null; station_name: string | null; starts_at: string; ends_at: string | null; active: boolean };

const LEVEL: Record<string, { label: string; tone: 'sky' | 'amber' | 'red' }> = {
  info: { label: 'מידע', tone: 'sky' },
  warning: { label: 'שים לב', tone: 'amber' },
  urgent: { label: 'דחוף', tone: 'red' },
};

// system messages: shown at the top of the app of every station (or one station)
function Messages({ stations }: { stations: [string, string][] }) {
  const [list, setList] = useState<Msg[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [level, setLevel] = useState('info');
  const [target, setTarget] = useState('');
  const [days, setDays] = useState(3);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    const { data } = await sb().rpc('owner_messages');
    setList((data as Msg[]) || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function send() {
    if (!title.trim()) return toast('חסרה כותרת להודעה', 'error');
    setBusy(true);
    const { error } = await sb().rpc('owner_message_send', { p_title: title, p_body: body || null, p_level: level, p_station: target || null, p_days: days });
    setBusy(false);
    if (error) return toast(`ההודעה לא נשלחה: ${error.message}`, 'error');
    toast(target ? 'ההודעה נשלחה לתחנה' : 'ההודעה נשלחה לכל התחנות');
    setTitle('');
    setBody('');
    setOpen(false);
    load();
  }
  async function end(id: number) {
    const { error } = await sb().rpc('owner_message_end', { p_id: id });
    if (error) return toast(`ההודעה לא הופסקה: ${error.message}`, 'error');
    toast('ההודעה הופסקה');
    load();
  }
  const active = list.filter((m) => m.active);

  return (
    <Section
      title="הודעות מערכת לתחנות"
      icon={<Megaphone className="h-4 w-4" />}
      className="mb-6"
      action={
        <div className="flex items-center gap-2">
          {active.length > 0 && (
            <Badge tone="green" dot>
              <span className="tabular-nums">{active.length}</span> מוצגות
            </Badge>
          )}
          <Button size="sm" variant={open ? 'ghost' : 'secondary'} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? (
              'סגירה'
            ) : (
              <>
                <Plus className="h-4 w-4" />
                הודעה חדשה
              </>
            )}
          </Button>
        </div>
      }
    >
      {open && (
        <div className="grid gap-3 border-b border-slate-100 bg-slate-50/60 p-5 md:grid-cols-2">
          <Field label="כותרת">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="לדוגמה: עדכון מערכת הלילה" />
          </Field>
          <Field label="נשלח אל">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">כל התחנות</option>
              {stations.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="md:col-span-2">
            <Field label="תוכן">
              <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} className="min-h-0" />
            </Field>
          </div>
          <Field label="סוג">
            <Select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="info">מידע (כחול)</option>
              <option value="warning">שים לב (כתום)</option>
              <option value="urgent">דחוף (אדום)</option>
            </Select>
          </Field>
          <Field label="מוצג למשך">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>יום</option>
              <option value={3}>3 ימים</option>
              <option value={7}>שבוע</option>
              <option value={30}>חודש</option>
              <option value={0}>עד שאפסיק</option>
            </Select>
          </Field>
          <div className="flex justify-end md:col-span-2">
            <Button onClick={send} loading={busy} className="w-full sm:w-auto">
              <Send className="h-4 w-4" />
              שליחת ההודעה
            </Button>
          </div>
        </div>
      )}
      {list.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm leading-relaxed text-slate-500">
          עדיין לא נשלחו הודעות. הודעה מופיעה בראש האפליקציה של התחנה עד שתפוג או שתפסיק אותה.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.slice(0, 8).map((m) => {
            const lv = LEVEL[m.level] || LEVEL.info;
            return (
              <li key={m.id} className={cx('flex items-start gap-3 px-5 py-3.5', !m.active && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{m.title}</span>
                    <Badge tone={lv.tone} dot>
                      {lv.label}
                    </Badge>
                    <Badge tone="slate">{m.station_name || 'כל התחנות'}</Badge>
                    {!m.active && <Badge tone="slate">הסתיימה</Badge>}
                  </div>
                  {m.body && <div className="mt-0.5 line-clamp-2 text-sm text-slate-600">{m.body}</div>}
                  <div className="mt-0.5 text-xs tabular-nums text-slate-400">
                    {fmtTime(m.starts_at)}
                    {m.ends_at ? ` · עד ${fmtTime(m.ends_at)}` : ' · ללא הגבלה'}
                  </div>
                </div>
                {m.active && (
                  <Button size="sm" variant="ghost" onClick={() => end(m.id)}>
                    הפסקה
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
