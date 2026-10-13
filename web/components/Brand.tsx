'use client';
import { useEffect, useState } from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { cx } from './ui';

/** BotiX mark: a rounded asphalt tile with a taxi-amber "X" roof light. */
export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} aria-label="BotiX" role="img">
      <rect width="40" height="40" rx="11" fill="#151920" />
      <rect x="12" y="6" width="16" height="6" rx="2.5" fill="#FFC21A" />
      <path d="M13 17.5 L27 31.5 M27 17.5 L13 31.5" stroke="#FFC21A" strokeWidth="4.2" strokeLinecap="round" />
    </svg>
  );
}

export function BrandWord({ className }: { className?: string }) {
  return (
    <span className={cx('font-bold tracking-tight', className)} dir="ltr">
      BotiX
    </span>
  );
}

export type Brand = { station_id: string; name: string; logo_data: string | null; plan: string | null; status: string; sub_end: string | null; price: number | null };

let cache: { at: number; v: Brand | null } | null = null;
const listeners = new Set<(b: Brand | null) => void>();

/** The station the user is working in (name + logo). Cached for a minute; `refreshBrand()` after a logo change. */
export function useBrand(enabled: boolean) {
  const [b, setB] = useState<Brand | null>(cache?.v ?? null);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setB);
    if (!cache || Date.now() - cache.at > 60_000) refreshBrand();
    return () => {
      listeners.delete(setB);
    };
  }, [enabled]);
  return enabled ? b : null;
}
export async function refreshBrand() {
  try {
    const { data } = await sb().rpc('station_brand');
    const v = ((Array.isArray(data) ? data[0] : data) as Brand) || null;
    cache = { at: Date.now(), v };
    listeners.forEach((f) => f(v));
  } catch {
    /* older database without station_brand – keep the default mark */
  }
}

/** Station logo or the BotiX mark when there is none. */
export function StationLogo({ logo, name, size = 40, className }: { logo?: string | null; name?: string; size?: number; className?: string }) {
  if (!logo) return <BrandMark size={size} className={className} />;
  return (
    <img
      src={logo}
      alt={name ? `הלוגו של ${name}` : 'לוגו התחנה'}
      width={size}
      height={size}
      className={cx('shrink-0 rounded-[11px] bg-white object-contain ring-1 ring-slate-200', className)}
      style={{ width: size, height: size }}
    />
  );
}

/** The station "roof sign" – the signature header of the home screen. */
export function StationSign({ name, logo, status, sub }: { name: string; logo?: string | null; status: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <StationLogo logo={logo} name={name} size={56} className="rounded-2xl" />
      <div className="min-w-0">
        <div className="roof-sign inline-flex max-w-full items-center gap-2 rounded-t-xl rounded-b-md px-3.5 py-1 text-[13px] font-bold">
          <span className="truncate">{name}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
          {status}
          {sub}
        </div>
      </div>
    </div>
  );
}

// ---------- theme ----------
type Theme = 'light' | 'dark' | 'system';
function apply(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>('system');
  useEffect(() => {
    let saved: Theme = 'system';
    try {
      saved = (localStorage.getItem('botix-theme') as Theme) || 'system';
    } catch {}
    setT(saved);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => apply(((): Theme => {
      try {
        return (localStorage.getItem('botix-theme') as Theme) || 'system';
      } catch {
        return 'system';
      }
    })());
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  const set = (v: Theme) => {
    setT(v);
    try {
      if (v === 'system') localStorage.removeItem('botix-theme');
      else localStorage.setItem('botix-theme', v);
    } catch {}
    apply(v);
  };
  return [t, set];
}

export function ThemeToggle({ className }: { className?: string }) {
  const [t, set] = useTheme();
  const opts: { v: Theme; icon: any; label: string }[] = [
    { v: 'light', icon: Sun, label: 'בהיר' },
    { v: 'system', icon: Monitor, label: 'לפי המכשיר' },
    { v: 'dark', icon: Moon, label: 'כהה' },
  ];
  return (
    <div className={cx('inline-flex rounded-lg bg-slate-100 p-0.5', className)} role="radiogroup" aria-label="מצב תצוגה">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={t === o.v}
          title={o.label}
          aria-label={o.label}
          onClick={() => set(o.v)}
          className={cx('grid h-7 w-8 place-items-center rounded-md transition', t === o.v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-700')}
        >
          <o.icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
