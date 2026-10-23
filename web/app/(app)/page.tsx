'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Smartphone, UsersRound, Send, Radio, AlertTriangle, Activity, ChevronLeft } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { ACTION_LABEL, KIND_LABEL, ARM_STATUS, CAMPAIGN_STATUS, firstLine, fmtTime, timeAgo } from '@/lib/format';
import { Badge, Card, PageHeader, Progress, Spinner, Stat, Button } from '@/components/ui';
import { allGroups, allRows } from '@/lib/allRows';

export default function Dashboard() {
  const { can, profile, isSuper, station } = useAuth();
  const [d, setD] = useState<any>(null);

  const load = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [arms, groups, active, pendingPhone, recentFailed, log] = await Promise.all([
      sb().from('arms').select('*').order('created_at'),
      allGroups('arm_id,wa_group_id'),
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
      sb().from('campaigns').select('kind,sent,failed,unavailable,total,status').gte('created_at', midnight.toISOString()).order('created_at'),
    ).catch(() => ({ data: [] as any[] }));
    // owner (own account, not inside a station): stations whose subscription ends this week or already ended
    let stationAlerts: any[] = [];
    let health: any[] = [];
    let armRequests: any[] = [];
    let engineSeen: string | null = null;
    let delivery: any[] = [];
    if (isSuper && !station?.acting) {
      // system monitor: disconnected numbers and failed sends in every station, engine heartbeat
      const [{ data: h }, { data: rq }, { data: dl }] = await Promise.all([
        sb().rpc('owner_health'),
        sb().rpc('owner_arm_requests'),
        sb().rpc('owner_delivery'),
      ]);
      // delivery monitor: members who could not decrypt our messages ("waiting for this message"), per arm
      delivery = (dl as any[]) || [];
      armRequests = ((rq as any[]) || []).filter((r) => r.status === 'pending');
      engineSeen = (h || [])[0]?.engine_seen || null;
      health = (h || []).filter((r: any) => r.station_id && r.station_name && (r.arm_id || r.failed_hour > 0));
      const { data: st } = await sb().rpc('stations_overview');
      stationAlerts = (st || [])
        .map((s: any) => ({ ...s, left: s.sub_end ? Math.ceil((new Date(s.sub_end + 'T23:59:59').getTime() - Date.now()) / 86400000) : null }))
        .filter((s: any) => s.status === 'active' && s.left !== null && s.left <= 7);
    }
    // groups with no permission in the last day that are still in a distribution list
    const np = await sb()
      .from('campaign_targets')
      .select('wa_group_id, campaign_id, sent_at, claimed_at')
      .in('status', ['skipped', 'failed'])
      .ilike('error', '%הרשאה%')
      .gte('claimed_at', new Date(Date.now() - 86400000).toISOString())
      .order('claimed_at', { ascending: false })
      .limit(500);
    const npIds = [...new Set((np.data || []).map((r: any) => r.wa_group_id))];
    let noPerm = { count: 0, campaign: null as string | null };
    if (npIds.length) {
      const { data: listed } = await allRows(() => sb().from('list_groups').select('wa_group_id').in('wa_group_id', npIds).order('wa_group_id').order('list_id'));
      const still = new Set((listed || []).map((r: any) => r.wa_group_id));
      noPerm = { count: still.size, campaign: (np.data || []).find((r: any) => still.has(r.wa_group_id))?.campaign_id || null };
    }

    const perArm: Record<string, number> = {};
    const distinct = new Set<string>();
    const reachable = new Set<string>();
    const armRows = arms.data || [];
    const liveArm = new Set(armRows.filter((a: any) => a.is_active && a.status === 'online').map((a: any) => a.id));
    for (const g of groups.data || []) {
      perArm[g.arm_id] = (perArm[g.arm_id] || 0) + 1;
      distinct.add(g.wa_group_id);
      if (liveArm.has(g.arm_id)) reachable.add(g.wa_group_id);
    }
    const tr = todayRides.data || [];
    const today2 = {
      rides: tr.length,
      sent: tr.reduce((n: number, c: any) => n + (c.sent || 0), 0),
      failed: tr.reduce((n: number, c: any) => n + (c.failed || 0), 0),
      unavailable: tr.reduce((n: number, c: any) => n + (c.unavailable || 0), 0),
      total: tr.reduce((n: number, c: any) => n + (c.total || 0), 0),
    };
    setD({
      arms: armRows,
      perArm,
      groupCount: distinct.size,
      groupsReachable: reachable.size,
      today2,
      sentToday: armRows.reduce((s: number, a: any) => s + (a.sent_day === today ? a.sent_today : 0), 0),
      sentTotal: armRows.reduce((s: number, a: any) => s + Number(a.sent_total || 0), 0),
      active: active.data || [],
      pendingPhone: pendingPhone.count || 0,
      recentFailed: recentFailed.count || 0,
      log: log.data || [],
      noPerm,
      stationAlerts,
      health,
      armRequests,
      delivery,
      engineDown: isSuper && !station?.acting && engineSeen && Date.now() - new Date(engineSeen).getTime() > 3 * 60_000 ? engineSeen : null,
    });
  }, [can, isSuper, station?.acting]);

  // live part, every 2 seconds: rides in progress (sent / total) and the arms – a few small rows, so the
  // screen follows a distribution as it happens. Everything heavy (groups, statistics, monitor) every 30s.
  const loadLive = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [arms, active, pendingPhone] = await Promise.all([
      sb().from('arms').select('*').order('created_at'),
      sb().from('campaigns').select('*').in('status', ['queued', 'running', 'paused']).order('created_at', { ascending: false }).limit(8),
      sb().from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'pending_phone'),
    ]);
    if (arms.error || active.error) return;
    const armRows = arms.data || [];
    setD((prev: any) =>
      prev && {
        ...prev,
        arms: armRows,
        active: active.data || [],
        pendingPhone: pendingPhone.count || 0,
        sentToday: armRows.reduce((s: number, a: any) => s + (a.sent_day === today ? a.sent_today : 0), 0),
        sentTotal: armRows.reduce((s: number, a: any) => s + Number(a.sent_total || 0), 0),
      },
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['arms', 'campaigns'], loadLive, 'live', 2000);
  useRealtime(['arms', 'campaigns', 'activity_log'], load, undefined, 30000);

  if (!d) return <Spinner />;

  // arms that should work (not stopped on purpose) and are not connected – shown in red, every one of them
  const working = d.arms.filter((a: any) => a.is_active && a.status !== 'paused');
  const online = working.filter((a: any) => a.status === 'online').length;
  const problems = working.filter((a: any) => a.status !== 'online');
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'בוקר טוב' : hour < 18 ? 'צהריים טובים' : 'ערב טוב';

  return (
    <>
      <PageHeader
        title={`${hello}${profile?.full_name ? ', ' + profile.full_name.split(' ')[0] : ''}`}
        subtitle="תמונת מצב בזמן אמת"
        actions={
          can('operator') && (
            <Link href="/send">
              <Button>
                <Send className="h-4 w-4" />
                שליחת הודעה
              </Button>
            </Link>
          )
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Stat
          label="זרועות מחוברות"
          value={`${online}/${working.length}`}
          sub={problems.length > 0 ? `${problems.length} לא מחוברות` : 'כולן מחוברות'}
          icon={<Smartphone className="h-5 w-5" />}
          tone={problems.length > 0 ? 'red' : 'green'}
        />
        <Stat
          label="קבוצות זמינות"
          value={`${d.groupsReachable}/${d.groupCount}`}
          sub={d.groupCount - d.groupsReachable > 0 ? `${d.groupCount - d.groupsReachable} בלי זרוע מחוברת` : 'כולן עם זרוע מחוברת'}
          icon={<UsersRound className="h-5 w-5" />}
          tone="sky"
        />
        <Stat label="נשלחו היום" value={d.sentToday} sub={`סה״כ ${d.sentTotal.toLocaleString('he-IL')}`} icon={<Send className="h-5 w-5" />} tone="violet" />
        <Stat label="הפצות פעילות" value={d.active.length} icon={<Radio className="h-5 w-5" />} tone="pink" />
      </div>

      <TodayStrip t={d.today2} station={station} isSuper={isSuper} />

      {d.delivery.length > 0 && <DeliveryMonitor rows={d.delivery} />}

      {(problems.length > 0 || d.pendingPhone > 0 || d.recentFailed > 0 || d.noPerm.count > 0 || d.stationAlerts.length > 0 || d.health.length > 0 || d.engineDown || d.armRequests.length > 0) && (
        <Card className="mt-4 border-amber-200 bg-amber-50/60 p-4">
          <div className="mb-2 flex items-center gap-2 font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4" />
            דורש תשומת לב
          </div>
          <ul className="space-y-1.5 text-sm text-amber-900">
            {problems.map((a: any) => (
              <li key={a.id}>
                <Link href="/arms" className="hover:underline">
                  <b>{a.name}</b> – {ARM_STATUS[a.status]?.label}
                  {a.last_error ? `: ${a.last_error}` : ''}
                </Link>
              </li>
            ))}
            {d.pendingPhone > 0 && (
              <li>
                <Link href="/dispatchers" className="hover:underline">
                  {d.pendingPhone} בקשות עזרה ממתינות למספר טלפון
                </Link>
              </li>
            )}
            {d.armRequests.map((r: any) => (
              <li key={`r${r.id}`}>
                <Link href="/billing" className="font-medium hover:underline">
                  תחנה <b>{r.station_name}</b> מבקשת עוד {r.count} {r.count === 1 ? 'זרוע' : 'זרועות'} – לאישור
                </Link>
              </li>
            ))}
            {d.engineDown && (
              <li className="font-semibold text-rose-700">המנוע לא דיווח מאז {fmtTime(d.engineDown)} – ייתכן שהשרת נפל. בדוק ב-Railway.</li>
            )}
            {d.health
              .filter((r: any) => r.station_id !== station?.id)
              .map((r: any, i: number) => (
                <li key={`h${i}`}>
                  <Link href="/stations" className="hover:underline">
                    תחנה <b>{r.station_name}</b>
                    {r.arm_id ? ` – ${r.arm_name}: ${ARM_STATUS[r.arm_status]?.label || r.arm_status}${r.arm_error ? ` (${r.arm_error})` : ''}` : ''}
                    {r.failed_hour > 0 ? ` – ${r.failed_hour} שליחות נכשלו בשעה האחרונה` : ''}
                  </Link>
                </li>
              ))}
            {d.stationAlerts.map((s: any) => (
              <li key={s.id}>
                <Link href="/stations" className="hover:underline">
                  מנוי התחנה <b>{s.name}</b> {s.left < 0 ? 'הסתיים – הגישה חסומה' : s.left === 0 ? 'מסתיים היום' : `מסתיים בעוד ${s.left} ימים`}
                </Link>
              </li>
            ))}
            {d.recentFailed > 0 && <li>{d.recentFailed} שליחות נכשלו ב-24 השעות האחרונות</li>}
            {d.noPerm.count > 0 && d.noPerm.campaign && (
              <li>
                <Link href={`/history/${d.noPerm.campaign}`} className="font-medium hover:underline">
                  ב-{d.noPerm.count} קבוצות שברשימות ההפצה אין לזרוע הרשאה לשלוח – לבדיקה והסרה
                </Link>
              </li>
            )}
          </ul>
        </Card>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="font-semibold">הפצות פעילות</h2>
            <Link href="/history" className="flex items-center text-sm font-medium text-indigo-600">
              לכל ההיסטוריה <ChevronLeft className="h-4 w-4" />
            </Link>
          </div>
          {d.active.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">אין הפצות פעילות כרגע</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.active.map((c: any) => (
                <li key={c.id}>
                  <Link href={`/history/${c.id}`} className="block px-5 py-3.5 hover:bg-slate-50">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 truncate text-sm font-medium">{firstLine(c.message_text)}</div>
                      <Badge tone={CAMPAIGN_STATUS[c.status]?.tone} dot>
                        {CAMPAIGN_STATUS[c.status]?.label}
                      </Badge>
                    </div>
                    <Progress sent={c.sent} failed={c.failed} total={c.total - (c.unavailable || 0)} />
                    <div className="mt-1.5 flex justify-between gap-2 text-xs text-slate-500">
                      <span>
                        נשלחו {c.sent} מתוך {c.total - (c.unavailable || 0)} קבוצות זמינות
                        {c.unavailable > 0 && ` · ${c.unavailable} בלי זרוע מחוברת`} · {KIND_LABEL[c.kind] || c.kind}
                      </span>
                      <span>{fmtTime(c.created_at)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="font-semibold">זרועות</h2>
            {can('admin') && (
              <Link href="/arms" className="flex items-center text-sm font-medium text-indigo-600">
                ניהול <ChevronLeft className="h-4 w-4" />
              </Link>
            )}
          </div>
          {d.arms.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">עדיין לא חוברו זרועות</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.arms.map((a: any) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{a.name}</div>
                    <div className="text-xs text-slate-500" dir="ltr">
                      {a.phone || '—'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-slate-500">{d.perArm[a.id] || 0} קבוצות</span>
                    <Badge tone={ARM_STATUS[a.status]?.tone} dot>
                      {ARM_STATUS[a.status]?.label}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {can('admin') && (
        <Card className="mt-4">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="flex items-center gap-2 font-semibold">
              <Activity className="h-4 w-4 text-indigo-500" />
              פעילות אחרונה
            </h2>
            <Link href="/settings#log" className="flex items-center text-sm font-medium text-indigo-600">
              ליומן המלא <ChevronLeft className="h-4 w-4" />
            </Link>
          </div>
          {d.log.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-slate-500">אין פעילות עדיין</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {d.log.map((l: any) => (
                <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0 truncate">
                    <b className="font-medium">{l.actor_name || 'מערכת'}</b> · {ACTION_LABEL[l.action] || l.action}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">{timeAgo(l.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}

// Today at a glance: rides, how the sends ended, and the station's subscription
function TodayStrip({ t, station, isSuper }: { t: { rides: number; sent: number; failed: number; unavailable: number; total: number }; station: any; isSuper: boolean }) {
  const done = t.sent + t.failed;
  const rate = done > 0 ? Math.round((t.sent / done) * 100) : null;
  let sub: { text: string; tone: 'green' | 'amber' | 'red' | 'slate' } | null = null;
  if (station && !station.is_home && !(isSuper && !station.acting)) {
    if (!station.sub_end) sub = { text: 'מנוי פעיל', tone: 'green' };
    else {
      const left = Math.ceil((new Date(station.sub_end + 'T23:59:59').getTime() - Date.now()) / 86400000);
      const end = new Date(station.sub_end).toLocaleDateString('he-IL');
      if (left < 0) sub = { text: `המנוי הסתיים ב-${end}`, tone: 'red' };
      else if (left <= 7) sub = { text: left === 0 ? 'המנוי מסתיים היום' : `המנוי מסתיים בעוד ${left} ימים (${end})`, tone: 'amber' };
      else sub = { text: `מנוי פעיל עד ${end}`, tone: 'green' };
    }
  }
  return (
    <Card className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
      <span className="font-semibold">היום</span>
      <span>
        <b>{t.rides}</b> נסיעות
      </span>
      <span className="text-emerald-700">
        <b>{t.sent.toLocaleString('he-IL')}</b> נשלחו לקבוצות
      </span>
      {t.failed > 0 && (
        <span className="text-rose-700">
          <b>{t.failed.toLocaleString('he-IL')}</b> נכשלו
        </span>
      )}
      {t.unavailable > 0 && (
        <span className="text-slate-500" title="קבוצות שאף זרוע מחוברת לא נמצאת בהן – לא נחשב כישלון">
          <b>{t.unavailable.toLocaleString('he-IL')}</b> בלי זרוע מחוברת
        </span>
      )}
      {rate !== null && <span className="text-slate-500">{rate}% הצלחה</span>}
      {sub && (
        <span className="ms-auto">
          <Badge tone={sub.tone} dot>
            {sub.text}
          </Badge>
        </span>
      )}
    </Card>
  );
}

// Owner: per arm, how many member devices could not decrypt our messages in the last hour, how many were
// fixed by a re-send, and how many stayed unreadable ("waiting for this message").
function DeliveryMonitor({ rows }: { rows: any[] }) {
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const lostTotal = rows.reduce((n, r) => n + (r.lost_hour || 0), 0);
  return (
    <Card className="mt-4 p-4">
      <div className="mb-3 flex items-center gap-2 font-semibold">
        <Activity className="h-4 w-4" />
        מסירת הודעות – שעה אחרונה
        {lostTotal > 0 ? (
          <Badge tone="red">{lostTotal} לא תוקנו</Badge>
        ) : (
          <Badge tone="green">תקין</Badge>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-xs text-slate-500">
            <tr className="text-right">
              <th className="py-1 font-medium">זרוע</th>
              <th className="py-1 font-medium">נשלחו</th>
              <th className="py-1 font-medium">לא פוענחו אצל מקבלים</th>
              <th className="py-1 font-medium">נשלחו שוב</th>
              <th className="py-1 font-medium">נשארו "בהמתנה"</th>
              <th className="py-1 font-medium">נכנסות שלא פוענחו</th>
              <th className="py-1 font-medium">24 שעות</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.arm_id} className="border-t border-slate-100">
                <td className="py-1.5">
                  <b>{r.arm_name}</b>
                  <div className="text-xs text-slate-500">{r.station_name}</div>
                </td>
                <td>{r.sent_hour}</td>
                <td className={r.failed_hour > 0 ? 'text-amber-700' : ''}>
                  {r.failed_hour} {r.devices_hour ? <span className="text-xs text-slate-500">({r.devices_hour} מכשירים)</span> : null}
                </td>
                <td>{r.resent_hour}</td>
                <td className={r.lost_hour > 0 ? 'font-semibold text-red-700' : ''}>{r.lost_hour}</td>
                <td className={r.undecrypted_hour > 0 ? 'text-amber-700' : ''}>{r.undecrypted_hour}</td>
                <td className="text-xs text-slate-500">
                  {r.failed_day} תקלות · {r.resent_day} תוקנו · {pct(r.lost_day, r.failed_day)}% נשארו
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
