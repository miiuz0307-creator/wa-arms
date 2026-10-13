'use client';
// The station manager's subscription: status, paying / renewing with a proof (approved manually by the
// system owner), payment history and the station logo.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  FileText,
  Hourglass,
  Image as ImageIcon,
  Info,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Upload,
  Wallet,
  XCircle,
} from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { prepareProof, type Proof } from '@/lib/image';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Section, Skeleton, Textarea, ask, cx, toast } from '@/components/ui';
import { refreshBrand } from '@/components/Brand';
import { LogoEditor, METHOD_LABEL, ProofView, REQ_STATUS, endAfter, fmtDate, fmtDateTime, money, monthsLabel, subState } from '@/components/PayKit';

type Payment = { id: number; amount: number; months: number; paid_at: string; method: string | null };
type Request = {
  id: number;
  amount: number;
  months: number;
  method: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reject_reason: string | null;
  created_at: string;
  decided_at: string | null;
};
type Billing = {
  station_id: string;
  name: string;
  plan: string | null;
  price: number | null;
  sub_end: string | null;
  status: string;
  days_left: number | null;
  bit_link: string | null;
  paybox_link: string | null;
  payment_note: string | null;
  payments: Payment[];
  requests: Request[];
};

const PLAN_LABEL: Record<string, string> = { basic: 'בסיסי', pro: 'מקצועי', premium: 'פרימיום', trial: 'ניסיון' };
const planName = (p: string | null) => (p ? PLAN_LABEL[p] || p : 'מנוי חודשי');

export default function SubscriptionPage() {
  const { loading, isStation, station, can } = useAuth();
  if (loading) return <PageSkeleton />;
  const inStation = isStation || !!station?.acting;
  if (!inStation || !can('admin')) {
    return <div className="py-20 text-center text-slate-500">המסך הזה זמין למנהל התחנה.</div>;
  }
  if (station?.is_home) {
    return (
      <Card>
        <Empty icon={<ShieldCheck className="h-7 w-7" />} title="לחשבון הראשי אין מנוי" text="המנוי והתשלומים מנוהלים לכל תחנה בנפרד." />
      </Card>
    );
  }
  return <Subscription />;
}

function PageSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="טוען">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-48 md:col-span-2" />
        <Skeleton className="h-48" />
      </div>
      <Skeleton className="h-56" />
    </div>
  );
}

function Subscription() {
  const [b, setB] = useState<Billing | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('station_billing');
    if (error) {
      setErr(error.message || 'שגיאה בטעינה');
      setB((x) => (x === undefined ? null : x));
      return;
    }
    setErr(null);
    setB((data as Billing) ?? null);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (b === undefined) return <PageSkeleton />;
  if (err && !b) {
    return (
      <>
        <PageHeader title="המנוי והתשלומים שלי" />
        <Card>
          <Empty
            icon={<AlertTriangle className="h-7 w-7" />}
            title="לא הצלחנו לטעון את פרטי המנוי"
            text={`${err}. בדקו את החיבור לאינטרנט ונסו שוב.`}
            action={
              <Button variant="secondary" onClick={load}>
                <RefreshCw className="h-4 w-4" />
                ניסיון נוסף
              </Button>
            }
          />
        </Card>
      </>
    );
  }
  if (!b) {
    return (
      <>
        <PageHeader title="המנוי והתשלומים שלי" />
        <Card>
          <Empty icon={<ShieldCheck className="h-7 w-7" />} title="אין מנוי לחשבון הזה" text="המנוי והתשלומים מנוהלים לכל תחנה בנפרד." />
        </Card>
      </>
    );
  }

  const st = subState(b.status, b.sub_end, b.days_left);
  const pending = b.requests.find((r) => r.status === 'pending') || null;
  const last = b.requests[0];
  const rejected = !pending && last?.status === 'rejected' ? last : null;

  async function cancel() {
    if (!pending) return;
    const ok = await ask({
      title: 'לבטל את בקשת התשלום?',
      text: 'הבקשה תוסר ומנהל המערכת לא יאשר אותה. אם כבר שילמתם, אפשר להגיש אסמכתה חדשה בכל רגע.',
      ok: 'ביטול הבקשה',
      danger: true,
    });
    if (!ok) return;
    setCancelling(true);
    const { error } = await sb().rpc('station_payment_cancel', { p_id: pending.id });
    setCancelling(false);
    if (error) return toast(error.message || 'ביטול הבקשה נכשל', 'error');
    toast('הבקשה בוטלה');
    load();
  }

  return (
    <>
      <PageHeader
        title="המנוי והתשלומים שלי"
        subtitle="מצב המנוי של התחנה, תשלום וחידוש, והיסטוריית התשלומים."
        actions={
          !pending && (
            <Button onClick={() => setPayOpen(true)}>
              <CreditCard className="h-4 w-4" />
              {st.key === 'ended' ? 'חידוש המנוי' : 'תשלום / חידוש'}
            </Button>
          )
        }
      />

      {st.key === 'ended' && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl bg-rose-50 px-4 py-3.5 text-sm text-rose-900 ring-1 ring-rose-200" role="alert">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="font-semibold">המנוי הסתיים ב-{fmtDate(b.sub_end)}</div>
            <div className="mt-0.5 leading-relaxed">הבוט הפסיק לטפל בהודעות של התחנה. הזרועות נשארות מחוברות – אחרי חידוש הכול חוזר לעבוד בלי סריקת QR.</div>
          </div>
        </div>
      )}
      {st.key === 'suspended' && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl bg-slate-100 px-4 py-3.5 text-sm text-slate-800 ring-1 ring-slate-200">
          <Info className="mt-0.5 h-5 w-5 shrink-0" />
          <div>התחנה מושהית על ידי מנהל המערכת. לפרטים פנו אליו או לתמיכה הטכנית.</div>
        </div>
      )}

      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <StatusCard b={b} st={st} pending={!!pending} onPay={() => setPayOpen(true)} />
        <Section title="לוגו התחנה" icon={<ImageIcon className="h-4 w-4" />} bodyClass="p-5">
          <LogoCard b={b} />
        </Section>
      </div>

      {pending && (
        <Card className="mb-4 border-amber-200">
          <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600">
              <Hourglass className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">בקשת תשלום #{pending.id}</span>
                <Badge tone="amber" dot>
                  ממתין לאישור
                </Badge>
              </div>
              <div className="mt-1 text-sm text-slate-600">
                <span className="tabular-nums">{money(pending.amount)}</span> · {monthsLabel(pending.months)} · {METHOD_LABEL[pending.method] || pending.method} · נשלחה{' '}
                {fmtDateTime(pending.created_at)}
              </div>
              <div className="mt-1.5 text-xs leading-relaxed text-slate-500">מנהל המערכת יבדוק שהכסף התקבל ויאשר. תקבלו הודעה בוואטסאפ ובאפליקציה.</div>
            </div>
            <Button variant="secondary" onClick={cancel} loading={cancelling}>
              ביטול הבקשה
            </Button>
          </div>
        </Card>
      )}

      {rejected && (
        <div className="mb-4 flex flex-col gap-3 rounded-2xl bg-rose-50 px-4 py-3.5 text-sm text-rose-900 ring-1 ring-rose-200 md:flex-row md:items-center">
          <XCircle className="h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">בקשת התשלום #{rejected.id} לא אושרה</div>
            {rejected.reject_reason && <div className="mt-0.5">הסיבה: {rejected.reject_reason}</div>}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setPayOpen(true)}>
            <Upload className="h-4 w-4" />
            הגשת אסמכתה מחדש
          </Button>
        </div>
      )}

      {b.payment_note && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl bg-sky-50 px-4 py-3.5 text-sm text-sky-900 ring-1 ring-sky-200">
          <Info className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="font-semibold">הודעה ממנהל המערכת</div>
            <div className="mt-0.5 whitespace-pre-line leading-relaxed">{b.payment_note}</div>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Payments list={b.payments} />
        <Requests list={b.requests} />
      </div>

      <PayFlow open={payOpen} b={b} onClose={() => setPayOpen(false)} onDone={load} />
    </>
  );
}

function StatusCard({ b, st, pending, onPay }: { b: Billing; st: ReturnType<typeof subState>; pending: boolean; onPay: () => void }) {
  const days = b.days_left;
  return (
    <Card className="md:col-span-2">
      <div className="flex flex-col gap-5 p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-slate-500">המסלול</div>
            <div className="mt-1 text-xl font-semibold text-slate-900">{planName(b.plan)}</div>
          </div>
          <Badge tone={st.tone} dot>
            {st.label}
          </Badge>
        </div>
        <dl className="grid grid-cols-3 gap-3 border-t border-slate-100 pt-4">
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">מחיר חודשי</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{b.price != null ? money(b.price) : '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">בתוקף עד</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{b.sub_end ? fmtDate(b.sub_end) : 'ללא הגבלה'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-slate-500">{days !== null && days < 0 ? 'הסתיים לפני' : 'נשארו'}</dt>
            <dd className={cx('mt-1 text-lg font-semibold tabular-nums', st.key === 'ended' ? 'text-rose-700' : st.key === 'soon' ? 'text-amber-700' : 'text-slate-900')}>
              {days === null ? '—' : `${Math.abs(days)} ימים`}
            </dd>
          </div>
        </dl>
        {!pending && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
              {st.key === 'ended' ? 'חידוש מחזיר את הבוט לעבודה מיד אחרי האישור.' : 'אפשר לשלם מראש – החודשים נוספים לסוף המנוי הנוכחי.'}
            </div>
            <Button size="sm" onClick={onPay}>
              <CreditCard className="h-4 w-4" />
              תשלום / חידוש
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function LogoCard({ b }: { b: Billing }) {
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    sb()
      .rpc('station_brand')
      .then(({ data }) => {
        const row = (Array.isArray(data) ? data[0] : data) as { logo_data: string | null } | null;
        setLogo(row?.logo_data ?? null);
      });
  }, []);
  if (logo === undefined) return <Skeleton className="h-16" />;
  return (
    <div className="space-y-3">
      <LogoEditor
        stationId={b.station_id}
        logo={logo}
        name={b.name}
        onChanged={(v) => {
          setLogo(v);
          refreshBrand();
        }}
      />
      <p className="text-xs leading-relaxed text-slate-500">מוצג בראש האפליקציה במקום הסמל של BotiX. תמונה מרובעת נראית הכי טוב (PNG עם רקע שקוף).</p>
    </div>
  );
}

function Payments({ list }: { list: Payment[] }) {
  return (
    <Section title="תשלומים שהתקבלו" icon={<Receipt className="h-4 w-4" />}>
      {list.length === 0 ? (
        <Empty icon={<Wallet className="h-7 w-7" />} title="עדיין אין תשלומים" text="תשלום שיאושר יופיע כאן, עם התאריך והחודשים שנוספו למנוי." />
      ) : (
        <>
          <table className="hidden w-full text-sm md:table">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-5 py-2 text-right font-medium">תאריך</th>
                <th className="px-3 py-2 text-right font-medium">סכום</th>
                <th className="px-3 py-2 text-right font-medium">חודשים</th>
                <th className="px-3 py-2 text-right font-medium">אמצעי</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap px-5 py-3 tabular-nums">{fmtDate(p.paid_at)}</td>
                  <td className="px-3 py-3 font-medium tabular-nums">{money(p.amount)}</td>
                  <td className="px-3 py-3 tabular-nums">{p.months || '—'}</td>
                  <td className="px-3 py-3 text-slate-600">{p.method || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="divide-y divide-slate-100 md:hidden">
            {list.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <div className="font-medium tabular-nums text-slate-900">{money(p.amount)}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {p.months ? monthsLabel(p.months) : 'בלי הארכה'} · {p.method || '—'}
                  </div>
                </div>
                <div className="text-sm tabular-nums text-slate-600">{fmtDate(p.paid_at)}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function Requests({ list }: { list: Request[] }) {
  return (
    <Section title="בקשות תשלום" icon={<Clock className="h-4 w-4" />}>
      {list.length === 0 ? (
        <Empty icon={<FileText className="h-7 w-7" />} title="עדיין לא נשלחו בקשות" text="כששולחים אסמכתה על תשלום, הבקשה והסטטוס שלה מופיעים כאן." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.map((r) => {
            const s = REQ_STATUS[r.status] || REQ_STATUS.cancelled;
            return (
              <li key={r.id} className="px-5 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium tabular-nums text-slate-900">
                      {money(r.amount)} <span className="font-normal text-slate-500">· {monthsLabel(r.months)} · {METHOD_LABEL[r.method] || r.method}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      #{r.id} · נשלחה {fmtDateTime(r.created_at)}
                      {r.decided_at && r.status !== 'pending' ? ` · טופלה ${fmtDateTime(r.decided_at)}` : ''}
                    </div>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                {r.status === 'rejected' && r.reject_reason && <div className="mt-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">הסיבה: {r.reject_reason}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ---------- pay / renew ----------
const MONTH_OPTIONS = [1, 3, 6, 12];

function PayFlow({ open, b, onClose, onDone }: { open: boolean; b: Billing; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [months, setMonths] = useState(1);
  const [custom, setCustom] = useState('');
  const [method, setMethod] = useState<'bit' | 'paybox' | null>(null);
  const [proof, setProof] = useState<Proof | null>(null);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setMonths(1);
    setCustom('');
    setMethod(null);
    setProof(null);
    setNote('');
  }, [open]);

  const hasPrice = b.price != null && Number(b.price) > 0;
  const total = hasPrice ? Number(b.price) * months : Number(custom || 0);
  const link = method === 'bit' ? b.bit_link : method === 'paybox' ? b.paybox_link : null;

  async function pickFile(f: File | undefined) {
    if (!f) return;
    setReading(true);
    try {
      setProof(await prepareProof(f));
    } catch (e: any) {
      toast(e?.message || 'לא הצלחנו לקרוא את הקובץ', 'error');
    } finally {
      setReading(false);
      if (file.current) file.current.value = '';
    }
  }

  function next() {
    if (step === 1 && !(total > 0)) return toast('כתבו את הסכום ששילמתם', 'error');
    if (step === 2 && !method) return toast('בחרו איך שילמתם', 'error');
    setStep(step + 1);
  }

  async function submit() {
    if (!method) return setStep(2);
    if (!proof) return toast('צרפו צילום מסך או קובץ של אישור התשלום', 'error');
    setBusy(true);
    const { error } = await sb().rpc('station_payment_submit', {
      p_amount: total,
      p_months: months,
      p_method: method,
      p_proof: proof.data,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) return toast(error.message || 'שליחת האסמכתה נכשלה. נסו שוב.', 'error');
    toast('האסמכתה נשלחה');
    onClose();
    onDone();
  }

  const STEPS = ['תקופה', 'תשלום', 'אסמכתה'];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="תשלום וחידוש המנוי"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {step > 1 ? (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              חזרה
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              ביטול
            </Button>
          )}
          {step < 3 ? (
            <Button onClick={next}>המשך</Button>
          ) : (
            <Button onClick={submit} loading={busy} disabled={!proof || reading}>
              שליחת אסמכתה
            </Button>
          )}
        </div>
      }
    >
      <ol className="mb-5 grid grid-cols-3 gap-2" aria-label="שלבים">
        {STEPS.map((s, i) => {
          const n = i + 1;
          return (
            <li key={s} className="min-w-0" aria-current={n === step ? 'step' : undefined}>
              <div className={cx('h-1 rounded-full', n <= step ? 'bg-indigo-600' : 'bg-slate-200')} />
              <div className={cx('mt-1.5 truncate text-xs font-medium', n === step ? 'text-slate-900' : 'text-slate-400')}>
                {n}. {s}
              </div>
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className="space-y-4">
          <div className="text-sm font-medium text-slate-700">על כמה חודשים משלמים?</div>
          <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="מספר חודשים">
            {MONTH_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={months === m}
                onClick={() => setMonths(m)}
                className={cx(
                  'min-h-[76px] rounded-2xl border p-4 text-right transition',
                  months === m ? 'border-indigo-500 bg-indigo-50 ring-4 ring-indigo-500/15' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
                )}
              >
                <div className="font-semibold text-slate-900">{monthsLabel(m)}</div>
                {hasPrice && <div className="mt-0.5 text-sm tabular-nums text-slate-600">{money(Number(b.price) * m)}</div>}
                <div className="mt-0.5 text-xs text-slate-500">עד {fmtDate(endAfter(b.sub_end, m))}</div>
              </button>
            ))}
          </div>
          {!hasPrice && (
            <Field label="הסכום ששילמתם (₪)" hint="לא הוגדר מחיר חודשי לתחנה – כתבו את הסכום ששולם.">
              <Input type="number" inputMode="decimal" min={1} value={custom} onChange={(e) => setCustom(e.target.value)} />
            </Field>
          )}
          {hasPrice && (
            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3">
              <span className="text-sm text-slate-600">סה״כ לתשלום</span>
              <span className="text-lg font-semibold tabular-nums text-slate-900">{money(total)}</span>
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="text-sm font-medium text-slate-700">
            איך משלמים? <span className="font-normal text-slate-500">({money(total)})</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="אמצעי תשלום">
            {(['bit', 'paybox'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                onClick={() => setMethod(m)}
                className={cx(
                  'flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-2xl border p-4 transition',
                  method === m ? 'border-indigo-500 bg-indigo-50 ring-4 ring-indigo-500/15' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
                )}
              >
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-700">
                  <Wallet className="h-5 w-5" />
                </span>
                <span className="text-base font-semibold text-slate-900">{METHOD_LABEL[m]}</span>
              </button>
            ))}
          </div>
          {method &&
            (link ? (
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="brand-gradient flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-medium text-white shadow-sm"
              >
                <ExternalLink className="h-4 w-4" />
                פתיחת {METHOD_LABEL[method]} לתשלום
              </a>
            ) : (
              <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
                קישור התשלום ב{METHOD_LABEL[method]} עוד לא הוגדר. שלמו לפי ההנחיות של מנהל המערכת והמשיכו לצרף אסמכתה.
              </div>
            ))}
          <p className="text-xs leading-relaxed text-slate-500">שלמו {money(total)}, צלמו מסך של אישור התשלום, וחזרו לכאן כדי לצרף אותו בשלב הבא.</p>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <input ref={file} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} aria-label="בחירת קובץ אסמכתה" />
          {proof ? (
            <div className="space-y-2">
              <ProofView data={proof.data} />
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                <span className="truncate">
                  {proof.name} · {Math.max(1, Math.round(proof.size / 1024))}KB
                </span>
                <Button size="sm" variant="ghost" onClick={() => file.current?.click()} loading={reading}>
                  החלפת הקובץ
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => file.current?.click()}
              disabled={reading}
              className="flex min-h-[132px] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-5 text-center transition hover:border-indigo-400 hover:bg-indigo-50/50 disabled:opacity-60"
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
                <Upload className="h-5 w-5" />
              </span>
              <span className="font-medium text-slate-800">{reading ? 'מעבד את הקובץ…' : 'צירוף צילום מסך או PDF'}</span>
              <span className="text-xs text-slate-500">אישור התשלום מביט / פייבוקס</span>
            </button>
          )}
          <Field label="הערה (לא חובה)">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="לדוגמה: שולם מהטלפון של משה" className="min-h-0" />
          </Field>
          <div className="flex items-start gap-2 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <span>התשלום יאושר אחרי בדיקה ידנית של קבלת הכסף. לא מאשרים אוטומטית לפי צילום מסך.</span>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm">
            <span className="text-slate-600">
              {monthsLabel(months)} · {method ? METHOD_LABEL[method] : ''}
            </span>
            <span className="font-semibold tabular-nums text-slate-900">{money(total)}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
