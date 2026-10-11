'use client';
// What the system owner shows inside a station's app: system messages and the payment reminder.
import { useCallback, useEffect, useState } from 'react';
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
  return (
    <>
      {b && b.remind && (
        <div
          className={cx(
            'mx-auto mb-4 flex max-w-6xl items-start gap-2.5 rounded-2xl px-4 py-3 text-sm ring-1',
            b.owed > 0 || (b.days_left ?? 1) < 0 ? 'bg-rose-50 text-rose-900 ring-rose-200' : 'bg-amber-50 text-amber-900 ring-amber-200',
          )}
        >
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">
              {b.owed > 0
                ? `המנוי הסתיים ב-${fmtDate(b.sub_end)} – לתשלום ${money(b.owed)}`
                : b.days_left === 0
                  ? `התשלום החודשי (${money(b.price)}) מגיע היום`
                  : `תזכורת: התשלום החודשי (${money(b.price)}) מגיע בעוד ${b.days_left} ימים, ב-${fmtDate(b.sub_end)}`}
            </div>
            {b.payment_note && <div className="mt-0.5 whitespace-pre-line">{b.payment_note}</div>}
          </div>
        </div>
      )}
      {msgs.map((m) => (
        <div
          key={m.id}
          className={cx(
            'mx-auto mb-4 flex max-w-6xl items-start gap-2.5 rounded-2xl px-4 py-3 text-sm ring-1',
            m.level === 'urgent' ? 'bg-rose-50 text-rose-900 ring-rose-200' : m.level === 'warning' ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-indigo-50 text-indigo-900 ring-indigo-200',
          )}
        >
          {m.level === 'urgent' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : m.level === 'warning' ? <Megaphone className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{m.title}</div>
            {m.body && <div className="mt-0.5 whitespace-pre-line">{m.body}</div>}
          </div>
          <button onClick={() => dismiss(m.id)} className="rounded-lg p-1 opacity-60 hover:bg-white/60 hover:opacity-100" title="סגירה">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </>
  );
}
