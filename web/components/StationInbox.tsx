'use client';
// What the system owner shows inside a station's app: system messages and the payment reminder.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CalendarClock, Info, Megaphone, X } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { cx } from './ui';

export type Inbox = {
  messages: { id: number; title: string; body: string | null; level: 'info' | 'warning' | 'urgent'; at: string }[];
  billing: { price: number | null; sub_end: string | null; days_left: number | null; months_overdue: number; owed: number; payment_note: string | null; remind: boolean } | null;
  arms: { max: number | null; count: number };
  arm_request: { id: number; count: number; status: string; at: string } | null;
};

const KEY = 'wa-dismissed-messages';
const readDismissed = (): number[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
};

export function useInbox(enabled: boolean) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    const { data } = await sb().rpc('station_inbox');
    if (data) setInbox(data as Inbox);
  }, [enabled]);
  useEffect(() => {
    load();
    if (!enabled) return;
    const iv = setInterval(load, 5 * 60_000);
    return () => clearInterval(iv);
  }, [load, enabled]);
  return { inbox, reload: load };
}

const money = (n: number | null | undefined) => `${Math.round(Number(n || 0)).toLocaleString('he-IL')} ₪`;
const fmtDate = (d: string | null) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('he-IL') : '');

export function StationBanners({ inbox }: { inbox: Inbox | null }) {
  const [dismissed, setDismissed] = useState<number[]>([]);
  useEffect(() => setDismissed(readDismissed()), []);
  if (!inbox) return null;
  const dismiss = (id: number) => {
    const next = [...dismissed, id].slice(-200);
    setDismissed(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
  };
  const msgs = inbox.messages.filter((m) => !dismissed.includes(m.id));
  const b = inbox.billing;
  const tone = (level: 'red' | 'amber' | 'blue') =>
    level === 'red'
      ? 'bg-rose-50 text-rose-900 ring-rose-600/20 [&_svg]:text-rose-600'
      : level === 'amber'
        ? 'bg-amber-50 text-amber-900 ring-amber-600/25 [&_svg]:text-amber-600'
        : 'bg-indigo-50 text-indigo-900 ring-indigo-600/20 [&_svg]:text-indigo-600';
  return (
    <>
      {b && b.remind && (
        <div
          role="status"
          className={cx(
            'mx-auto mb-4 flex max-w-6xl items-start gap-3 rounded-2xl px-4 py-3 text-sm ring-1 ring-inset',
            tone(b.owed > 0 || (b.days_left ?? 1) < 0 ? 'red' : 'amber'),
          )}
        >
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              {b.owed > 0 ? (
                <>
                  המנוי הסתיים ב-<span className="tabular-nums">{fmtDate(b.sub_end)}</span> · לתשלום <span className="tabular-nums">{money(b.owed)}</span>
                </>
              ) : b.days_left === 0 ? (
                <>
                  התשלום החודשי (<span className="tabular-nums">{money(b.price)}</span>) מגיע היום
                </>
              ) : (
                <>
                  תזכורת: התשלום החודשי (<span className="tabular-nums">{money(b.price)}</span>) מגיע בעוד <span className="tabular-nums">{b.days_left}</span> ימים, ב-
                  <span className="tabular-nums">{fmtDate(b.sub_end)}</span>
                </>
              )}
            </div>
            {b.payment_note && <div className="mt-0.5 whitespace-pre-line leading-relaxed opacity-90">{b.payment_note}</div>}
          </div>
          <Link
            href="/subscription"
            className="-my-1 inline-flex h-9 shrink-0 items-center rounded-xl bg-white px-3 text-[13px] font-semibold ring-1 ring-inset ring-black/10 hover:bg-slate-50"
          >
            לחידוש המנוי
          </Link>
        </div>
      )}
      {msgs.map((m) => (
        <div
          key={m.id}
          role={m.level === 'urgent' ? 'alert' : 'status'}
          className={cx(
            'mx-auto mb-4 flex max-w-6xl items-start gap-3 rounded-2xl px-4 py-3 text-sm ring-1 ring-inset',
            tone(m.level === 'urgent' ? 'red' : m.level === 'warning' ? 'amber' : 'blue'),
          )}
        >
          {m.level === 'urgent' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : m.level === 'warning' ? <Megaphone className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{m.title}</div>
            {m.body && <div className="mt-0.5 whitespace-pre-line leading-relaxed opacity-90">{m.body}</div>}
          </div>
          <button
            type="button"
            onClick={() => dismiss(m.id)}
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg opacity-70 hover:bg-black/5 hover:opacity-100"
            title="הסתרת ההודעה"
            aria-label={`הסתרת ההודעה: ${m.title}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </>
  );
}
