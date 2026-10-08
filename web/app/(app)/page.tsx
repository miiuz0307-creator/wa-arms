'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Smartphone, UsersRound, Send, Radio, AlertTriangle, Activity, ChevronLeft } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { ACTION_LABEL, KIND_LABEL, ARM_STATUS, CAMPAIGN_STATUS, firstLine, fmtTime, timeAgo } from '@/lib/format';
import { Badge, Card, PageHeader, Progress, Spinner, Stat, Button } from '@/components/ui';

export default function Dashboard() {
  const { can, profile } = useAuth();
  const [d, setD] = useState<any>(null);

  const load = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [arms, groups, active, pendingPhone, recentFailed, log] = await Promise.all([
      sb().from('arms').select('*').order('created_at'),
      sb().from('groups').select('arm_id,wa_group_id'),
      sb().from('campaigns').select('*').in('status', ['queued', 'running', 'paused']).order('created_at', { ascending: false }).limit(8),
      sb().from('campaigns').select('id', { count: 'exact', head: true }).eq('status', 'pending_phone'),
      sb()
        .from('campaign_targets')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed')
        .gte('sent_at', new Date(Date.now() - 86400000).toISOString()),
      can('admin') ? sb().from('activity_log').select('*').order('created_at', { ascending: false }).limit(8) : Promise.resolve({ data: [] }),
    ]);
    // groups with no permission in the last day that are still in a distribution list
    const np = await sb()
      .from('campaign_targets')
      .select('wa_group_id, campaign_id, sent_at, claimed_at')
      .in('status', ['skipped', 'failed'])
      .or('error.ilike.%הרשאה%,error.ilike.%not-acceptable%')
      .gte('claimed_at', new Date(Date.now() - 86400000).toISOString())
      .order('claimed_at', { ascending: false })
      .limit(500);
    const npIds = [...new Set((np.data || []).map((r: any) => r.wa_group_id))];
    let noPerm = { count: 0, campaign: null as string | null };
    if (npIds.length) {
      const { data: listed } = await sb().from('list_groups').select('wa_group_id').in('wa_group_id', npIds);
      const still = new Set((listed || []).map((r: any) => r.wa_group_id));
      noPerm = { count: still.size, campaign: (np.data || []).find((r: any) => still.has(r.wa_group_id))?.campaign_id || null };
    }

    const perArm: Record<string, number> = {};
    const distinct = new Set<string>();
    for (const g of groups.data || []) {
      perArm[g.arm_id] = (perArm[g.arm_id] || 0) + 1;
      distinct.add(g.wa_group_id);
    }
    const armRows = arms.data || [];
    setD({
      arms: armRows,
      perArm,
      groupCount: distinct.size,
      sentToday: armRows.reduce((s: number, a: any) => s + (a.sent_day === today ? a.sent_today : 0), 0),
      sentTotal: armRows.reduce((s: number, a: any) => s + Number(a.sent_total || 0), 0),
      active: active.data || [],
      pendingPhone: pendingPhone.count || 0,
      recentFailed: recentFailed.count || 0,
      log: log.data || [],
      noPerm,
    });
  }, [can]);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['arms', 'campaigns', 'activity_log'], load);

  if (!d) return <Spinner />;

  const online = d.arms.filter((a: any) => a.status === 'online').length;
  const problems = d.arms.filter((a: any) => ['offline', 'error'].includes(a.status) || (a.status === 'pending' && a.last_error));
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
        <Stat label="זרועות מחוברות" value={`${online}/${d.arms.length}`} icon={<Smartphone className="h-5 w-5" />} tone="green" />
        <Stat label="קבוצות" value={d.groupCount} icon={<UsersRound className="h-5 w-5" />} tone="sky" />
        <Stat label="נשלחו היום" value={d.sentToday} sub={`סה״כ ${d.sentTotal.toLocaleString('he-IL')}`} icon={<Send className="h-5 w-5" />} tone="violet" />
        <Stat label="הפצות פעילות" value={d.active.length} icon={<Radio className="h-5 w-5" />} tone="pink" />
      </div>

      {(problems.length > 0 || d.pendingPhone > 0 || d.recentFailed > 0 || d.noPerm.count > 0) && (
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
                    <Progress sent={c.sent} failed={c.failed} total={c.total} />
                    <div className="mt-1.5 flex justify-between text-xs text-slate-500">
                      <span>
                        {c.sent + c.failed}/{c.total} · {KIND_LABEL[c.kind] || c.kind}
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
