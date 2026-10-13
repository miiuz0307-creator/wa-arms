'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Smartphone, UsersRound, Send, Route, Activity, ChevronLeft, CheckCircle2, BellRing, Radio, Building2, LifeBuoy, Wallet } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { ACTION_LABEL, KIND_LABEL, ARM_STATUS, CAMPAIGN_STATUS, firstLine, fmtTime, timeAgo, type Tone } from '@/lib/format';
import { armHealth, groupReason, indexProblems, type ProblemIndex } from '@/lib/armHealth';
import { Badge, Button, Card, Empty, Lamp, Progress, Section, Skeleton, Stat, cx } from '@/components/ui';
import { BrandMark, StationSign, useBrand } from '@/components/Brand';
import { allGroups, allRows } from '@/lib/allRows';

type Alert = { key: string; tone: Tone; text: React.ReactNode; href?: string; cta?: string };

const daysLeft = (subEnd: string | null | undefined) =>
  subEnd ? Math.ceil((new Date(subEnd + 'T23:59:59').getTime() - Date.now()) / 86400000) : null;

export default function Dashboard() {
  const { can, profile, isSuper, station } = useAuth();
  const ownerView = isSuper && !station?.acting;
  const stationView = !!station && !ownerView;
  const brand = useBrand(stationView);
  const [d, setD] = useState<any>(null);
  // groups, their flags and list membership, and what really happened when sending (48h)
  const [problems, setProblems] = useState<{ index: ProblemIndex; rows: any[]; groups: any[]; flags: Map<string, any>; listed: Set<string> } | null>(null);

  const load = useCallback(async () => {
    const [arms, active, pendingPhone, recentFailed, log] = await Promise.all([
      sb().from('arms').select('*').order('created_at'), // rows: bounded – the arms of one station
      sb().from('campaigns').select('*').in('status', ['queued', 'running', 'paused']).order('created_at', { ascending: false }).limit(8),
      sb().from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'pending_phone'),
      sb()
        .from('campaign_targets')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed')
        .gte('claimed_at', new Date(Date.now() - 86400000).toISOString()),
      can('admin') ? sb().from('activity_log').select('*').order('created_at', { ascending: false }).limit(8) : Promise.resolve({ data: [] }),
    ]);
    // today's rides (since local midnight): how many, and how their sends ended
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todayRides = await allRows(() =>
      sb().from('campaigns').select('kind,sent,failed,total,status').gte('created_at', midnight.toISOString()).order('created_at'),
    ).catch(() => ({ data: [] as any[] }));

    // owner (own account, not inside a station): system monitor
    let stationAlerts: any[] = [];
    let health: any[] = [];
    let armRequests: any[] = [];
    let engineSeen: string | null = null;
    let delivery: any[] = [];
    let owner: { stations: any[]; tickets: any[] | null; payments: any[] | null } | null = null;
    let support: any[] = [];
    if (ownerView) {
      const [{ data: h }, { data: rq }, { data: dl }, { data: st }, tk, pay] = await Promise.all([
        sb().rpc('owner_health'),
        sb().rpc('owner_arm_requests'),
        sb().rpc('owner_delivery'),
        sb().rpc('stations_overview'),
        sb().rpc('support_tickets'),
        sb().rpc('owner_payment_requests', { p_status: 'pending' }),
      ]);
      // a database without the v2 support / payment functions answers with an error: those tiles are then hidden
      owner = { stations: (st as any[]) || [], tickets: tk.error ? null : (tk.data as any[]) || [], payments: pay.error ? null : (pay.data as any[]) || [] };
      // delivery monitor: members who could not decrypt our messages ("waiting for this message"), per arm
      delivery = (dl as any[]) || [];
      armRequests = ((rq as any[]) || []).filter((r) => r.status === 'pending');
      engineSeen = (h || [])[0]?.engine_seen || null;
      health = (h || []).filter((r: any) => r.station_id && r.station_name && (r.arm_id || r.failed_hour > 0));
      stationAlerts = (st || [])
        .map((s: any) => ({ ...s, left: daysLeft(s.sub_end) }))
        .filter((s: any) => s.status === 'active' && s.left !== null && s.left <= 7);
    } else if (station && !station.is_home) {
      // the station's support tickets: an answer from the BotiX team that waits for the station
      const { data, error } = await sb().rpc('support_tickets');
      if (!error) support = ((data as any[]) || []).filter((t) => t.status === 'waiting');
    }

    const tr = todayRides.data || [];
    setD({
      arms: arms.data || [],
      today: {
        rides: tr.length,
        sent: tr.reduce((n: number, c: any) => n + (c.sent || 0), 0),
        failed: tr.reduce((n: number, c: any) => n + (c.failed || 0), 0),
      },
      active: active.data || [],
      pendingPhone: pendingPhone.count || 0,
      recentFailed: recentFailed.count || 0,
      log: log.data || [],
      stationAlerts,
      health,
      armRequests,
      delivery,
      owner,
      support,
      engineDown: ownerView && engineSeen && Date.now() - new Date(engineSeen).getTime() > 3 * 60_000 ? engineSeen : null,
    });
  }, [can, ownerView, station]);

  // the group picture is heavier to read (a station can have 1,500 groups), so once a minute, not every 5 seconds
  const loadProblems = useCallback(async () => {
    const [pr, groups, flags, listed] = await Promise.all([
      sb().rpc('group_problems', { p_hours: 48 }),
      allGroups('arm_id,wa_group_id'),
      allRows(() => sb().from('group_flags').select('wa_group_id,include_anyway,disabled').order('wa_group_id')).catch(() => ({ data: [] as any[] })),
      allRows(() => sb().from('list_groups').select('wa_group_id,list_id').order('list_id').order('wa_group_id')),
    ]);
    const rows = pr.error ? [] : (pr.data as any[]) || [];
    setProblems({
      index: indexProblems(rows),
      rows,
      groups: groups.data || [],
      flags: new Map((flags.data || []).map((f: any) => [f.wa_group_id, f])),
      listed: new Set((listed.data || []).map((r: any) => r.wa_group_id as string)),
    });
  }, []);

  useEffect(() => {
    load();
    loadProblems();
    const iv = setInterval(loadProblems, 60_000);
    return () => clearInterval(iv);
  }, [load, loadProblems]);
  useRealtime(['arms', 'campaigns', 'activity_log'], load);

  const hour = new Date().getHours();
  const hello = hour < 12 ? 'בוקר טוב' : hour < 18 ? 'צהריים טובים' : 'ערב טוב';
  const firstName = profile?.full_name ? profile.full_name.split(' ')[0] : '';

  // ---- header: the station's roof sign, or BotiX for the system owner ----
  const subLeft = daysLeft(brand?.sub_end ?? station?.sub_end);
  const subEnded = !!station && !station.is_home && (station.status !== 'active' || (subLeft !== null && subLeft < 0));
  const sendBtn = can('operator') && (
    <Link href="/send">
      <Button>
        <Send className="h-4 w-4" />
        שליחת הודעה
      </Button>
    </Link>
  );
  const header = ownerView ? (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <BrandMark size={48} />
        <div>
          <h1 className="text-[26px] font-bold leading-tight tracking-tight text-slate-900">
            שלום{firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="text-[15px] text-slate-500">{hello} – תמונת המצב של כל המערכת</p>
        </div>
      </div>
      {sendBtn}
    </div>
  ) : (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <StationSign
        name={brand?.name || station?.name || 'התחנה'}
        logo={brand?.logo_data}
        status={
          <span className={cx('flex items-center gap-2 font-medium', subEnded ? 'text-rose-700' : 'text-slate-800')}>
            <Lamp tone={subEnded ? 'red' : 'green'} pulse={!subEnded} />
            {subEnded ? 'המנוי הסתיים – הבוט לא מטפל בהודעות' : 'התחנה פעילה'}
          </span>
        }
        sub={
          station && !station.is_home && !subEnded ? (
            subLeft === null ? (
              <Badge tone="green">מנוי פעיל</Badge>
            ) : (
              <Link href="/subscription">
                <Badge tone={subLeft <= 7 ? 'amber' : 'slate'}>
                  {subLeft === 0 ? 'המנוי מסתיים היום' : `נותרו ${subLeft} ימים למנוי`}
                </Badge>
              </Link>
            )
          ) : null
        }
      />
      {sendBtn}
    </div>
  );

  if (!d || !problems)
    return (
      <>
        {header}
        <div className="space-y-4" role="status" aria-label="טוען">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </>
    );

  // ---- derived, from real data only ----
  const armById: Record<string, any> = Object.fromEntries(d.arms.map((a: any) => [a.id, a]));
  const twoHours = Date.now() - 2 * 3600_000;
  const failedByArm: Record<string, number> = {};
  for (const p of problems.rows)
    if (p.arm_id && p.reason === 'send_error' && new Date(p.last_at).getTime() > twoHours) failedByArm[p.arm_id] = (failedByArm[p.arm_id] || 0) + (p.n || 1);
  const health = d.arms.map((a: any) => armHealth(a, { failedRecent: failedByArm[a.id] }));
  const online = d.arms.filter((a: any) => a.is_active && a.status === 'online').length;

  const byGroup = new Map<string, { id: string; armIds: string[] }>();
  const perArm: Record<string, number> = {};
  const listed = problems.listed;
  for (const g of problems.groups) {
    perArm[g.arm_id] = (perArm[g.arm_id] || 0) + 1;
    const r = byGroup.get(g.wa_group_id) || { id: g.wa_group_id, armIds: [] };
    r.armIds.push(g.arm_id);
    byGroup.set(g.wa_group_id, r);
  }
  for (const id of listed) if (!byGroup.has(id)) byGroup.set(id, { id, armIds: [] });
  let gOk = 0;
  let gBad = 0;
  let listedNoPerm = 0;
  let listedBad = 0;
  const index = problems.index;
  for (const g of byGroup.values()) {
    const f = problems.flags.get(g.id);
    const reason = groupReason(g, armById, index, !!f?.disabled, null);
    if (!reason) gOk++;
    else if (reason !== 'disabled') {
      gBad++;
      if (listed.has(g.id) && !f?.include_anyway) {
        if (reason === 'no_permission') listedNoPerm++;
        else listedBad++;
      }
    }
  }
  const gTotal = gOk + gBad;
  const done = d.today.sent + d.today.failed;
  const rate = done > 0 ? Math.round((d.today.sent / done) * 100) : null;

  // ---- "needs attention" ----
  const alerts: Alert[] = [];
  if (d.engineDown)
    alerts.push({ key: 'engine', tone: 'red', text: <>המנוע לא דיווח מאז {fmtTime(d.engineDown)} – ייתכן שהשרת נפל. בדוק ב-Railway.</> });
  d.arms.forEach((a: any, i: number) => {
    const h = health[i];
    if (h.level === 'ok' || a.status === 'connecting') return;
    alerts.push({
      key: `arm${a.id}`,
      tone: h.tone,
      text: (
        <>
          <b className="font-semibold">{a.name}</b> – {h.title}. {h.action || h.explain}
        </>
      ),
      href: can('admin') ? '/arms' : undefined,
      cta: 'לטיפול',
    });
  });
  if (subLeft !== null && subLeft >= 0 && subLeft <= 7 && station && !station.is_home && !ownerView)
    alerts.push({
      key: 'sub',
      tone: 'amber',
      text: subLeft === 0 ? 'המנוי מסתיים היום. בלי חידוש הבוט יפסיק לטפל בהודעות.' : `המנוי מסתיים בעוד ${subLeft} ימים. בלי חידוש הבוט יפסיק לטפל בהודעות.`,
      href: can('admin') ? '/subscription' : undefined,
      cta: 'לחידוש',
    });
  if (d.pendingPhone > 0)
    alerts.push({ key: 'phone', tone: 'amber', text: `${d.pendingPhone} בקשות עזרה ממתינות למספר טלפון`, href: '/dispatchers', cta: 'להשלמה' });
  if (listedNoPerm > 0)
    alerts.push({
      key: 'noperm',
      tone: 'amber',
      text: `ב-${listedNoPerm} קבוצות שברשימות ההפצה אין לזרוע הרשאה לשלוח (רק מנהלים)`,
      href: '/groups?show=bad',
      cta: 'לבדיקה והסרה',
    });
  if (listedBad > 0)
    alerts.push({ key: 'gbad', tone: 'amber', text: `${listedBad} קבוצות ברשימות ההפצה לא זמינות ולא יקבלו נסיעות`, href: '/groups?show=bad', cta: 'לבדיקה' });
  for (const t of d.support)
    alerts.push({ key: `sup${t.id}`, tone: 'sky', text: <>צוות התמיכה ענה לפנייה <b className="font-semibold">{t.subject}</b> וממתין לתשובתך</>, href: `/support?t=${t.id}`, cta: 'לפנייה' });
  const ownerOpen = d.owner?.tickets ? d.owner.tickets.filter((t: any) => t.status !== 'closed') : null;
  const ownerToAnswer = ownerOpen ? ownerOpen.filter((t: any) => t.last_reply_by === 'station') : [];
  if (ownerToAnswer.length > 0)
    alerts.push({
      key: 'tickets',
      tone: 'amber',
      text: ownerToAnswer.length === 1 ? <>פנייה מתחנה <b className="font-semibold">{ownerToAnswer[0].station_name}</b> ממתינה לתשובה שלך</> : `${ownerToAnswer.length} פניות תמיכה ממתינות לתשובה שלך`,
      href: ownerToAnswer.length === 1 ? `/support?t=${ownerToAnswer[0].id}` : '/support',
      cta: 'לפניות',
    });
  if (d.owner?.payments?.length)
    alerts.push({ key: 'pay', tone: 'amber', text: `${d.owner.payments.length} תשלומים ממתינים לאישור שלך`, href: '/billing', cta: 'לאישור' });
  if (d.recentFailed > 0) alerts.push({ key: 'failed', tone: 'red', text: `${d.recentFailed} שליחות נכשלו ב-24 השעות האחרונות`, href: '/history', cta: 'לפרטים' });
  for (const r of d.armRequests)
    alerts.push({
      key: `rq${r.id}`,
      tone: 'sky',
      text: (
        <>
          תחנה <b className="font-semibold">{r.station_name}</b> מבקשת עוד {r.count} {r.count === 1 ? 'זרוע' : 'זרועות'}
        </>
      ),
      href: '/billing',
      cta: 'לאישור',
    });
  d.health
    .filter((r: any) => r.station_id !== station?.id)
    .forEach((r: any, i: number) =>
      alerts.push({
        key: `h${i}`,
        tone: 'red',
        text: (
          <>
            תחנה <b className="font-semibold">{r.station_name}</b>
            {r.arm_id ? ` – ${r.arm_name}: ${ARM_STATUS[r.arm_status]?.label || r.arm_status}` : ''}
            {r.failed_hour > 0 ? ` – ${r.failed_hour} שליחות נכשלו בשעה האחרונה` : ''}
          </>
        ),
        href: '/stations',
        cta: 'לתחנות',
      }),
    );
  for (const s of d.stationAlerts)
    alerts.push({
      key: `s${s.id}`,
      tone: s.left < 0 ? 'red' : 'amber',
      text: (
        <>
          מנוי התחנה <b className="font-semibold">{s.name}</b> {s.left < 0 ? 'הסתיים – הגישה חסומה' : s.left === 0 ? 'מסתיים היום' : `מסתיים בעוד ${s.left} ימים`}
        </>
      ),
      href: '/billing',
      cta: 'למנויים',
    });

  return (
    <>
      {header}

      {ownerView && d.owner && <OwnerKpis owner={d.owner} openTickets={ownerOpen} toAnswer={ownerToAnswer.length} />}

      {/* KPIs */}
      {ownerView && <h2 className="mb-2 mt-6 text-sm font-semibold text-slate-500">החשבון הראשי שלך</h2>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Stat
          label="זרועות מחוברות"
          value={`${online}/${d.arms.length}`}
          sub={d.arms.length === 0 ? 'עדיין לא חוברו זרועות' : online === d.arms.length ? 'כולן מחוברות' : `${d.arms.length - online} לא מחוברות`}
          icon={<Smartphone className="h-5 w-5" />}
          tone={d.arms.length && online === d.arms.length ? 'green' : online === 0 ? 'red' : 'amber'}
          href={can('admin') ? '/arms' : undefined}
        />
        <Stat
          label="קבוצות זמינות"
          value={`${gOk.toLocaleString('he-IL')}/${gTotal.toLocaleString('he-IL')}`}
          sub={gBad > 0 ? `${gBad.toLocaleString('he-IL')} לא זמינות` : gTotal ? 'כולן זמינות' : 'אין קבוצות עדיין'}
          icon={<UsersRound className="h-5 w-5" />}
          tone={gBad > 0 ? 'amber' : 'sky'}
          href={can('operator') ? (gBad > 0 ? '/groups?show=bad' : '/groups') : undefined}
        />
        <Stat
          label="נסיעות היום"
          value={d.today.rides.toLocaleString('he-IL')}
          sub={d.active.length ? `${d.active.length} בהפצה עכשיו` : 'אין הפצה פעילה כרגע'}
          icon={<Route className="h-5 w-5" />}
          tone="violet"
          href="/history"
        />
        <Stat
          label="נשלחו היום"
          value={d.today.sent.toLocaleString('he-IL')}
          sub={
            done > 0 ? (
              <span className={d.today.failed ? 'text-rose-700' : undefined}>
                {d.today.failed.toLocaleString('he-IL')} לא נשלחו · {rate}% הצלחה
              </span>
            ) : (
              'עדיין לא נשלחו הודעות היום'
            )
          }
          icon={<Send className="h-5 w-5" />}
          tone={d.today.failed > 0 && rate !== null && rate < 90 ? 'red' : 'green'}
        />
      </div>

      {/* needs attention */}
      <div className="mt-4">
        {alerts.length === 0 ? (
          <Card className="flex items-center gap-3 px-5 py-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
            <div>
              <div className="font-medium text-slate-900">הכול תקין</div>
              <div className="text-sm text-slate-500">אין כרגע שום דבר שדורש טיפול.</div>
            </div>
          </Card>
        ) : (
          <Section title={`דורש תשומת לב (${alerts.length})`} icon={<BellRing className="h-4 w-4" />}>
            <ul className="divide-y divide-slate-100">
              {alerts.map((a) => (
                <li key={a.key}>
                  {a.href ? (
                    <Link href={a.href} className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-slate-50">
                      <Lamp tone={a.tone} />
                      <span className="min-w-0 flex-1 text-sm leading-relaxed text-slate-800">{a.text}</span>
                      <span className="flex shrink-0 items-center text-sm font-medium text-indigo-600">
                        {a.cta}
                        <ChevronLeft className="h-4 w-4" />
                      </span>
                    </Link>
                  ) : (
                    <div className="flex items-center gap-3 px-5 py-3.5">
                      <Lamp tone={a.tone} />
                      <span className="min-w-0 flex-1 text-sm leading-relaxed text-slate-800">{a.text}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      {ownerView && d.delivery.length > 0 && <DeliveryMonitor rows={d.delivery} />}

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Section
          className="lg:col-span-3"
          title="הפצות פעילות"
          icon={<Radio className="h-4 w-4" />}
          action={
            <Link href="/history" className="flex items-center text-sm font-medium text-indigo-600">
              להיסטוריה <ChevronLeft className="h-4 w-4" />
            </Link>
          }
        >
          {d.active.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">
              אין הפצות פעילות כרגע.
              {can('operator') && (
                <>
                  {' '}
                  <Link href="/send" className="font-medium text-indigo-600 hover:underline">
                    שליחת הודעה
                  </Link>
                </>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.active.map((c: any) => (
                <li key={c.id}>
                  <Link href={`/history/${c.id}`} className="block px-5 py-3.5 transition hover:bg-slate-50">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 truncate text-sm font-medium text-slate-900">{firstLine(c.message_text)}</div>
                      <Badge tone={CAMPAIGN_STATUS[c.status]?.tone} dot>
                        {CAMPAIGN_STATUS[c.status]?.label}
                      </Badge>
                    </div>
                    <Progress sent={c.sent} failed={c.failed} total={c.total} />
                    <div className="mt-1.5 flex justify-between text-xs text-slate-500">
                      <span className="tabular-nums">
                        {c.sent + c.failed}/{c.total} · {KIND_LABEL[c.kind] || c.kind}
                      </span>
                      <span>{fmtTime(c.created_at)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          className="lg:col-span-2"
          title="זרועות"
          icon={<Smartphone className="h-4 w-4" />}
          action={
            can('admin') && (
              <Link href="/arms" className="flex items-center text-sm font-medium text-indigo-600">
                ניהול <ChevronLeft className="h-4 w-4" />
              </Link>
            )
          }
        >
          {d.arms.length === 0 ? (
            <Empty
              icon={<Smartphone className="h-6 w-6" />}
              title="עדיין לא חוברו זרועות"
              text="זרוע היא מספר WhatsApp ששולח את הנסיעות לקבוצות."
              action={
                can('admin') && (
                  <Link href="/arms">
                    <Button size="sm">חיבור זרוע ראשונה</Button>
                  </Link>
                )
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.arms.map((a: any, i: number) => {
                const h = health[i];
                return (
                  <li key={a.id} className="flex items-start gap-3 px-5 py-3.5">
                    <span className="mt-1.5">
                      <Lamp tone={h.tone} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-slate-900">{a.name}</span>
                        <span className="shrink-0 text-xs tabular-nums text-slate-500">{(perArm[a.id] || 0).toLocaleString('he-IL')} קבוצות</span>
                      </div>
                      <div className={cx('text-xs', h.level === 'ok' ? 'text-slate-500' : h.level === 'bad' ? 'text-rose-700' : 'text-amber-800')}>
                        {h.title}
                        {a.phone && (
                          <span className="text-slate-400" dir="ltr">
                            {' · '}
                            {a.phone}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      {can('admin') && (
        <Section
          className="mt-4"
          title="פעילות אחרונה"
          icon={<Activity className="h-4 w-4" />}
          action={
            <Link href="/settings#log" className="flex items-center text-sm font-medium text-indigo-600">
              ליומן המלא <ChevronLeft className="h-4 w-4" />
            </Link>
          }
        >
          {d.log.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-slate-500">עדיין אין פעילות. פעולות במערכת יופיעו כאן.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.log.map((l: any) => (
                <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0 truncate text-slate-700">
                    <b className="font-medium text-slate-900">{l.actor_name || 'מערכת'}</b> · {ACTION_LABEL[l.action] || l.action}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">{timeAgo(l.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}

// Owner (own account): the whole system at a glance – stations, their arms, support and payments. Real data only;
// a tile whose source is missing (older database) is not shown.
function OwnerKpis({ owner, openTickets, toAnswer }: { owner: { stations: any[]; tickets: any[] | null; payments: any[] | null }; openTickets: any[] | null; toAnswer: number }) {
  const st = owner.stations;
  const active = st.filter((s) => s.status === 'active').length;
  const armsTotal = st.reduce((n, s) => n + (s.arms_total || 0), 0);
  const armsOnline = st.reduce((n, s) => n + (s.arms_online || 0), 0);
  return (
    <>
      <h2 className="mb-2 text-sm font-semibold text-slate-500">כל המערכת</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Stat
          label="תחנות פעילות"
          value={`${active}/${st.length}`}
          sub={st.length === 0 ? 'עדיין אין תחנות' : st.length - active > 0 ? `${st.length - active} לא פעילות` : 'כל התחנות פעילות'}
          icon={<Building2 className="h-5 w-5" />}
          tone="violet"
          href="/stations"
        />
        <Stat
          label="זרועות מחוברות בתחנות"
          value={`${armsOnline}/${armsTotal}`}
          sub={armsTotal === 0 ? 'אין זרועות בתחנות' : armsOnline === armsTotal ? 'כולן מחוברות' : `${armsTotal - armsOnline} לא מחוברות`}
          icon={<Smartphone className="h-5 w-5" />}
          tone={armsTotal && armsOnline === armsTotal ? 'green' : armsOnline === 0 && armsTotal ? 'red' : 'amber'}
          href="/control"
        />
        {openTickets && (
          <Stat
            label="פניות תמיכה פתוחות"
            value={openTickets.length}
            sub={toAnswer > 0 ? <span className="text-amber-800">{toAnswer} ממתינות לתשובה שלך</span> : openTickets.length ? 'אין פנייה שממתינה לך' : 'אין פניות פתוחות'}
            icon={<LifeBuoy className="h-5 w-5" />}
            tone={toAnswer > 0 ? 'amber' : 'sky'}
            href="/support"
          />
        )}
        {owner.payments && (
          <Stat
            label="תשלומים לאישור"
            value={owner.payments.length}
            sub={owner.payments.length ? 'ממתינים לאישור שלך' : 'אין תשלומים ממתינים'}
            icon={<Wallet className="h-5 w-5" />}
            tone={owner.payments.length ? 'amber' : 'green'}
            href="/billing"
          />
        )}
      </div>
    </>
  );
}

// Owner: per arm, how many member devices could not decrypt our messages in the last hour, how many were
// fixed by a re-send, and how many stayed unreadable ("waiting for this message").
function DeliveryMonitor({ rows }: { rows: any[] }) {
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const lostTotal = rows.reduce((n, r) => n + (r.lost_hour || 0), 0);
  return (
    <Section
      className="mt-4"
      title="מסירת הודעות – שעה אחרונה"
      icon={<Activity className="h-4 w-4" />}
      action={lostTotal > 0 ? <Badge tone="red" dot>{lostTotal} לא תוקנו</Badge> : <Badge tone="green" dot>תקין</Badge>}
    >
      {/* mobile: stacked */}
      <ul className="divide-y divide-slate-100 md:hidden">
        {rows.map((r) => (
          <li key={r.arm_id} className="px-5 py-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-slate-900">{r.arm_name}</span>
              <span className="truncate text-xs text-slate-500">{r.station_name}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-slate-600">
              <span>{r.sent_hour} נשלחו</span>
              <span className={r.failed_hour > 0 ? 'text-amber-800' : ''}>{r.failed_hour} לא פוענחו</span>
              <span>{r.resent_hour} נשלחו שוב</span>
              <span className={r.lost_hour > 0 ? 'font-semibold text-rose-700' : ''}>{r.lost_hour} נשארו בהמתנה</span>
            </div>
          </li>
        ))}
      </ul>
      {/* desktop: table */}
      <div className="hidden overflow-x-auto px-5 py-2 md:block">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="text-right">
              <th className="py-2 font-medium">זרוע</th>
              <th className="py-2 font-medium">נשלחו</th>
              <th className="py-2 font-medium">לא פוענחו אצל מקבלים</th>
              <th className="py-2 font-medium">נשלחו שוב</th>
              <th className="py-2 font-medium">נשארו בהמתנה</th>
              <th className="py-2 font-medium">נכנסות שלא פוענחו</th>
              <th className="py-2 font-medium">24 שעות</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.arm_id} className="border-t border-slate-100">
                <td className="py-2">
                  <b className="font-medium text-slate-900">{r.arm_name}</b>
                  <div className="text-xs text-slate-500">{r.station_name}</div>
                </td>
                <td>{r.sent_hour}</td>
                <td className={r.failed_hour > 0 ? 'text-amber-800' : ''}>
                  {r.failed_hour} {r.devices_hour ? <span className="text-xs text-slate-500">({r.devices_hour} מכשירים)</span> : null}
                </td>
                <td>{r.resent_hour}</td>
                <td className={r.lost_hour > 0 ? 'font-semibold text-rose-700' : ''}>{r.lost_hour}</td>
                <td className={r.undecrypted_hour > 0 ? 'text-amber-800' : ''}>{r.undecrypted_hour}</td>
                <td className="text-xs text-slate-500">
                  {r.failed_day} תקלות · {r.resent_day} תוקנו · {pct(r.lost_day, r.failed_day)}% נשארו
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
