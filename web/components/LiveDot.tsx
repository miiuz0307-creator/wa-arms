'use client';
import { useLive } from '@/lib/live';

/** Green = the screen is live and refreshing by itself; amber = an update is late; red = no connection to the server. */
export function LiveDot({ className = '' }: { className?: string }) {
  const { level, seconds } = useLive();
  const tone =
    level === 'live'
      ? { dot: 'bg-emerald-500', ring: 'bg-emerald-400', text: 'text-emerald-700', label: 'מעודכן' }
      : level === 'late'
        ? { dot: 'bg-amber-500', ring: 'bg-amber-400', text: 'text-amber-700', label: 'מתעדכן…' }
        : { dot: 'bg-red-500', ring: 'bg-red-400', text: 'text-red-700', label: 'אין חיבור – מנסה שוב' };
  const ago = level !== 'down' && seconds !== null && seconds >= 3 ? ` · לפני ${seconds} שנ׳` : '';
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone.text} ${className}`}
      title="הנתונים במסך מתעדכנים אוטומטית כל כמה שניות"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2.5 w-2.5">
        {level === 'live' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${tone.ring}`} />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${tone.dot}`} />
      </span>
      {tone.label}
      <span className="font-normal text-slate-400">{ago}</span>
    </span>
  );
}
