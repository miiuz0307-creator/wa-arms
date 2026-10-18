'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, BellRing, Megaphone, Smartphone, CheckCircle2 } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import { disablePush, enablePush, pushState, PushState } from '@/lib/push';
import { Badge, Button, Card, Empty, PageHeader, Spinner, cx, toast } from '@/components/ui';

type N = { id: number; kind: string; level: string; title: string; body: string | null; url: string | null; created_at: string; read: boolean; station_name: string | null };

export default function NotificationsPage() {
  const { isSuper, station } = useAuth();
  const [rows, setRows] = useState<N[] | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('my_notifications', { p_limit: 100 });
    if (error) return setRows([]);
    setRows((data as N[]) || []);
  }, []);
  useEffect(() => {
    load().then(async () => {
      // opening the screen = everything here is read
      await sb().rpc('notifications_mark_read', { p_ids: null });
      window.dispatchEvent(new Event('notifications-read'));
    });
    pushState().then(setPush).catch(() => setPush('unsupported'));
  }, [load]);
  useRealtime(['notifications'], load, undefined, 15000);

  async function togglePush() {
    setBusy(true);
    try {
      if (push === 'on') {
        await disablePush();
        setPush('off');
        toast('ההתראות בטלפון הזה כובו');
      } else {
        const r = await enablePush();
        setPush(r);
        toast(r === 'on' ? 'ההתראות הופעלו בטלפון הזה' : r === 'denied' ? 'ההתראות חסומות בהגדרות הדפדפן' : 'ההתראות לא הופעלו', r === 'on' ? 'ok' : 'error');
      }
    } catch (e: any) {
      toast(e?.message || 'לא הצלחנו לשנות את ההתראות', 'error');
    }
    setBusy(false);
  }

  const owner = isSuper && !station?.acting;

  return (
    <>
      <PageHeader title="התראות" subtitle="זרועות שהתנתקו או חזרו לעבוד, והודעות מערכת. כל ההתראות נשמרות כאן." />

      <Card className="mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-xl', push === 'on' ? 'bg-emerald-50 text-emerald-600' : 'bg-indigo-50 text-indigo-600')}>
          {push === 'on' ? <BellRing className="h-5 w-5" /> : <Smartphone className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-semibold">התראות בטלפון</div>
          <div className="text-slate-600">
            {push === null && 'בודק…'}
            {push === 'on' && 'פעילות בטלפון הזה – תקבל התראה גם כשהמערכת סגורה.'}
            {push === 'off' && 'לא פעילות בטלפון הזה. הפעל כדי לקבל התראה מיד כשזרוע מתנתקת.'}
            {push === 'denied' && 'חסומות בהגדרות הדפדפן. כדי להפעיל: הגדרות הדפדפן ← הרשאות האתר ← התראות ← אפשר.'}
            {push === 'ios-install' && 'באייפון: שיתוף ← "הוסף למסך הבית", פתח את המערכת מהאייקון, ואז הפעל כאן.'}
            {push === 'unsupported' && 'הדפדפן הזה לא תומך בהתראות. נסה בכרום (אנדרואיד) או מהאייקון במסך הבית (אייפון).'}
          </div>
        </div>
        {(push === 'on' || push === 'off') && (
          <Button variant={push === 'on' ? 'secondary' : 'primary'} onClick={togglePush} loading={busy}>
            {push === 'on' ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
            {push === 'on' ? 'כיבוי בטלפון הזה' : 'הפעלת התראות'}
          </Button>
        )}
      </Card>

      {owner && (
        <Card className="mb-4 flex items-center gap-3 p-4 text-sm">
          <Megaphone className="h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-slate-600">הודעת מערכת לכל התחנות או לתחנה אחת – נשלחת גם כהתראה לטלפונים שלהן.</div>
          <Link href="/control#messages" className="shrink-0 font-medium text-indigo-600 hover:underline">
            שליחת הודעת מערכת
          </Link>
        </Card>
      )}

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <Empty icon={<CheckCircle2 className="h-6 w-6" />} title="אין התראות" text="כשזרוע תתנתק או תגיע הודעת מערכת, היא תופיע כאן." />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const inner = (
                <div className={cx('flex items-start gap-3 px-5 py-3.5', !r.read && 'bg-indigo-50/50')}>
                  <span
                    className={cx(
                      'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full',
                      r.kind === 'arm_down' ? 'bg-rose-500' : r.kind === 'arm_up' ? 'bg-emerald-500' : r.level === 'urgent' ? 'bg-rose-500' : r.level === 'warning' ? 'bg-amber-500' : 'bg-indigo-500',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{r.title}</span>
                      {r.station_name && <Badge>{r.station_name}</Badge>}
                      {r.kind === 'system' && <Badge tone="amber">הודעת מערכת</Badge>}
                    </div>
                    {r.body && <div className="mt-0.5 whitespace-pre-line text-sm text-slate-600">{r.body}</div>}
                    <div className="mt-1 text-xs text-slate-400">{timeAgo(r.created_at)}</div>
                  </div>
                </div>
              );
              return (
                <li key={r.id}>
                  {r.url && r.url !== '/notifications' ? (
                    <Link href={r.url} className="block hover:bg-slate-50">
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
