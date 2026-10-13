'use client';
// Payment approval page, opened by the system owner from the WhatsApp message: /pay?r=<token>.
// Outside the app shell; requires the owner's own login.
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowRight, CalendarClock, Check, CheckCircle2, LogIn, ShieldAlert, ShieldCheck, X, XCircle } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, ConfirmHost, Skeleton, ask, toast } from '@/components/ui';
import { BrandMark, BrandWord } from '@/components/Brand';
import { METHOD_LABEL, ProofView, REQ_STATUS, RejectDialog, ToastHost, endAfter, fmtDate, fmtDateTime, money, monthsLabel } from '@/components/PayKit';

type Req = {
  id: number;
  station_id: string;
  station_name: string;
  station_phone: string | null;
  price: number | null;
  sub_end: string | null;
  station_status: string;
  amount: number;
  months: number;
  method: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  reject_reason: string | null;
  proof_data: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by_name: string | null;
  payment_id: number | null;
  token: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PayPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)]">
      <ToastHost />
      <ConfirmHost />
      <header className="border-b border-slate-200/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <BrandMark size={34} />
            <div className="leading-tight">
              <BrandWord className="text-slate-900" />
              <div className="text-xs text-slate-500">אישור תשלום</div>
            </div>
          </div>
          <Link href="/billing" className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
            <ArrowRight className="h-4 w-4" />
            לכל התשלומים
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6">
        <Suspense fallback={<LoadingCard />}>
          <PayGate />
        </Suspense>
      </main>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="space-y-4" role="status" aria-label="טוען">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

function Notice({ icon, tone, title, text, action }: { icon: React.ReactNode; tone: 'amber' | 'rose' | 'slate'; title: string; text?: React.ReactNode; action?: React.ReactNode }) {
  const t = { amber: 'bg-amber-50 text-amber-600', rose: 'bg-rose-50 text-rose-600', slate: 'bg-slate-100 text-slate-500' }[tone];
  return (
    <Card className="px-6 py-12 text-center">
      <div className={`mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl ${t}`}>{icon}</div>
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      {text && <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-slate-500">{text}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </Card>
  );
}

function PayGate() {
  const params = useSearchParams();
  const r = (params.get('r') || '').trim();
  const { loading, session, isSuper, isStation } = useAuth();

  if (!UUID.test(r)) {
    return <Notice icon={<AlertTriangle className="h-7 w-7" />} tone="amber" title="הקישור לא תקין" text="פתחו שוב את הקישור המלא מהודעת הוואטסאפ, או עברו לרשימת התשלומים." />;
  }
  if (loading) return <LoadingCard />;
  if (!session || isStation) {
    const next = `/pay?r=${r}`;
    return (
      <Notice
        icon={<LogIn className="h-7 w-7" />}
        tone="slate"
        title="נדרשת כניסה של מנהל המערכת"
        text={
          isStation
            ? 'המכשיר מחובר כרגע עם קוד של תחנה. אישור תשלומים זמין רק בכניסה של מנהל המערכת.'
            : 'כדי לאשר או לדחות תשלום צריך להיכנס עם החשבון של מנהל המערכת. אם אחרי הכניסה לא חזרתם לכאן, פתחו שוב את הקישור מהוואטסאפ.'
        }
        action={
          !isStation && (
            <Link href={`/login?next=${encodeURIComponent(next)}`} className="brand-gradient inline-flex h-11 items-center gap-2 rounded-xl px-5 text-sm font-medium text-white shadow-sm">
              <LogIn className="h-4 w-4" />
              כניסה למנהל המערכת
            </Link>
          )
        }
      />
    );
  }
  if (!isSuper) {
    return <Notice icon={<ShieldAlert className="h-7 w-7" />} tone="rose" title="אין הרשאה" text="רק מנהל המערכת יכול לאשר או לדחות תשלומים." />;
  }
  return <Approval token={r} />;
}

function Approval({ token }: { token: string }) {
  const [req, setReq] = useState<Req | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [result, setResult] = useState<{ status: string; sub_end: string | null } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('owner_payment_request_get', { p_token: token });
    if (error) {
      setErr(error.message || 'שגיאה בטעינה');
      setReq(null);
      return;
    }
    setErr(null);
    setReq((data as Req) ?? null);
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  if (req === undefined) return <LoadingCard />;
  if (err) {
    return (
      <Notice
        icon={<AlertTriangle className="h-7 w-7" />}
        tone="rose"
        title="לא הצלחנו לטעון את הבקשה"
        text={`${err}. בדקו את החיבור ונסו שוב.`}
        action={
          <Button variant="secondary" onClick={load}>
            ניסיון נוסף
          </Button>
        }
      />
    );
  }
  if (!req) {
    return <Notice icon={<XCircle className="h-7 w-7" />} tone="slate" title="הבקשה לא נמצאה" text="ייתכן שהתחנה נמחקה או שהקישור שגוי. אפשר לבדוק ברשימת התשלומים." />;
  }

  const r = req;
  const pending = r.status === 'pending';
  const s = REQ_STATUS[r.status] || REQ_STATUS.cancelled;
  const after = endAfter(r.sub_end, r.months);
  const priceMatch = r.price != null && Number(r.price) > 0 ? Number(r.price) * r.months : null;

  async function approve() {
    const ok = await ask({
      title: 'לאשר את התשלום?',
      text: `לאשר רק אחרי שבדקת שהכסף התקבל.\n${money(r.amount)} מ-${r.station_name} (${METHOD_LABEL[r.method] || r.method}).\nהמנוי יוארך ב-${monthsLabel(r.months)} – עד ${fmtDate(after)}.`,
      ok: 'אישור התשלום',
    });
    if (!ok) return;
    setBusy(true);
    const { data, error } = await sb().rpc('owner_payment_decide', { p_id: r.id, p_approve: true });
    setBusy(false);
    if (error) {
      toast(error.message || 'האישור נכשל. נסו שוב.', 'error');
      load();
      return;
    }
    setResult(data as { status: string; sub_end: string | null });
    toast('התשלום אושר');
    load();
  }
  async function reject(reason: string) {
    const { data, error } = await sb().rpc('owner_payment_decide', { p_id: r.id, p_approve: false, p_reason: reason });
    if (error) {
      toast(error.message || 'הדחייה נכשלה. נסו שוב.', 'error');
      load();
      return false;
    }
    setResult(data as { status: string; sub_end: string | null });
    toast('התשלום נדחה – התחנה קיבלה הודעה');
    load();
    return true;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-slate-500">בקשת תשלום #{r.id}</div>
          <h1 className="text-[24px] font-bold leading-tight tracking-tight text-slate-900">{r.station_name}</h1>
        </div>
        <Badge tone={s.tone} dot>
          {s.label}
        </Badge>
      </div>

      {!pending && (
        <div
          className={
            r.status === 'approved'
              ? 'flex items-start gap-3 rounded-2xl bg-emerald-50 px-4 py-3.5 text-sm text-emerald-900 ring-1 ring-emerald-200'
              : r.status === 'rejected'
                ? 'flex items-start gap-3 rounded-2xl bg-rose-50 px-4 py-3.5 text-sm text-rose-900 ring-1 ring-rose-200'
                : 'flex items-start gap-3 rounded-2xl bg-slate-100 px-4 py-3.5 text-sm text-slate-800 ring-1 ring-slate-200'
          }
          role="status"
        >
          {r.status === 'approved' ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" /> : r.status === 'rejected' ? <XCircle className="mt-0.5 h-5 w-5 shrink-0" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />}
          <div className="min-w-0">
            <div className="font-semibold">
              {r.status === 'approved' ? 'התשלום אושר' : r.status === 'rejected' ? 'התשלום נדחה' : 'התחנה ביטלה את הבקשה'}
              {result ? '' : ' – הבקשה כבר טופלה'}
            </div>
            <div className="mt-0.5 leading-relaxed">
              {r.decided_by_name ? `על ידי ${r.decided_by_name} · ` : ''}
              {fmtDateTime(r.decided_at)}
              {r.status === 'approved' && ` · המנוי בתוקף עד ${fmtDate(result?.sub_end || r.sub_end)}`}
            </div>
            {r.status === 'rejected' && r.reject_reason && <div className="mt-0.5">הסיבה: {r.reject_reason}</div>}
            {!result && <div className="mt-1 text-xs opacity-80">אין צורך לעשות שום דבר נוסף. כל בקשה מאושרת או נדחית פעם אחת בלבד.</div>}
          </div>
        </div>
      )}

      <Card>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 p-5 md:grid-cols-3">
          <Item label="סכום" value={<span className="text-xl font-semibold">{money(r.amount)}</span>} />
          <Item label="תקופה" value={monthsLabel(r.months)} />
          <Item label="אמצעי תשלום" value={METHOD_LABEL[r.method] || r.method} />
          <Item label="נשלחה" value={fmtDateTime(r.created_at)} />
          <Item label="מחיר חודשי" value={r.price != null ? money(r.price) : '—'} />
          <Item label="טלפון התחנה" value={r.station_phone ? <span dir="ltr">{r.station_phone}</span> : '—'} />
        </dl>
        {priceMatch !== null && Math.abs(priceMatch - Number(r.amount)) > 0.009 && (
          <div className="mx-5 mb-4 flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            הסכום שונה מהמחיר הקבוע ({money(priceMatch)} ל{monthsLabel(r.months)}).
          </div>
        )}
        {r.note && (
          <div className="mx-5 mb-4 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700">
            <span className="text-slate-500">הערת התחנה: </span>
            {r.note}
          </div>
        )}
        <div className="flex items-center gap-3 border-t border-slate-100 px-5 py-3.5 text-sm">
          <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="text-slate-600">
            המנוי עכשיו: <b className="tabular-nums text-slate-900">{r.sub_end ? fmtDate(r.sub_end) : 'ללא הגבלה'}</b>
            {pending && (
              <>
                {' '}
                · אחרי האישור: <b className="tabular-nums text-slate-900">{fmtDate(after)}</b>
              </>
            )}
          </span>
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-2.5 text-sm font-medium text-slate-700">אסמכתה</div>
        <ProofView data={r.proof_data} />
      </Card>

      {pending && (
        <Card className="sticky bottom-3 p-4 shadow-[var(--shadow-pop)]">
          <p className="mb-3 text-sm leading-relaxed text-slate-600">לאשר רק אחרי שבדקת שהכסף התקבל בפועל ב{METHOD_LABEL[r.method] || 'חשבון'}. צילום מסך לבד אינו הוכחה.</p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="danger" size="lg" onClick={() => setRejectOpen(true)} disabled={busy}>
              <X className="h-4 w-4" />
              דחייה
            </Button>
            <Button variant="success" size="lg" onClick={approve} loading={busy}>
              <Check className="h-4 w-4" />
              אישור התשלום
            </Button>
          </div>
        </Card>
      )}

      <RejectDialog open={rejectOpen} onClose={() => setRejectOpen(false)} onSubmit={reject} title={`דחיית התשלום של ${r.station_name}`} />
    </div>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-1 truncate tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}
