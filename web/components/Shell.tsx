'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Smartphone,
  UsersRound,
  ListChecks,
  Send,
  LifeBuoy,
  Contact,
  History,
  ShieldCheck,
  Settings,
  LogOut,
  MoreHorizontal,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { useAuth, ROLE_LABEL, Role } from '@/lib/auth';
import { cx, Spinner } from './ui';

type Item = { href: string; label: string; icon: any; min: Role };

const NAV: Item[] = [
  { href: '/', label: 'בית', icon: LayoutDashboard, min: 'viewer' },
  { href: '/send', label: 'שליחת הודעה', icon: Send, min: 'operator' },
  { href: '/history', label: 'היסטוריה', icon: History, min: 'viewer' },
  { href: '/arms', label: 'חיבור זרועות', icon: Smartphone, min: 'admin' },
  { href: '/groups', label: 'ניהול קבוצות', icon: UsersRound, min: 'operator' },
  { href: '/lists', label: 'רשימות הפצה', icon: ListChecks, min: 'operator' },
  { href: '/help', label: 'הפצה אוטומטית', icon: LifeBuoy, min: 'admin' },
  { href: '/dispatchers', label: 'סדרנים', icon: Contact, min: 'operator' },
  { href: '/users', label: 'משתמשים והרשאות', icon: ShieldCheck, min: 'owner' },
  { href: '/settings', label: 'הגדרות ויומן', icon: Settings, min: 'admin' },
];
const MOBILE_MAIN = ['/', '/send', '/history', '/arms'];

function Toasts() {
  const [items, setItems] = useState<{ id: number; text: string; kind: string }[]>([]);
  useEffect(() => {
    const h = (e: any) => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, ...e.detail }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 3500);
    };
    window.addEventListener('app-toast', h);
    return () => window.removeEventListener('app-toast', h);
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            'flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg',
            t.kind === 'error' ? 'bg-rose-600' : 'bg-slate-900',
          )}
        >
          {t.kind === 'error' ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { loading, session, profile, can, signOut } = useAuth();
  const path = usePathname();
  const router = useRouter();
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (!loading && !session) router.replace('/login');
  }, [loading, session, router]);

  useEffect(() => setMore(false), [path]);

  if (loading || !session) return <Spinner className="min-h-dvh items-center" />;

  if (!profile?.is_active) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-amber-50 text-amber-600">
            <ShieldCheck className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-bold">החשבון ממתין לאישור</h1>
          <p className="mt-2 text-sm text-slate-500">בעל המערכת צריך לאשר את החשבון שלך ולהגדיר הרשאות. נסה שוב מאוחר יותר.</p>
          <button onClick={signOut} className="mt-6 text-sm font-medium text-indigo-600">
            התנתקות
          </button>
        </div>
      </div>
    );
  }

  const items = NAV.filter((n) => can(n.min));
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const mobileMain = items.filter((i) => MOBILE_MAIN.includes(i.href));
  const mobileMore = items.filter((i) => !MOBILE_MAIN.includes(i.href));

  return (
    <div className="min-h-dvh md:flex">
      <Toasts />
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-l border-slate-200/70 bg-white md:flex">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="brand-gradient grid h-10 w-10 place-items-center rounded-xl text-lg font-bold text-white shadow-md">ז</div>
          <div>
            <div className="font-bold leading-tight">זרועות</div>
            <div className="text-xs text-slate-500">ניהול הפצות WhatsApp</div>
          </div>
        </div>
        <nav className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-3">
          {items.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cx(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                active(n.href) ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
              )}
            >
              <n.icon className="h-[18px] w-[18px]" />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
              {(profile.full_name || profile.email || '?').slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{profile.full_name || profile.email}</div>
              <div className="text-xs text-slate-500">{ROLE_LABEL[profile.role]}</div>
            </div>
            <button onClick={signOut} title="התנתקות" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200/70 bg-white/85 px-4 py-3 backdrop-blur md:hidden">
        <div className="flex items-center gap-2.5">
          <div className="brand-gradient grid h-8 w-8 place-items-center rounded-lg text-sm font-bold text-white">ז</div>
          <span className="font-bold">זרועות</span>
        </div>
        <button onClick={signOut} className="rounded-lg p-2 text-slate-500">
          <LogOut className="h-5 w-5" />
        </button>
      </header>

      <main className="min-w-0 flex-1 px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/70 bg-white/95 backdrop-blur md:hidden">
        <div className="grid grid-cols-5">
          {mobileMain.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cx('flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium', active(n.href) ? 'text-indigo-600' : 'text-slate-500')}
            >
              <n.icon className="h-5 w-5" />
              {n.label.split(' ')[0]}
            </Link>
          ))}
          {mobileMore.length > 0 && (
            <button
              onClick={() => setMore((v) => !v)}
              className={cx('flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium', more ? 'text-indigo-600' : 'text-slate-500')}
            >
              <MoreHorizontal className="h-5 w-5" />
              עוד
            </button>
          )}
        </div>
      </nav>
      {more && (
        <div className="fixed inset-0 z-30 bg-slate-900/30 md:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-x-3 bottom-20 rounded-2xl bg-white p-2 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {mobileMore.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cx(
                  'flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium',
                  active(n.href) ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700',
                )}
              >
                <n.icon className="h-5 w-5" />
                {n.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function RequireRole({ min, children }: { min: Role; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(min)) {
    return <div className="py-20 text-center text-slate-500">אין לך הרשאה למסך הזה.</div>;
  }
  return <>{children}</>;
}
