'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Smartphone,
  UsersRound,
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
  Building2,
  ArrowRightLeft,
  CalendarClock,
  Gauge,
  Wallet,
  Rocket,
  CreditCard,
  PenLine,
} from 'lucide-react';
import { useAuth, ROLE_LABEL, Role } from '@/lib/auth';
import { actAsStation } from '@/lib/supabase';
import { cx, Spinner, ConfirmHost } from './ui';
import { BrandWord, StationLogo, ThemeToggle, useBrand } from './Brand';
import { StationBanners, useInbox } from './StationInbox';
import { AppLock } from './AppLock';
import { UpdateNotifier } from './UpdateNotifier';
import { LiveDot } from '@/components/LiveDot';

type Item = { href: string; label: string; short?: string; icon: any; min: Role; superOnly?: boolean; stationOnly?: boolean; group: 'ops' | 'manage' | 'owner' };

const NAV: Item[] = [
  { href: '/control', label: 'מרכז בקרה', icon: Gauge, min: 'owner', superOnly: true, group: 'owner' },
  { href: '/stations', label: 'תחנות', icon: Building2, min: 'owner', superOnly: true, group: 'owner' },
  { href: '/billing', label: 'מנויים ותשלומים', icon: Wallet, min: 'owner', superOnly: true, group: 'owner' },
  { href: '/support', label: 'פניות תמיכה', icon: LifeBuoy, min: 'owner', superOnly: true, group: 'owner' },
  { href: '/footer', label: 'חתימה בהודעות', icon: PenLine, min: 'owner', superOnly: true, group: 'owner' },
  { href: '/updates', label: 'ניהול עדכונים', icon: Rocket, min: 'owner', superOnly: true, group: 'owner' },
  { href: '/', label: 'בית', icon: LayoutDashboard, min: 'viewer', group: 'ops' },
  { href: '/send', label: 'שליחת הודעה', short: 'שליחה', icon: Send, min: 'operator', group: 'ops' },
  { href: '/history', label: 'היסטוריה', icon: History, min: 'viewer', group: 'ops' },
  { href: '/groups', label: 'ניהול קבוצות והפצה', short: 'קבוצות', icon: UsersRound, min: 'operator', group: 'ops' },
  { href: '/arms', label: 'זרועות', icon: Smartphone, min: 'admin', group: 'ops' },
  { href: '/subscription', label: 'המנוי והתשלומים שלי', short: 'מנוי', icon: CreditCard, min: 'admin', stationOnly: true, group: 'manage' },
  { href: '/support', label: 'תמיכה טכנית', short: 'תמיכה', icon: LifeBuoy, min: 'viewer', stationOnly: true, group: 'manage' },
  { href: '/users', label: 'משתמשים והרשאות', icon: ShieldCheck, min: 'owner', group: 'manage' },
  { href: '/settings', label: 'הגדרות', icon: Settings, min: 'admin', group: 'manage' },
];
const GROUP_LABEL = { owner: 'בעל המערכת', ops: 'הפצה', manage: 'ניהול' } as const;
const MOBILE_MAIN = ['/', '/send', '/groups', '/history'];

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
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={cx(
            'flex animate-rise items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-pop)]',
            t.kind === 'error' ? 'bg-[#c2283b]' : 'bg-[#151920] ring-1 ring-white/10',
          )}
        >
          {t.kind === 'error' ? <AlertCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-[#7ee2b8]" />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { loading, session, profile, can, signOut, station, isStation, isSuper } = useAuth();
  const path = usePathname();
  const router = useRouter();
  const [more, setMore] = useState(false);
  // messages and payment reminders from the system owner (station logins and the owner inside a station)
  const inStation = isStation || !!station?.acting;
  const { inbox } = useInbox(!!session && inStation && !station?.expired);
  const brand = useBrand(!!session && inStation && !station?.expired);

  useEffect(() => {
    if (!loading && !session) router.replace('/login');
  }, [loading, session, router]);

  useEffect(() => setMore(false), [path]);
  // subscription ended: only the subscription page (pay and renew) is open
  useEffect(() => {
    if (station?.expired && !path.startsWith('/subscription')) router.replace('/subscription');
  }, [station?.expired, path, router]);

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

  const ownerView = isSuper && !station?.acting;
  const items = station?.expired
    ? NAV.filter((n) => n.href === '/subscription')
    : NAV.filter(
        (n) => can(n.min) && (!n.superOnly || ownerView) && (!n.stationOnly || (inStation && !station?.is_home)) && !(ownerView && n.stationOnly),
      );
  const daysLeft = station?.sub_end ? Math.ceil((new Date(station.sub_end + 'T23:59:59').getTime() - Date.now()) / 86400000) : null;
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const mobileMain = MOBILE_MAIN.map((h) => items.find((i) => i.href === h)).filter(Boolean) as Item[];
  const mobileMore = items.filter((i) => !MOBILE_MAIN.includes(i.href));
  const stationName = inStation ? brand?.name || station?.name || '' : 'BotiX';
  const logo = inStation ? brand?.logo_data : null;
  const who = isStation ? 'מנהל התחנה' : ROLE_LABEL[profile.role];
  const groups = (['owner', 'ops', 'manage'] as const).map((g) => ({ g, list: items.filter((i) => i.group === g) })).filter((x) => x.list.length);

  return (
    <AppLock
      isStation={isStation}
      ownerEmail={isStation ? null : profile.email}
      name={(isStation ? station?.name : profile.full_name || profile.email) || 'משתמש'}
      onSignOut={signOut}
    >
    <div className="min-h-dvh md:flex">
      <Toasts />
      <ConfirmHost />
      <UpdateNotifier />
      {/* Desktop sidebar – always asphalt, in both themes */}
      <aside className="sticky top-0 hidden h-dvh w-[264px] shrink-0 flex-col bg-[#151920] text-[#c9d0d9] md:flex">
        <div className="flex items-center gap-3 px-5 pb-4 pt-5">
          <StationLogo logo={logo} name={stationName} size={40} />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold leading-tight text-white">{inStation ? stationName : <BrandWord />}</div>
            <LiveDot onDark className="mt-1" />
          </div>
        </div>
        <nav className="scroll-thin flex-1 overflow-y-auto px-3 pb-3" aria-label="ניווט ראשי">
          {groups.map(({ g, list }) => (
            <div key={g} className="mt-3 first:mt-1">
              {groups.length > 1 && <div className="px-3 pb-1.5 text-[11px] font-medium text-white/35">{GROUP_LABEL[g]}</div>}
              <div className="space-y-0.5">
                {list.map((n) => {
                  const on = active(n.href);
                  return (
                    <Link
                      key={n.href + n.group}
                      href={n.href}
                      aria-current={on ? 'page' : undefined}
                      className={cx(
                        'relative flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition',
                        on ? 'bg-white/[0.08] text-white' : 'text-[#aeb6c1] hover:bg-white/[0.05] hover:text-white',
                      )}
                    >
                      {on && <span className="absolute inset-y-1.5 right-0 w-[3px] rounded-full bg-[#FFC21A]" />}
                      <n.icon className={cx('h-[18px] w-[18px]', on ? 'text-[#FFC21A]' : 'text-white/45')} />
                      {n.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-white/[0.07] p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-semibold text-white">
              {(profile.full_name || profile.email || '?').slice(0, 1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{profile.full_name || profile.email}</div>
              <div className="text-xs text-white/45">{who}</div>
            </div>
            <button onClick={signOut} title="התנתקות" aria-label="התנתקות" className="rounded-lg p-2 text-white/45 hover:bg-white/10 hover:text-white">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1 flex items-center justify-between px-2">
            <span className="text-[11px] text-white/35">
              <BrandWord className="font-semibold text-white/50" /> · מצב תצוגה
            </span>
            <ThemeToggle className="!bg-white/10 [&_button[aria-checked=true]]:!bg-white/90 [&_button[aria-checked=true]]:!text-[#151920] [&_button]:text-white/50" />
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200/70 bg-white/85 px-4 py-2.5 backdrop-blur-md md:hidden">
        <div className="flex min-w-0 items-center gap-2.5">
          <StationLogo logo={logo} name={stationName} size={34} />
          <div className="min-w-0 leading-tight">
            <div className="truncate font-semibold text-slate-900">{inStation ? stationName : <BrandWord />}</div>
            <LiveDot />
          </div>
        </div>
        <button onClick={() => setMore(true)} aria-label="תפריט" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </header>

      <main className="min-w-0 flex-1 px-4 pb-28 pt-5 md:px-8 md:pb-12 md:pt-8">
        {station?.acting && (
          <div className="mx-auto mb-4 flex max-w-6xl flex-wrap items-center justify-between gap-2 rounded-xl bg-[#151920] px-4 py-3 text-sm text-white">
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#FFC21A]" />
              אתה בתוך התחנה <b>{station.name}</b> כמנהל ראשי. כל פעולה כאן משפיעה רק עליה.
            </span>
            <button onClick={() => actAsStation(null)} className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 font-medium hover:bg-white/20">
              <ArrowRightLeft className="h-4 w-4" />
              חזרה לחשבון שלי
            </button>
          </div>
        )}
        {isStation && !inbox && daysLeft !== null && daysLeft <= 7 && (
          <div className="mx-auto mb-4 flex max-w-6xl items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
            <CalendarClock className="h-4 w-4 shrink-0" />
            {daysLeft <= 0 ? 'המנוי מסתיים היום.' : `המנוי מסתיים בעוד ${daysLeft} ימים.`}
            <Link href="/subscription" className="font-semibold underline underline-offset-2">
              לחידוש המנוי
            </Link>
          </div>
        )}
        <StationBanners inbox={inbox} />
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/70 bg-white/95 backdrop-blur-md md:hidden" aria-label="ניווט">
        <div className="grid grid-cols-5">
          {mobileMain.map((n) => {
            const on = active(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={on ? 'page' : undefined}
                className={cx('relative flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium', on ? 'text-slate-900' : 'text-slate-500')}
              >
                {on && <span className="absolute top-0 h-[3px] w-8 rounded-b-full bg-[#FFC21A]" />}
                <n.icon className={cx('h-5 w-5', on && 'text-indigo-600')} />
                {n.short || n.label}
              </Link>
            );
          })}
          <button
            onClick={() => setMore((v) => !v)}
            className={cx('flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium', more ? 'text-slate-900' : 'text-slate-500')}
          >
            <MoreHorizontal className="h-5 w-5" />
            עוד
          </button>
        </div>
      </nav>
      {more && (
        <div className="fixed inset-0 z-50 bg-[rgb(15_18_23/0.45)] md:hidden" onClick={() => setMore(false)}>
          <div className="safe-bottom absolute inset-x-0 bottom-0 animate-rise rounded-t-3xl bg-white p-3 shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-200" />
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">
                {(profile.full_name || profile.email || '?').slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{profile.full_name || profile.email}</div>
                <div className="text-xs text-slate-500">{who}</div>
              </div>
              <ThemeToggle />
            </div>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {mobileMore.map((n) => (
                <Link
                  key={n.href + n.group}
                  href={n.href}
                  className={cx(
                    'flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium',
                    active(n.href) ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <n.icon className="h-5 w-5 shrink-0" />
                  <span className="truncate">{n.label}</span>
                </Link>
              ))}
            </div>
            <button onClick={signOut} className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-rose-700 hover:bg-rose-50">
              <LogOut className="h-5 w-5" />
              התנתקות
            </button>
          </div>
        </div>
      )}
    </div>
    </AppLock>
  );
}

export function RequireRole({ min, children }: { min: Role; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(min)) {
    return <div className="py-20 text-center text-slate-500">אין לך הרשאה למסך הזה.</div>;
  }
  return <>{children}</>;
}
