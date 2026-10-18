'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Bell, BellRing, X } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { enablePush, pushState, PushState } from '@/lib/push';
import { cx, toast } from './ui';

// unread count of the notifications feed, refreshed every 20s while the app is open
export function useUnread() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      const { data } = await sb().rpc('notifications_unread');
      if (!stop && typeof data === 'number') setN(data);
    };
    load();
    const iv = setInterval(load, 20_000);
    const onVis = () => document.visibilityState === 'visible' && load();
    const onRead = () => setN(0);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('notifications-read', onRead);
    return () => {
      stop = true;
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('notifications-read', onRead);
    };
  }, []);
  return n;
}

export function NotifyBell({ className }: { className?: string }) {
  const n = useUnread();
  return (
    <Link href="/notifications" aria-label={n ? `${n} התראות שלא נקראו` : 'התראות'} className={cx('relative rounded-lg p-2 text-slate-500 hover:bg-slate-100', className)}>
      <Bell className="h-5 w-5" />
      {n > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-[11px] font-bold text-white tabular-nums">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </Link>
  );
}

// a one-line invitation to turn phone notifications on, until the user does it or closes it
export function PushInvite() {
  const [st, setSt] = useState<PushState | null>(null);
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem('push-invite-closed') === '1');
    } catch {
      setHidden(false);
    }
    pushState().then(setSt).catch(() => setSt('unsupported'));
  }, []);
  if (hidden || !st || st === 'on' || st === 'unsupported' || st === 'denied') return null;
  return (
    <div className="mx-auto mb-4 flex max-w-6xl items-center gap-3 rounded-2xl bg-indigo-50 px-4 py-3 text-sm text-indigo-900 ring-1 ring-indigo-100">
      <BellRing className="h-5 w-5 shrink-0 text-indigo-600" />
      <div className="min-w-0 flex-1">
        {st === 'ios-install'
          ? 'כדי לקבל התראות באייפון: שיתוף ← "הוסף למסך הבית", ופתח את המערכת מהאייקון.'
          : 'קבל התראה בטלפון כשזרוע מתנתקת ועל הודעות מערכת.'}
      </div>
      {st === 'off' && (
        <button
          className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white"
          onClick={async () => {
            try {
              const r = await enablePush();
              setSt(r);
              toast(r === 'on' ? 'ההתראות הופעלו' : r === 'denied' ? 'ההתראות חסומות בהגדרות הדפדפן' : 'ההתראות לא הופעלו', r === 'on' ? 'ok' : 'error');
            } catch (e: any) {
              toast(e?.message || 'לא הצלחנו להפעיל התראות', 'error');
            }
          }}
        >
          הפעלת התראות
        </button>
      )}
      <button
        aria-label="סגירה"
        className="shrink-0 rounded-lg p-1 text-indigo-400 hover:bg-indigo-100"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem('push-invite-closed', '1');
          } catch {}
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
