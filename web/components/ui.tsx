'use client';
import { Loader2, X, AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Tone } from '@/lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cx('rounded-2xl border border-slate-200/70 bg-white shadow-[var(--shadow-card)]', className)}>{children}</div>;
}

/** Card with a title row (and optional action on the left). */
export function Section({
  title,
  icon,
  action,
  children,
  className,
  bodyClass,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <Card className={className}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-slate-900">
          {icon && <span className="text-slate-400">{icon}</span>}
          <span className="truncate">{title}</span>
        </h2>
        {action}
      </div>
      <div className={bodyClass}>{children}</div>
    </Card>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-bold leading-tight tracking-tight text-slate-900 md:text-[30px]">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const BTN: Record<BtnVariant, string> = {
  primary: 'brand-gradient text-white shadow-sm',
  secondary: 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition duration-150 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-6 text-base',
        BTN[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

const TONE: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  sky: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  violet: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  slate: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  pink: 'bg-amber-50 text-amber-800 ring-amber-600/25',
};
const DOT: Record<Tone, string> = {
  green: 'bg-emerald-500',
  red: 'bg-rose-500',
  amber: 'bg-amber-500',
  sky: 'bg-sky-500',
  violet: 'bg-indigo-500',
  slate: 'bg-slate-400',
  pink: 'bg-amber-500',
};

export function Badge({ tone = 'slate', dot, children, className }: { tone?: Tone; dot?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE[tone] || TONE.slate,
        className,
      )}
    >
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', DOT[tone] || DOT.slate)} />}
      {children}
    </span>
  );
}

/** Status lamp: a small round light (green = working). */
export function Lamp({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {pulse && <span className={cx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-40', DOT[tone])} />}
      <span className={cx('relative inline-flex h-2.5 w-2.5 rounded-full', DOT[tone])} />
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-relaxed text-slate-500">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-[15px] text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 disabled:bg-slate-50 disabled:text-slate-500';

export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} className={cx(inputCls, 'min-h-28 leading-relaxed', p.className)} />
);
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx(inputCls, 'appearance-auto pe-2', p.className)} />
);

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50',
        checked ? 'bg-emerald-500' : 'bg-slate-300',
      )}
    >
      <span className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition', checked ? '-translate-x-5.5' : '-translate-x-0.5')} />
    </button>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-[18px] w-[18px] shrink-0 rounded border-slate-300 accent-indigo-600"
      />
      {label}
    </label>
  );
}

/** Pill switcher (filters, tabs). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div className={cx('inline-flex rounded-xl bg-slate-100 p-1', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition',
            value === o.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="tabular-nums text-slate-400">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

const STAT_TONE: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-600',
  red: 'bg-rose-50 text-rose-600',
  amber: 'bg-amber-50 text-amber-600',
  sky: 'bg-sky-50 text-sky-600',
  violet: 'bg-indigo-50 text-indigo-600',
  slate: 'bg-slate-100 text-slate-500',
  pink: 'bg-amber-50 text-amber-600',
};

export function Stat({
  label,
  value,
  sub,
  icon,
  tone = 'violet',
  href,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: Tone;
  href?: string;
}) {
  const long = (typeof value === 'string' || typeof value === 'number') && String(value).length > 6;
  const body = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-500">{label}</div>
        <div
          className={cx(
            'mt-1.5 font-semibold leading-none tabular-nums tracking-tight text-slate-900',
            long ? 'text-[22px] md:text-[28px]' : 'text-[28px] md:text-[32px]',
          )}
        >
          {value}
        </div>
        {sub && <div className="mt-2 text-xs leading-snug text-slate-500">{sub}</div>}
      </div>
      {icon && <div className={cx('h-9 w-9 shrink-0 place-items-center rounded-xl', long ? 'hidden md:grid' : 'grid', STAT_TONE[tone])}>{icon}</div>}
    </div>
  );
  return (
    <Card className={cx('p-4 md:p-5', href && 'transition hover:border-slate-300')}>
      {href ? (
        <a href={href} className="block">
          {body}
        </a>
      ) : (
        body
      )}
    </Card>
  );
}

export function Empty({ icon, title, text, action }: { icon?: React.ReactNode; title: string; text?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">{icon}</div>}
      <div className="font-semibold text-slate-800">{title}</div>
      {text && <div className="mt-1 max-w-sm text-sm leading-relaxed text-slate-500">{text}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

/** Page-level loading: a calm skeleton of a header and a few cards rather than a lone spinner. */
export function Spinner({ className }: { className?: string }) {
  if (className?.includes('min-h-dvh')) {
    return (
      <div className={cx('flex justify-center py-16 text-indigo-500', className)} role="status" aria-label="טוען">
        <Loader2 className="h-7 w-7 animate-spin" />
      </div>
    );
  }
  return (
    <div className={cx('space-y-4', className)} role="status" aria-label="טוען">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function Progress({ sent, failed, total }: { sent: number; failed: number; total: number }) {
  const s = total ? (sent / total) * 100 : 0;
  const f = total ? (failed / total) * 100 : 0;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(s)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${s}%` }} />
      <div className="h-full bg-rose-500 transition-all" style={{ width: `${f}%` }} />
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(15_18_23/0.45)] backdrop-blur-[2px] md:items-center md:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'flex max-h-[92dvh] w-full animate-rise flex-col rounded-t-3xl bg-white shadow-[var(--shadow-pop)] md:rounded-2xl',
          wide ? 'md:max-w-3xl' : 'md:max-w-lg',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-[17px] font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} aria-label="סגירה" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="scroll-thin overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="safe-bottom flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- confirm dialog (replaces the browser's confirm()) ----------
type ConfirmReq = { title: string; text?: React.ReactNode; ok?: string; danger?: boolean; resolve: (v: boolean) => void };

/** `if (await ask({ title: 'למחוק?', danger: true })) …` – a styled confirmation window. */
export function ask(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => window.dispatchEvent(new CustomEvent('app-confirm', { detail: { ...opts, resolve } })));
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmReq | null>(null);
  useEffect(() => {
    const h = (e: any) => setReq(e.detail);
    window.addEventListener('app-confirm', h);
    return () => window.removeEventListener('app-confirm', h);
  }, []);
  const done = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <Modal
      open={!!req}
      onClose={() => done(false)}
      title={req?.title || ''}
      footer={
        <>
          <Button variant="secondary" onClick={() => done(false)}>
            ביטול
          </Button>
          <Button variant={req?.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>
            {req?.ok || 'אישור'}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        {req?.danger && (
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600">
            <AlertTriangle className="h-5 w-5" />
          </div>
        )}
        <div className="whitespace-pre-line text-[15px] leading-relaxed text-slate-700">{req?.text}</div>
      </div>
    </Modal>
  );
}

// tiny global toast
export function toast(text: string, kind: 'ok' | 'error' = 'ok') {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { text, kind } }));
}
