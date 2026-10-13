'use client';
// Shared pieces of the subscription / payment screens: labels, proof viewer, reject dialog,
// station logo editor and a toast host for pages outside the app shell (/pay).
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, ImagePlus, Maximize2, Trash2, Upload } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { prepareLogo } from '@/lib/image';
import type { Tone } from '@/lib/format';
import { Button, Field, Modal, Textarea, ask, cx, toast } from './ui';
import { StationLogo } from './Brand';

export const METHOD_LABEL: Record<string, string> = { bit: 'ביט', paybox: 'פייבוקס', other: 'אחר' };
export const REQ_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'ממתין לאישור', tone: 'amber' },
  approved: { label: 'אושר', tone: 'green' },
  rejected: { label: 'נדחה', tone: 'red' },
  cancelled: { label: 'בוטל', tone: 'slate' },
};

export const money = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('he-IL', { maximumFractionDigits: 2 })} ₪`;
/** a date-only value (YYYY-MM-DD) or a timestamp → dd.mm.yyyy */
export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d.length <= 10 ? d + 'T12:00:00' : d).toLocaleDateString('he-IL') : '—';
export const fmtDateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const monthsLabel = (m: number) => (m === 1 ? 'חודש' : m === 12 ? 'שנה' : `${m} חודשים`);

const isoDay = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
/** what the subscription end becomes after paying for N months (the same rule as the database) */
export function endAfter(subEnd: string | null | undefined, months: number) {
  const today = isoDay(new Date());
  const base = subEnd && subEnd > today ? subEnd : today;
  const x = new Date(base + 'T12:00:00');
  const day = x.getDate();
  x.setMonth(x.getMonth() + months);
  if (x.getDate() < day) x.setDate(0); // 31.1 + 1 month → end of February, like Postgres
  return isoDay(x);
}

/** Subscription state for a station (days left are counted on the server in Israel time when given). */
export function subState(status: string | null | undefined, subEnd: string | null | undefined, daysLeft?: number | null): { label: string; tone: Tone; key: 'active' | 'soon' | 'ended' | 'suspended' | 'open' } {
  if (status === 'suspended') return { label: 'מושהה', tone: 'slate', key: 'suspended' };
  const d = daysLeft ?? (subEnd ? Math.ceil((new Date(subEnd + 'T23:59:59').getTime() - Date.now()) / 86400000) : null);
  if (d === null) return { label: 'פעיל ללא הגבלה', tone: 'green', key: 'open' };
  if (d < 0) return { label: 'הסתיים', tone: 'red', key: 'ended' };
  if (d === 0) return { label: 'מסתיים היום', tone: 'amber', key: 'soon' };
  if (d <= 7) return { label: `מסתיים בעוד ${d} ימים`, tone: 'amber', key: 'soon' };
  return { label: 'פעיל', tone: 'green', key: 'active' };
}

async function toBlobUrl(data: string) {
  const r = await fetch(data);
  return URL.createObjectURL(await r.blob());
}

/** A payment proof: an image (tap to enlarge) or a PDF (opens in a new tab). */
export function ProofView({ data, className }: { data: string | null | undefined; className?: string }) {
  const [big, setBig] = useState(false);
  if (!data) {
    return <div className={cx('rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-500', className)}>לא צורפה אסמכתה</div>;
  }
  if (data.startsWith('data:application/pdf')) {
    return (
      <div className={cx('flex items-center gap-3 rounded-xl border border-slate-200 p-3', className)}>
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-rose-50 text-rose-600">
          <FileText className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium text-slate-800">אסמכתה בקובץ PDF</div>
          <div className="text-xs text-slate-500">נפתח בלשונית חדשה</div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              window.open(await toBlobUrl(data), '_blank', 'noopener');
            } catch {
              toast('לא הצלחנו לפתוח את הקובץ', 'error');
            }
          }}
        >
          פתיחת הקובץ
        </Button>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setBig(true)}
        className={cx('group relative block w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-50', className)}
        aria-label="הגדלת האסמכתה"
      >
        <img src={data} alt="אסמכתת התשלום" className="mx-auto max-h-80 w-auto object-contain" />
        <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-lg bg-[#151920]/80 px-2 py-1 text-xs font-medium text-white">
          <Maximize2 className="h-3.5 w-3.5" />
          הגדלה
        </span>
      </button>
      {big && (
        <div className="fixed inset-0 z-[70] flex animate-rise items-center justify-center bg-[rgb(15_18_23/0.85)] p-3" onClick={() => setBig(false)} role="dialog" aria-label="האסמכתה בגודל מלא">
          <img src={data} alt="אסמכתת התשלום" className="max-h-full max-w-full rounded-lg object-contain" />
          <button type="button" onClick={() => setBig(false)} className="absolute right-4 top-4 rounded-xl bg-white/15 px-3 py-2 text-sm font-medium text-white hover:bg-white/25">
            סגירה
          </button>
        </div>
      )}
    </>
  );
}

/** Asks for a reject reason (required) and calls onSubmit with it. */
export function RejectDialog({ open, title, onClose, onSubmit }: { open: boolean; title?: string; onClose: () => void; onSubmit: (reason: string) => Promise<boolean> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  async function go() {
    if (!reason.trim()) return toast('כתבו סיבה לדחייה – התחנה תראה אותה', 'error');
    setBusy(true);
    const ok = await onSubmit(reason.trim());
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title || 'דחיית התשלום'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button variant="danger" onClick={go} loading={busy}>
            דחיית התשלום
          </Button>
        </>
      }
    >
      <Field label="סיבת הדחייה" hint="התחנה תקבל את הסיבה בוואטסאפ ובאפליקציה, ותוכל להגיש אסמכתה מחדש.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="לדוגמה: הכסף לא התקבל בביט, הסכום לא תואם" autoFocus className="min-h-0" />
      </Field>
    </Modal>
  );
}

/** Station logo with upload / replace / remove. */
export function LogoEditor({
  stationId,
  logo,
  name,
  onChanged,
  compact,
}: {
  stationId: string;
  logo: string | null | undefined;
  name?: string;
  onChanged: (logo: string | null) => void;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'up' | 'rm' | null>(null);

  async function save(data: string | null) {
    const { error } = await sb().rpc('station_set_logo', { p_station: stationId, p_data: data });
    if (error) {
      toast(error.message || 'שמירת הלוגו נכשלה. נסו שוב.', 'error');
      return false;
    }
    onChanged(data);
    return true;
  }
  async function pick(f: File | undefined) {
    if (!f) return;
    setBusy('up');
    try {
      const data = await prepareLogo(f);
      if (await save(data)) toast('הלוגו נשמר');
    } catch (e: any) {
      toast(e?.message || 'לא הצלחנו לעבד את התמונה', 'error');
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  }
  async function remove() {
    if (!(await ask({ title: 'להסיר את הלוגו?', text: 'במקום הלוגו יוצג הסמל של BotiX. אפשר להעלות לוגו חדש בכל רגע.', ok: 'הסרת הלוגו', danger: true }))) return;
    setBusy('rm');
    if (await save(null)) toast('הלוגו הוסר');
    setBusy(null);
  }

  return (
    <div className={cx('flex items-center gap-3', compact ? '' : 'gap-4')}>
      <StationLogo logo={logo} name={name} size={compact ? 44 : 64} className="rounded-2xl" />
      <div className="flex min-w-0 flex-wrap gap-1.5">
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => pick(e.target.files?.[0])} aria-label="בחירת קובץ לוגו" />
        <Button size="sm" variant="secondary" loading={busy === 'up'} disabled={!!busy} onClick={() => input.current?.click()}>
          {logo ? <ImagePlus className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
          {logo ? 'החלפה' : 'העלאת לוגו'}
        </Button>
        {logo && (
          <Button size="sm" variant="ghost" loading={busy === 'rm'} disabled={!!busy} onClick={remove} aria-label="הסרת הלוגו">
            <Trash2 className="h-4 w-4" />
            {!compact && 'הסרה'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Toasts for pages that are outside the app shell. */
export function ToastHost() {
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
