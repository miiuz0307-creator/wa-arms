'use client';
// Payments: what each station pays, payment requests waiting for approval, what was received, who is behind.
// Owner only. Recording / approving a payment for N months extends the station's subscription by N months.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
  Check,
  ExternalLink,
  Eye,
  Inbox,
  Link2,
  Pencil,
  Phone,
  Plus,
  Receipt,
  Settings2,
  Smartphone,
  Wallet,
  X,
} from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import type { Tone } from '@/lib/format';
import { Badge, Button, Empty, Field, Input, Modal, PageHeader, Section, Segmented, Select, Skeleton, Spinner, Stat, Textarea, ask, cx, toast } from '@/components/ui';
import { METHOD_LABEL, ProofView, REQ_STATUS, RejectDialog, endAfter, fmtDate, fmtDateTime, money, monthsLabel, subState } from '@/components/PayKit';

type Bill = {
  station_id: string;
  station_name: string;
  status: string;
  price: number | null;
  sub_end: string | null;
  last_paid_at: string | null;
  last_amount: number | null;
  paid_total: number;
  paid_this_month: number;
  months_overdue: number;
  owed: number;
  plan?: string | null;
};
type ArmReq = {
  id: number;
  station_id: string;
  station_name: string;
  count: number;
  note: string | null;
  status: 'pending' | 'approved' | 'declined';
  price_before: number | null;
  price_after: number | null;
  max_arms: number | null;
  arms_count: number;
  created_at: string;
};
type PayReq = {
  id: number;
  station_id: string;
  station_name: string;
  amount: number;
  months: number;
  method: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  reject_reason: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by_name: string | null;
  has_proof: boolean;
  token: string;
};
type Settings = { payment_note: string | null; extra_arm_price: number | null; reminder_days: number | null };
type PaySettings = {
  bit_link: string | null;
  paybox_link: string | null;
  approvals_phone: string | null;
  support_phone: string | null;
  app_url: string | null;
  payment_note: string | null;
  reminder_days: number | null;
};
type Pay = { id: number; station_id: string; station_name: string; amount: number; months: number; paid_at: string; method: string | null; note: string | null };

const daysLeft = (d: string | null) => (d ? Math.ceil((new Date(d + 'T23:59:59').getTime() - Date.now()) / 86400000) : null);
const METHODS = ['ביט', 'פייבוקס', 'העברה בנקאית', 'מזומן', 'אשראי', 'צ׳ק'];
const PLAN_LABEL: Record<string, string> = { basic: 'בסיסי', pro: 'מקצועי', premium: 'פרימיום', trial: 'ניסיון' };

export default function BillingPage() {
  const { isSuper, loading, station } = useAuth();
  if (loading) return <Spinner />;
  if (!isSuper || station?.acting) return <div className="py-20 text-center text-slate-500">המסך הזה זמין רק למנהל הראשי (מחוץ לתחנה).</div>;
  return <Billing />;
}

function state(b: Bill): { label: string; tone: Tone } {
  if (b.status === 'suspended') return { label: 'מושהה', tone: 'slate' };
  if (b.owed > 0) return { label: `חוב ${money(b.owed)}`, tone: 'red' };
  const s = subState(b.status, b.sub_end);
  if (s.key === 'active') return { label: `פעיל עד ${fmtDate(b.sub_end)}`, tone: 'green' };
  return { label: s.label, tone: s.tone };
}

/** Decide a payment request (shared by the list and the proof window). Returns true when done. */
async function decide(r: { id: number; station_name: string; amount: number; months: number; method: string }, approve: boolean, reason?: string, subEnd?: string | null) {
  if (approve) {
    const ok = await ask({
      title: 'לאשר את התשלום?',
      text: `לאשר רק אחרי שבדקת שהכסף התקבל.\n${money(r.amount)} מ-${r.station_name} (${METHOD_LABEL[r.method] || r.method}), ${monthsLabel(r.months)}.${
        subEnd !== undefined ? `\nהמנוי יוארך עד ${fmtDate(endAfter(subEnd, r.months))}.` : ''
      }`,
      ok: 'אישור התשלום',
    });
    if (!ok) return false;
  }
  const { data, error } = await sb().rpc('owner_payment_decide', { p_id: r.id, p_approve: approve, p_reason: approve ? null : reason || null });
  if (error) {
    toast(error.message || 'הפעולה נכשלה. נסו שוב.', 'error');
    return error.message?.includes('כבר טופלה') ? true : false;
  }
  const d = data as { status: string; sub_end: string | null } | null;
  toast(approve ? `התשלום אושר. המנוי עד ${fmtDate(d?.sub_end)}` : 'התשלום נדחה – התחנה קיבלה הודעה');
  return true;
}

function Billing() {
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [pays, setPays] = useState<Pay[]>([]);
  const [payFor, setPayFor] = useState<Bill | null>(null);
  const [priceFor, setPriceFor] = useState<Bill | null>(null);
  const [armReqs, setArmReqs] = useState<ArmReq[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [paySettings, setPaySettings] = useState<PaySettings | null>(null);
  const [editSettings, setEditSettings] = useState(false);
  const [pending, setPending] = useState<PayReq[] | null>(null);
  const [history, setHistory] = useState<PayReq[] | null>(null);
  const [tab, setTab] = useState<'pending' | 'all'>('pending');

  const loadRequests = useCallback(async (withHistory: boolean) => {
    const [p, h] = await Promise.all([
      sb().rpc('owner_payment_requests', { p_status: 'pending' }),
      withHistory ? sb().rpc('owner_payment_requests', { p_status: null }) : Promise.resolve(null),
    ]);
    if (p.error) toast('לא הצלחנו לטעון בקשות תשלום: ' + p.error.message, 'error');
    setPending((p.data as PayReq[]) || []);
    if (h) setHistory((h.data as PayReq[]) || []);
  }, []);

  const load = useCallback(async () => {
    const [b, p, r, st, ps] = await Promise.all([
      sb().rpc('owner_billing'),
      sb().rpc('owner_payments', { p_limit: 300 }),
      sb().rpc('owner_arm_requests'),
      sb().rpc('owner_settings_get'),
      sb().rpc('owner_pay_settings_get'),
    ]);
    if (b.error) toast(b.error.message, 'error');
    setBills((b.data as Bill[]) || []);
    setPays((p.data as Pay[]) || []);
    setArmReqs((r.data as ArmReq[]) || []);
    setSettings((st.data as Settings) || null);
    setPaySettings((ps.data as PaySettings) || null);
  }, []);

  const reloadAll = useCallback(() => {
    load();
    loadRequests(tab === 'all');
  }, [load, loadRequests, tab]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadRequests(tab === 'all');
    const iv = setInterval(() => loadRequests(tab === 'all'), 60_000);
    return () => clearInterval(iv);
  }, [loadRequests, tab]);

  const subEndOf = (stationId: string) => bills?.find((b) => b.station_id === stationId)?.sub_end ?? null;

  const sum = useMemo(() => {
    const b = bills || [];
    const active = b.filter((x) => x.status === 'active');
    const month = new Date().toISOString().slice(0, 7);
    return {
      expected: active.reduce((s, x) => s + Number(x.price || 0), 0),
      received: pays.filter((p) => p.paid_at.slice(0, 7) === month).reduce((s, p) => s + Number(p.amount), 0),
      owed: b.reduce((s, x) => s + Number(x.owed || 0), 0),
      behind: b.filter((x) => x.owed > 0).length,
      soon: active.filter((x) => x.owed === 0 && (daysLeft(x.sub_end) ?? 99) <= 7).length,
    };
  }, [bills, pays]);

  return (
    <>
      <PageHeader
        title="מנויים ותשלומים"
        subtitle="בקשות תשלום שמחכות לאישור, מי שילם, מי בפיגור, וכמה נכנס החודש."
        actions={
          <Button onClick={() => setPayFor({} as Bill)} disabled={!bills?.length}>
            <Plus className="h-4 w-4" />
            רישום תשלום ידני
          </Button>
        }
      />

      <PayRequests
        tab={tab}
        setTab={setTab}
        pending={pending}
        history={history}
        subEndOf={subEndOf}
        onDone={reloadAll}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="התקבל החודש" value={money(sum.received)} icon={<Wallet className="h-5 w-5" />} tone="green" />
        <Stat label="צפוי בחודש (תחנות פעילות)" value={money(sum.expected)} icon={<Receipt className="h-5 w-5" />} tone="violet" />
        <Stat
          label="חובות פתוחים"
          value={money(sum.owed)}
          sub={sum.behind ? `${sum.behind} תחנות בפיגור` : 'אין פיגורים'}
          icon={<AlertTriangle className="h-5 w-5" />}
          tone={sum.owed ? 'red' : 'slate'}
        />
        <Stat label="לתשלום השבוע" value={sum.soon} icon={<CalendarCheck className="h-5 w-5" />} tone="amber" />
      </div>

      <ArmRequests reqs={armReqs} extra={Number(settings?.extra_arm_price || 0)} onDone={load} />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Section title="מצב לפי תחנה" icon={<Wallet className="h-4 w-4" />} className="lg:col-span-2">
          {!bills ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : bills.length === 0 ? (
            <Empty icon={<Wallet className="h-7 w-7" />} title="אין תחנות" text="תחנות שתוסיף בעמוד התחנות יופיעו כאן." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {bills.map((b) => {
                const s = state(b);
                return (
                  <li key={b.station_id} className={cx('flex flex-col gap-3 px-5 py-3.5 md:flex-row md:items-center', b.owed > 0 && 'bg-rose-50/40')}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{b.station_name}</span>
                        <Badge tone={s.tone} dot>
                          {s.label}
                        </Badge>
                        {b.plan && <Badge tone="slate">{PLAN_LABEL[b.plan] || b.plan}</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                        <span>{b.price != null ? `${money(b.price)} לחודש` : 'לא הוגדר מחיר'}</span>
                        <span>מנוי עד {b.sub_end ? fmtDate(b.sub_end) : 'ללא הגבלה'}</span>
                        <span>תשלום אחרון: {b.last_paid_at ? `${fmtDate(b.last_paid_at)} · ${money(b.last_amount)}` : 'עדיין לא'}</span>
                        {b.owed > 0 && <span className="font-medium text-rose-700">חוב {money(b.owed)}</span>}
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="secondary" title="התשלום החודשי הקבוע" onClick={() => setPriceFor(b)}>
                        <Pencil className="h-4 w-4" />
                        {b.price != null ? money(b.price) : 'מחיר'}
                      </Button>
                      <Button size="sm" variant={b.owed > 0 ? 'primary' : 'secondary'} onClick={() => setPayFor(b)}>
                        <Plus className="h-4 w-4" />
                        תשלום
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <PaySettingsCard value={paySettings} settings={settings} onEdit={() => setEditSettings(true)} />
      </div>

      <Section title="תשלומים אחרונים" icon={<Receipt className="h-4 w-4" />}>
        {pays.length === 0 ? (
          <Empty icon={<Receipt className="h-7 w-7" />} title="עדיין לא נרשמו תשלומים" text="תשלום שתאשר או שתרשום ידנית יופיע כאן." />
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 text-right font-medium">תאריך</th>
                  <th className="px-3 py-2 text-right font-medium">תחנה</th>
                  <th className="px-3 py-2 text-right font-medium">סכום</th>
                  <th className="px-3 py-2 text-right font-medium">חודשים</th>
                  <th className="px-3 py-2 text-right font-medium">אמצעי</th>
                  <th className="px-3 py-2 text-right font-medium">הערה</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pays.map((p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap px-5 py-2.5 tabular-nums">{fmtDate(p.paid_at)}</td>
                    <td className="px-3 py-2.5">{p.station_name}</td>
                    <td className="px-3 py-2.5 font-medium tabular-nums">{money(p.amount)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{p.months || '—'}</td>
                    <td className="px-3 py-2.5">{p.method || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-500">{p.note || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-slate-100 md:hidden">
              {pays.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-900">{p.station_name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {fmtDate(p.paid_at)} · {p.months ? monthsLabel(p.months) : 'בלי הארכה'} · {p.method || '—'}
                    </div>
                    {p.note && <div className="mt-0.5 truncate text-xs text-slate-400">{p.note}</div>}
                  </div>
                  <div className="font-medium tabular-nums text-slate-900">{money(p.amount)}</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <PayForm bills={bills || []} value={payFor} onClose={() => setPayFor(null)} onDone={load} />
      <PriceForm bill={priceFor} onClose={() => setPriceFor(null)} onDone={load} />
      <SettingsForm open={editSettings} value={settings} pay={paySettings} onClose={() => setEditSettings(false)} onDone={load} />
    </>
  );
}

// ---------- payment requests from stations ----------
function PayRequests({
  tab,
  setTab,
  pending,
  history,
  subEndOf,
  onDone,
}: {
  tab: 'pending' | 'all';
  setTab: (t: 'pending' | 'all') => void;
  pending: PayReq[] | null;
  history: PayReq[] | null;
  subEndOf: (id: string) => string | null;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [rejectFor, setRejectFor] = useState<PayReq | null>(null);
  const [proofFor, setProofFor] = useState<PayReq | null>(null);
  const list = tab === 'pending' ? pending : history;

  async function approve(r: PayReq) {
    setBusy(r.id);
    const done = await decide(r, true, undefined, subEndOf(r.station_id));
    setBusy(null);
    if (done) onDone();
  }

  return (
    <Section
      className={cx('mb-6', !!pending?.length && 'border-amber-200')}
      title={
        <span className="flex items-center gap-2">
          בקשות תשלום
          {!!pending?.length && (
            <Badge tone="amber" dot>
              {pending.length} ממתינות
            </Badge>
          )}
        </span>
      }
      icon={<Inbox className="h-4 w-4" />}
      action={
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'pending', label: 'ממתינות', count: pending?.length },
            { value: 'all', label: 'כל הבקשות' },
          ]}
        />
      }
    >
      {!list ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : list.length === 0 ? (
        tab === 'pending' ? (
          <div className="flex items-center gap-3 px-5 py-5 text-sm text-slate-500">
            <Check className="h-4 w-4 text-emerald-600" />
            אין בקשות תשלום שמחכות לאישור.
          </div>
        ) : (
          <Empty icon={<Inbox className="h-7 w-7" />} title="עדיין אין בקשות" text="כשתחנה שולחת אסמכתה על תשלום, הבקשה מופיעה כאן ונשלחת אליך גם בוואטסאפ." />
        )
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.map((r) => {
            const s = REQ_STATUS[r.status] || REQ_STATUS.cancelled;
            const isPending = r.status === 'pending';
            return (
              <li key={r.id} className={cx('flex flex-col gap-3 px-5 py-3.5 md:flex-row md:items-center', isPending && 'bg-amber-50/40')}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{r.station_name}</span>
                    <span className="font-semibold tabular-nums text-slate-900">{money(r.amount)}</span>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                    <span>#{r.id}</span>
                    <span>{monthsLabel(r.months)}</span>
                    <span>{METHOD_LABEL[r.method] || r.method}</span>
                    <span>נשלחה {fmtDateTime(r.created_at)}</span>
                    {!isPending && r.decided_at && (
                      <span>
                        טופלה {fmtDateTime(r.decided_at)}
                        {r.decided_by_name ? ` · ${r.decided_by_name}` : ''}
                      </span>
                    )}
                  </div>
                  {r.note && <div className="mt-1 text-sm text-slate-700">״{r.note}״</div>}
                  {r.status === 'rejected' && r.reject_reason && <div className="mt-1 text-xs text-rose-700">הסיבה: {r.reject_reason}</div>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => setProofFor(r)} disabled={!r.has_proof} title={r.has_proof ? 'צפייה באסמכתה' : 'לא צורפה אסמכתה'}>
                    <Eye className="h-4 w-4" />
                    אסמכתה
                  </Button>
                  {isPending && (
                    <>
                      <Button size="sm" variant="success" loading={busy === r.id} onClick={() => approve(r)}>
                        <Check className="h-4 w-4" />
                        אישור
                      </Button>
                      <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => setRejectFor(r)}>
                        <X className="h-4 w-4" />
                        דחייה
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <RejectDialog
        open={!!rejectFor}
        title={rejectFor ? `דחיית התשלום של ${rejectFor.station_name}` : undefined}
        onClose={() => setRejectFor(null)}
        onSubmit={async (reason) => {
          const done = await decide(rejectFor!, false, reason);
          if (done) onDone();
          return done;
        }}
      />
      <ProofModal
        req={proofFor}
        onClose={() => setProofFor(null)}
        onApprove={async (r) => {
          const done = await decide(r, true, undefined, subEndOf(r.station_id));
          if (done) {
            setProofFor(null);
            onDone();
          }
        }}
        onReject={(r) => {
          setProofFor(null);
          setRejectFor(r);
        }}
      />
    </Section>
  );
}

function ProofModal({ req, onClose, onApprove, onReject }: { req: PayReq | null; onClose: () => void; onApprove: (r: PayReq) => Promise<void>; onReject: (r: PayReq) => void }) {
  const [data, setData] = useState<{ proof_data: string | null; sub_end: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setData(null);
    if (!req) return;
    let live = true;
    sb()
      .rpc('owner_payment_request_get', { p_id: req.id })
      .then(({ data: d, error }) => {
        if (!live) return;
        if (error) return toast('לא הצלחנו לטעון את האסמכתה: ' + error.message, 'error');
        setData((d as any) || { proof_data: null, sub_end: null });
      });
    return () => {
      live = false;
    };
  }, [req]);
  const pending = req?.status === 'pending';
  return (
    <Modal
      open={!!req}
      onClose={onClose}
      title={req ? `אסמכתה – ${req.station_name}` : ''}
      wide
      footer={
        pending && req ? (
          <>
            <Button variant="danger" onClick={() => onReject(req)} disabled={busy}>
              <X className="h-4 w-4" />
              דחייה
            </Button>
            <Button
              variant="success"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                await onApprove(req);
                setBusy(false);
              }}
            >
              <Check className="h-4 w-4" />
              אישור התשלום
            </Button>
          </>
        ) : undefined
      }
    >
      {req && (
        <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-600">
          <b className="tabular-nums text-slate-900">{money(req.amount)}</b>
          <span>{monthsLabel(req.months)}</span>
          <span>{METHOD_LABEL[req.method] || req.method}</span>
          <span>{fmtDateTime(req.created_at)}</span>
          {pending && data && <span>המנוי יוארך עד {fmtDate(endAfter(data.sub_end, req.months))}</span>}
        </div>
      )}
      {!data ? <Skeleton className="h-72" /> : <ProofView data={data.proof_data} />}
      {pending && <p className="mt-3 text-xs leading-relaxed text-slate-500">לאשר רק אחרי שבדקת שהכסף התקבל בפועל. צילום מסך לבד אינו הוכחה.</p>}
    </Modal>
  );
}

// ---------- payment settings ----------
function SettingRow({ icon, label, value, ltr }: { icon: React.ReactNode; label: string; value: string | null | undefined; ltr?: boolean }) {
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className="mt-0.5 text-slate-400">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-slate-500">{label}</div>
        {value ? (
          <div className="truncate text-sm text-slate-900" dir={ltr ? 'ltr' : undefined} style={ltr ? { textAlign: 'right' } : undefined}>
            {value}
          </div>
        ) : (
          <div className="text-sm text-amber-700">לא הוגדר</div>
        )}
      </div>
    </li>
  );
}

function PaySettingsCard({ value, settings, onEdit }: { value: PaySettings | null; settings: Settings | null; onEdit: () => void }) {
  return (
    <Section
      title="הגדרות תשלום"
      icon={<Settings2 className="h-4 w-4" />}
      action={
        <Button size="sm" variant="secondary" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
          עריכה
        </Button>
      }
    >
      {!value ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          <SettingRow icon={<Link2 className="h-4 w-4" />} label="קישור לתשלום בביט" value={value.bit_link} ltr />
          <SettingRow icon={<Link2 className="h-4 w-4" />} label="קישור לתשלום בפייבוקס" value={value.paybox_link} ltr />
          <SettingRow icon={<Phone className="h-4 w-4" />} label="וואטסאפ לאישורי תשלום" value={value.approvals_phone} ltr />
          <SettingRow icon={<Phone className="h-4 w-4" />} label="וואטסאפ לפניות תמיכה" value={value.support_phone || (value.approvals_phone ? `${value.approvals_phone} (כמו האישורים)` : null)} ltr />
          <SettingRow icon={<ExternalLink className="h-4 w-4" />} label="כתובת האפליקציה (לקישורים בהודעות)" value={value.app_url} ltr />
          <li className="px-5 py-3 text-xs text-slate-500">
            תזכורת {settings?.reminder_days ?? value.reminder_days ?? 5} ימים לפני סיום המנוי
            {settings?.extra_arm_price != null ? ` · זרוע נוספת ${money(settings.extra_arm_price)} לחודש` : ''}
          </li>
        </ul>
      )}
    </Section>
  );
}

// ---------- manual payment ----------
function PayForm({ bills, value, onClose, onDone }: { bills: Bill[]; value: Bill | null; onClose: () => void; onDone: () => void }) {
  const [stationId, setStationId] = useState('');
  const [months, setMonths] = useState(1);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(METHODS[0]);
  const [paidAt, setPaidAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const sel = bills.find((b) => b.station_id === stationId);

  useEffect(() => {
    if (!value) return;
    const id = value.station_id || bills[0]?.station_id || '';
    const b = bills.find((x) => x.station_id === id);
    const m = b && b.months_overdue > 0 ? b.months_overdue : 1;
    setStationId(id);
    setMonths(m);
    setAmount(b?.price != null ? String(Number(b.price) * m) : '');
    setMethod(METHODS[0]);
    setPaidAt(new Date().toISOString().slice(0, 10));
    setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function pickStation(id: string) {
    setStationId(id);
    const b = bills.find((x) => x.station_id === id);
    const m = b && b.months_overdue > 0 ? b.months_overdue : 1;
    setMonths(m);
    setAmount(b?.price != null ? String(Number(b.price) * m) : '');
  }
  function pickMonths(m: number) {
    setMonths(m);
    if (sel?.price != null) setAmount(String(Number(sel.price) * m));
  }

  async function save() {
    const a = Number(amount);
    if (!stationId) return toast('בחר תחנה', 'error');
    if (!(a >= 0) || amount === '') return toast('סכום לא תקין', 'error');
    setBusy(true);
    const { data, error } = await sb().rpc('owner_payment_add', {
      p_station: stationId,
      p_amount: a,
      p_months: months,
      p_method: method,
      p_note: note || null,
      p_paid_at: paidAt || null,
    });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    toast(months > 0 ? `התשלום נרשם. המנוי עד ${fmtDate((data as any)?.sub_end)}` : 'התשלום נרשם');
    onClose();
    onDone();
  }

  return (
    <Modal
      open={!!value}
      onClose={onClose}
      title="רישום תשלום ידני"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy}>
            רישום התשלום
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="תחנה">
          <Select value={stationId} onChange={(e) => pickStation(e.target.value)}>
            {bills.map((b) => (
              <option key={b.station_id} value={b.station_id}>
                {b.station_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="הארכת המנוי" hint="0 = תשלום בלי הארכת מנוי">
          <Select value={months} onChange={(e) => pickMonths(Number(e.target.value))}>
            {[0, 1, 2, 3, 6, 12].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'בלי הארכה' : monthsLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="סכום (₪)">
          <Input type="number" inputMode="decimal" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="אמצעי תשלום">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field label="תאריך התשלום">
          <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>
        <Field label="הערה">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="אופציונלי" />
        </Field>
      </div>
      {sel && months > 0 && (
        <p className="mt-4 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-900">
          המנוי של <b>{sel.station_name}</b> יוארך ב{monthsLabel(months)} – עד <b className="tabular-nums">{fmtDate(endAfter(sel.sub_end, months))}</b>
          {sel.owed > 0 ? ' (מהיום, התחנה בפיגור)' : ''}. תחנה מושהית תופעל מחדש.
        </p>
      )}
    </Modal>
  );
}

// ---------- extra-arm requests ----------
function ArmRequests({ reqs, extra, onDone }: { reqs: ArmReq[]; extra: number; onDone: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [prices, setPrices] = useState<Record<number, string>>({});
  if (!reqs.length) return null;
  const suggested = (r: ArmReq) => (r.price_before != null ? Number(r.price_before) + extra * r.count : null);
  async function decideArm(r: ArmReq, approve: boolean) {
    const raw = prices[r.id] ?? (suggested(r) != null ? String(suggested(r)) : '');
    if (approve && raw !== '' && !(Number(raw) >= 0)) return toast('מחיר לא תקין', 'error');
    if (!approve && !(await ask({ title: 'לדחות את הבקשה?', text: `${r.station_name} ביקשה עוד ${r.count} ${r.count === 1 ? 'זרוע' : 'זרועות'}. התחנה תקבל הודעה.`, ok: 'דחיית הבקשה', danger: true }))) return;
    setBusy(r.id);
    const { error } = await sb().rpc('owner_decide_arm_request', { p_id: r.id, p_approve: approve, p_new_price: approve && raw !== '' ? Number(raw) : null });
    setBusy(null);
    if (error) return toast(error.message, 'error');
    toast(approve ? 'אושר – התחנה קיבלה הודעה' : 'נדחה – התחנה קיבלה הודעה');
    onDone();
  }
  const waiting = reqs.filter((r) => r.status === 'pending').length;
  return (
    <Section
      className="mb-6"
      title={
        <span className="flex items-center gap-2">
          בקשות לזרועות נוספות
          {waiting > 0 && <Badge tone="amber">{waiting} ממתינות</Badge>}
        </span>
      }
      icon={<Smartphone className="h-4 w-4" />}
    >
      <ul className="divide-y divide-slate-100">
        {reqs.map((r) => (
          <li key={r.id} className={cx('flex flex-col gap-3 px-5 py-3.5 md:flex-row md:items-center', r.status === 'pending' && 'bg-amber-50/40')}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-900">{r.station_name}</span>
                <span className="text-sm">
                  מבקשת עוד {r.count} {r.count === 1 ? 'זרוע' : 'זרועות'}
                </span>
                {r.status !== 'pending' && <Badge tone={r.status === 'approved' ? 'green' : 'slate'}>{r.status === 'approved' ? 'אושר' : 'נדחה'}</Badge>}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                כרגע {r.arms_count} מתוך {r.max_arms ?? '—'} · תשלום נוכחי {r.price_before != null ? money(r.price_before) : '—'}
                {r.price_after != null && r.status === 'approved' ? ` · אחרי האישור ${money(r.price_after)}` : ''} · {fmtDateTime(r.created_at)}
              </div>
              {r.note && <div className="mt-1 text-sm text-slate-700">״{r.note}״</div>}
            </div>
            {r.status === 'pending' && (
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="w-36">
                  <Input
                    type="number"
                    min={0}
                    placeholder="תשלום חודשי חדש"
                    aria-label="התשלום החודשי אחרי האישור"
                    value={prices[r.id] ?? (suggested(r) != null ? String(suggested(r)) : '')}
                    onChange={(e) => setPrices({ ...prices, [r.id]: e.target.value })}
                    title="התשלום החודשי אחרי האישור (ריק = בלי שינוי)"
                  />
                </div>
                <Button size="sm" variant="success" loading={busy === r.id} onClick={() => decideArm(r, true)}>
                  <Check className="h-4 w-4" />
                  אישור
                </Button>
                <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => decideArm(r, false)} aria-label="דחיית הבקשה">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PriceForm({ bill, onClose, onDone }: { bill: Bill | null; onClose: () => void; onDone: () => void }) {
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (bill) setPrice(bill.price != null ? String(Number(bill.price)) : '');
  }, [bill]);
  async function save() {
    if (price !== '' && !(Number(price) >= 0)) return toast('מחיר לא תקין', 'error');
    setBusy(true);
    const { error } = await sb().rpc('owner_set_price', { p_station: bill!.station_id, p_price: price === '' ? null : Number(price) });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    toast('התשלום הקבוע עודכן');
    onClose();
    onDone();
  }
  return (
    <Modal
      open={!!bill}
      onClose={onClose}
      title={`תשלום חודשי קבוע – ${bill?.station_name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy}>
            שמירה
          </Button>
        </>
      }
    >
      <Field label="סכום לחודש (₪)" hint="משמש לחישוב חובות, לתזכורת לתחנה ולסכום המוצע בתשלום">
        <Input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function SettingsForm({
  open,
  value,
  pay,
  onClose,
  onDone,
}: {
  open: boolean;
  value: Settings | null;
  pay: PaySettings | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [extra, setExtra] = useState('');
  const [days, setDays] = useState('5');
  const [bit, setBit] = useState('');
  const [paybox, setPaybox] = useState('');
  const [approvals, setApprovals] = useState('');
  const [support, setSupport] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setNote(value?.payment_note || '');
    setExtra(value?.extra_arm_price != null ? String(Number(value.extra_arm_price)) : '50');
    setDays(String(value?.reminder_days ?? 5));
    setBit(pay?.bit_link || '');
    setPaybox(pay?.paybox_link || '');
    setApprovals(pay?.approvals_phone || '');
    setSupport(pay?.support_phone || '');
    setAppUrl(pay?.app_url || (typeof window !== 'undefined' ? window.location.origin : ''));
  }, [open, value, pay]);
  async function save() {
    const https = (v: string) => !v.trim() || /^https:\/\//i.test(v.trim());
    if (!https(bit)) return toast('קישור ביט חייב להתחיל ב-https://', 'error');
    if (!https(paybox)) return toast('קישור פייבוקס חייב להתחיל ב-https://', 'error');
    setBusy(true);
    const a = await sb().rpc('owner_pay_settings_save', {
      p_bit: bit,
      p_paybox: paybox,
      p_approvals_phone: approvals,
      p_support_phone: support,
      p_app_url: appUrl,
    });
    if (a.error) {
      setBusy(false);
      return toast(a.error.message, 'error');
    }
    const b = await sb().rpc('owner_settings_save', { p_payment_note: note, p_extra_arm_price: Number(extra || 0), p_reminder_days: Number(days || 5) });
    setBusy(false);
    if (b.error) return toast(b.error.message, 'error');
    toast('ההגדרות נשמרו');
    onClose();
    onDone();
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="הגדרות תשלום"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy}>
            שמירה
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="קישור קבוע לתשלום בביט" hint="התחנה פותחת אותו בכפתור 'פתיחת ביט לתשלום'">
            <Input dir="ltr" inputMode="url" value={bit} onChange={(e) => setBit(e.target.value)} placeholder="https://" />
          </Field>
          <Field label="קישור קבוע לתשלום בפייבוקס">
            <Input dir="ltr" inputMode="url" value={paybox} onChange={(e) => setPaybox(e.target.value)} placeholder="https://" />
          </Field>
          <Field label="וואטסאפ לאישורי תשלום" hint="לכאן נשלח קישור לאישור כל תשלום">
            <Input dir="ltr" inputMode="tel" value={approvals} onChange={(e) => setApprovals(e.target.value)} placeholder="05X-XXXXXXX" />
          </Field>
          <Field label="וואטסאפ לפניות תמיכה" hint="ריק = אותו מספר כמו האישורים">
            <Input dir="ltr" inputMode="tel" value={support} onChange={(e) => setSupport(e.target.value)} placeholder="05X-XXXXXXX" />
          </Field>
          <div className="md:col-span-2">
            <Field label="כתובת האפליקציה" hint="משמשת לקישורים שנשלחים בוואטסאפ (אישור תשלום, פניות)">
              <Input dir="ltr" inputMode="url" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://" />
            </Field>
          </div>
        </div>
        <div className="border-t border-slate-100 pt-5">
          <Field label="הודעה לתחנות על התשלום" hint="מוצגת לתחנה במסך המנוי ובתזכורת התשלום">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-0" />
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="תזכורת לפני סיום המנוי (ימים)" hint="מכאן והלאה התחנה רואה תזכורת עד שתשלם">
            <Input type="number" min={0} max={30} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Field label="מחיר לזרוע נוספת (₪ לחודש)" hint="מוצע אוטומטית כשמאשרים בקשה לזרוע">
            <Input type="number" min={0} value={extra} onChange={(e) => setExtra(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
