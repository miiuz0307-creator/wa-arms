'use client';
// Payments: what each station pays, what was received, who is behind. Owner only.
// Recording a payment for N months extends the station's subscription by N months.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarCheck, Check, Pencil, Plus, Receipt, Settings2, Smartphone, Wallet, X } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Stat, Textarea, cx, toast } from '@/components/ui';

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
type Req = {
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
type Settings = { payment_note: string | null; extra_arm_price: number | null; reminder_days: number | null };
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
  const [priceFor, setPriceFor] = useState<Bill | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editSettings, setEditSettings] = useState(false);

  const load = useCallback(async () => {
    const [b, p, r, st] = await Promise.all([
      sb().rpc('owner_billing'),
      sb().rpc('owner_payments', { p_limit: 300 }),
      sb().rpc('owner_arm_requests'),
      sb().rpc('owner_settings_get'),
    ]);
    if (b.error) toast(b.error.message, 'error');
    setBills((b.data as Bill[]) || []);
    setPays((p.data as Pay[]) || []);
    setReqs((r.data as Req[]) || []);
    setSettings((st.data as Settings) || null);
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
          <>
            <Button variant="secondary" onClick={() => setEditSettings(true)}>
              <Settings2 className="h-4 w-4" />
              הגדרות תשלום
            </Button>
            <Button onClick={() => setPayFor({} as Bill)} disabled={!bills?.length}>
              <Plus className="h-4 w-4" />
              רישום תשלום
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="התקבל החודש" value={money(sum.received)} icon={<Wallet className="h-5 w-5" />} tone="green" />
        <Stat label="צפוי בחודש (תחנות פעילות)" value={money(sum.expected)} icon={<Receipt className="h-5 w-5" />} tone="violet" />
        <Stat label="חובות פתוחים" value={money(sum.owed)} sub={sum.behind ? `${sum.behind} תחנות בפיגור` : 'אין פיגורים'} icon={<AlertTriangle className="h-5 w-5" />} tone={sum.owed ? 'red' : 'slate'} />
        <Stat label="לתשלום השבוע" value={sum.soon} icon={<CalendarCheck className="h-5 w-5" />} tone="amber" />
      </div>

      <Requests reqs={reqs} extra={Number(settings?.extra_arm_price || 0)} onDone={load} />

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
      <PriceForm bill={priceFor} onClose={() => setPriceFor(null)} onDone={load} />
      <SettingsForm open={editSettings} value={settings} onClose={() => setEditSettings(false)} onDone={load} />
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

function Requests({ reqs, extra, onDone }: { reqs: Req[]; extra: number; onDone: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [prices, setPrices] = useState<Record<number, string>>({});
  if (!reqs.length) return null;
  const suggested = (r: Req) => (r.price_before != null ? Number(r.price_before) + extra * r.count : null);
  async function decide(r: Req, approve: boolean) {
    const raw = prices[r.id] ?? (suggested(r) != null ? String(suggested(r)) : '');
    if (approve && raw !== '' && !(Number(raw) >= 0)) return toast('מחיר לא תקין', 'error');
    setBusy(r.id);
    const { error } = await sb().rpc('owner_decide_arm_request', { p_id: r.id, p_approve: approve, p_new_price: approve && raw !== '' ? Number(raw) : null });
    setBusy(null);
    if (error) return toast(error.message, 'error');
    toast(approve ? 'אושר – התחנה קיבלה הודעה' : 'נדחה – התחנה קיבלה הודעה');
    onDone();
  }
  return (
    <Card className="mb-6">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4 font-semibold">
        <Smartphone className="h-4 w-4 text-indigo-600" />
        בקשות לזרועות נוספות
        {reqs.some((r) => r.status === 'pending') && <Badge tone="amber">{reqs.filter((r) => r.status === 'pending').length} ממתינות</Badge>}
      </div>
      <ul className="divide-y divide-slate-100">
        {reqs.map((r) => (
          <li key={r.id} className={cx('flex flex-col gap-3 px-5 py-3 md:flex-row md:items-center', r.status === 'pending' && 'bg-amber-50/40')}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.station_name}</span>
                <span className="text-sm">מבקשת עוד {r.count} {r.count === 1 ? 'זרוע' : 'זרועות'}</span>
                {r.status !== 'pending' && <Badge tone={r.status === 'approved' ? 'green' : 'slate'}>{r.status === 'approved' ? 'אושר' : 'נדחה'}</Badge>}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                כרגע {r.arms_count} מתוך {r.max_arms ?? '—'} · תשלום נוכחי {r.price_before != null ? money(r.price_before) : '—'}
                {r.price_after != null && r.status === 'approved' ? ` → ${money(r.price_after)}` : ''} · {new Date(r.created_at).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}
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
                    value={prices[r.id] ?? (suggested(r) != null ? String(suggested(r)) : '')}
                    onChange={(e) => setPrices({ ...prices, [r.id]: e.target.value })}
                    title="התשלום החודשי אחרי האישור (ריק = בלי שינוי)"
                  />
                </div>
                <Button size="sm" variant="success" loading={busy === r.id} onClick={() => decide(r, true)}>
                  <Check className="h-4 w-4" />
                  אישור
                </Button>
                <Button size="sm" variant="danger" disabled={busy === r.id} onClick={() => confirm('לדחות את הבקשה?') && decide(r, false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
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
      <Field label="סכום לחודש (₪)" hint="משמש לחישוב חובות, לתזכורת לתחנה ולסכום המוצע ברישום תשלום">
        <Input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function SettingsForm({ open, value, onClose, onDone }: { open: boolean; value: Settings | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [extra, setExtra] = useState('');
  const [days, setDays] = useState('5');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setNote(value?.payment_note || '');
      setExtra(value?.extra_arm_price != null ? String(Number(value.extra_arm_price)) : '50');
      setDays(String(value?.reminder_days ?? 5));
    }
  }, [open, value]);
  async function save() {
    setBusy(true);
    const { error } = await sb().rpc('owner_settings_save', { p_payment_note: note, p_extra_arm_price: Number(extra || 0), p_reminder_days: Number(days || 5) });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    toast('נשמר');
    onClose();
    onDone();
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="הגדרות תשלום"
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
      <div className="grid gap-4">
        <Field label="איך משלמים" hint="מוצג לתחנה בתזכורת התשלום. לדוגמה: ביט / פייבוקס ל-050-0000000 על שם ...">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-0" />
        </Field>
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
