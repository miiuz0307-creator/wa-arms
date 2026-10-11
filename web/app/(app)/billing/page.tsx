'use client';
// Payments: what each station pays, what was received, who is behind. Owner only.
// Recording a payment for N months extends the station's subscription by N months.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarCheck, Plus, Receipt, Wallet } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Stat, cx, toast } from '@/components/ui';

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
};
type Pay = { id: number; station_id: string; station_name: string; amount: number; months: number; paid_at: string; method: string | null; note: string | null };

const money = (n: number | null | undefined) => `${Math.round(Number(n || 0)).toLocaleString('he-IL')} ₪`;
const fmtDate = (d: string | null) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('he-IL') : '—');
const daysLeft = (d: string | null) => (d ? Math.ceil((new Date(d + 'T23:59:59').getTime() - Date.now()) / 86400000) : null);
const METHODS = ['ביט', 'פייבוקס', 'העברה בנקאית', 'מזומן', 'אשראי', 'צ׳ק'];

export default function BillingPage() {
  const { isSuper, loading, station } = useAuth();
  if (loading) return <Spinner />;
  if (!isSuper || station?.acting) return <div className="py-20 text-center text-slate-500">המסך הזה זמין רק למנהל הראשי (מחוץ לתחנה).</div>;
  return <Billing />;
}

function state(b: Bill): { label: string; tone: any } {
  if (b.status === 'suspended') return { label: 'מושעית', tone: 'slate' };
  if (b.owed > 0) return { label: `חוב ${money(b.owed)}`, tone: 'red' };
  const d = daysLeft(b.sub_end);
  if (d === null) return { label: 'ללא הגבלה', tone: 'slate' };
  if (d <= 7) return { label: d <= 0 ? 'מסתיים היום' : `לתשלום בעוד ${d} ימים`, tone: 'amber' };
  return { label: `שולם עד ${fmtDate(b.sub_end)}`, tone: 'green' };
}

function Billing() {
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [pays, setPays] = useState<Pay[]>([]);
  const [payFor, setPayFor] = useState<Bill | null>(null);

  const load = useCallback(async () => {
    const [b, p] = await Promise.all([sb().rpc('owner_billing'), sb().rpc('owner_payments', { p_limit: 300 })]);
    if (b.error) toast(b.error.message, 'error');
    setBills((b.data as Bill[]) || []);
    setPays((p.data as Pay[]) || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

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
        title="תשלומים"
        subtitle="מי שילם, מי בפיגור, וכמה נכנס החודש. רישום תשלום מאריך את המנוי של התחנה."
        actions={
          <Button onClick={() => setPayFor({} as Bill)} disabled={!bills?.length}>
            <Plus className="h-4 w-4" />
            רישום תשלום
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="התקבל החודש" value={money(sum.received)} icon={<Wallet className="h-5 w-5" />} tone="green" />
        <Stat label="צפוי בחודש (תחנות פעילות)" value={money(sum.expected)} icon={<Receipt className="h-5 w-5" />} tone="violet" />
        <Stat label="חובות פתוחים" value={money(sum.owed)} sub={sum.behind ? `${sum.behind} תחנות בפיגור` : 'אין פיגורים'} icon={<AlertTriangle className="h-5 w-5" />} tone={sum.owed ? 'red' : 'slate'} />
        <Stat label="לתשלום השבוע" value={sum.soon} icon={<CalendarCheck className="h-5 w-5" />} tone="amber" />
      </div>

      <Card className="mb-6">
        <div className="border-b border-slate-100 px-5 py-4 font-semibold">מצב לפי תחנה</div>
        {!bills ? (
          <Spinner />
        ) : bills.length === 0 ? (
          <Empty icon={<Wallet className="h-7 w-7" />} title="אין תחנות" text="תחנות שתוסיף בעמוד התחנות יופיעו כאן." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {bills.map((b) => {
              const s = state(b);
              return (
                <li key={b.station_id} className={cx('flex flex-col gap-3 px-5 py-3 md:flex-row md:items-center', b.owed > 0 && 'bg-rose-50/40')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{b.station_name}</span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                      <span>{b.price != null ? `${money(b.price)} לחודש` : 'לא הוגדר מחיר'}</span>
                      <span>מנוי עד {fmtDate(b.sub_end)}</span>
                      <span>תשלום אחרון: {b.last_paid_at ? `${fmtDate(b.last_paid_at)} · ${money(b.last_amount)}` : 'עדיין לא'}</span>
                      <span>סה״כ שולם: {money(b.paid_total)}</span>
                    </div>
                  </div>
                  <Button size="sm" variant={b.owed > 0 ? 'primary' : 'secondary'} onClick={() => setPayFor(b)}>
                    <Plus className="h-4 w-4" />
                    תשלום
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <div className="border-b border-slate-100 px-5 py-4 font-semibold">תשלומים אחרונים</div>
        {pays.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">עדיין לא נרשמו תשלומים</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
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
                    <td className="whitespace-nowrap px-5 py-2.5">{fmtDate(p.paid_at)}</td>
                    <td className="px-3 py-2.5">{p.station_name}</td>
                    <td className="px-3 py-2.5 font-medium tabular-nums">{money(p.amount)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{p.months || '—'}</td>
                    <td className="px-3 py-2.5">{p.method || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-500">{p.note || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <PayForm bills={bills || []} value={payFor} onClose={() => setPayFor(null)} onDone={load} />
    </>
  );
}

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
    toast(months > 0 ? `נרשם. המנוי עד ${fmtDate((data as any)?.sub_end)}` : 'התשלום נרשם');
    onClose();
    onDone();
  }

  return (
    <Modal
      open={!!value}
      onClose={onClose}
      title="רישום תשלום"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy}>
            רישום
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
        <Field label="על כמה חודשים" hint="0 = תשלום בלי הארכת מנוי">
          <Select value={months} onChange={(e) => pickMonths(Number(e.target.value))}>
            {[0, 1, 2, 3, 6, 12].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'בלי הארכה' : m === 1 ? 'חודש' : m === 12 ? 'שנה' : `${m} חודשים`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="סכום (₪)">
          <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
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
          המנוי של <b>{sel.station_name}</b> יוארך ב-{months} {months === 1 ? 'חודש' : 'חודשים'}
          {sel.owed > 0 ? ' מהיום (התחנה בפיגור)' : sel.sub_end ? ` מ-${fmtDate(sel.sub_end)}` : ''}, ותחנה מושעית תופעל מחדש.
        </p>
      )}
    </Modal>
  );
}
