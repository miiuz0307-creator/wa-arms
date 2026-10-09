'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Plus,
  Pencil,
  KeyRound,
  LogIn,
  PauseCircle,
  PlayCircle,
  Trash2,
  CalendarPlus,
  Copy,
  Smartphone,
  UsersRound,
  Send,
  Wallet,
  AlertTriangle,
  Search,
} from 'lucide-react';
import { sb, actAsStation } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { fmtTime } from '@/lib/format';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Stat, Textarea, cx, toast } from '@/components/ui';

type Row = {
  id: string;
  name: string;
  manager_name: string | null;
  phone: string | null;
  code_hint: string | null;
  status: 'active' | 'suspended';
  joined_at: string;
  sub_end: string | null;
  price: number | null;
  max_arms: number | null;
  notes: string | null;
  created_at: string;
  arms_total: number;
  arms_online: number;
  groups_count: number;
  campaigns_count: number;
  last_campaign: string | null;
  last_login: string | null;
};

const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (d: string, m: number) => {
  const x = new Date(d + 'T12:00:00');
  x.setMonth(x.getMonth() + m);
  return x.toISOString().slice(0, 10);
};
const daysLeft = (sub_end: string | null) =>
  sub_end ? Math.ceil((new Date(sub_end + 'T23:59:59').getTime() - Date.now()) / 86400000) : null;
const fmtDate = (d: string | null) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('he-IL') : '—');
const money = (n: number) => `${Math.round(n).toLocaleString('he-IL')} ₪`;

function subState(r: Row): { label: string; tone: any } {
  if (r.status === 'suspended') return { label: 'מושעית', tone: 'red' };
  const d = daysLeft(r.sub_end);
  if (d === null) return { label: 'ללא הגבלה', tone: 'slate' };
  if (d < 0) return { label: 'המנוי הסתיים', tone: 'red' };
  if (d <= 7) return { label: d === 0 ? 'מסתיים היום' : `עוד ${d} ימים`, tone: 'amber' };
  return { label: `עד ${fmtDate(r.sub_end)}`, tone: 'green' };
}

export default function StationsPage() {
  const { isSuper, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!isSuper) return <div className="py-20 text-center text-slate-500">המסך הזה זמין רק למנהל הראשי.</div>;
  return <Stations />;
}

function Stations() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Partial<Row> | null>(null);
  const [codeFor, setCodeFor] = useState<Row | null>(null);
  const [shownCode, setShownCode] = useState<{ name: string; code: string } | null>(null);
  const [extendFor, setExtendFor] = useState<Row | null>(null);
  const [delFor, setDelFor] = useState<Row | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('stations_overview');
    if (error) toast(error.message, 'error');
    setRows((data as Row[]) || []);
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, [load]);

  const stats = useMemo(() => {
    const r = rows || [];
    const active = r.filter((x) => x.status === 'active' && (daysLeft(x.sub_end) ?? 1) >= 0);
    return {
      total: r.length,
      active: active.length,
      expiring: r.filter((x) => x.status === 'active' && (daysLeft(x.sub_end) ?? 99) >= 0 && (daysLeft(x.sub_end) ?? 99) <= 7).length,
      blocked: r.length - active.length,
      revenue: active.reduce((s, x) => s + Number(x.price || 0), 0),
    };
  }, [rows]);

  const shown = (rows || []).filter((r) => {
    const t = q.trim();
    return !t || [r.name, r.manager_name, r.phone].some((v) => (v || '').includes(t));
  });

  async function setStatus(r: Row, status: 'active' | 'suspended') {
    if (status === 'suspended' && !confirm(`להשעות את "${r.name}"? הגישה נחסמת מיד והזרועות שלה מפסיקות לשלוח.`)) return;
    const { error } = await sb().rpc('station_save', { p: { ...r, status } });
    if (error) return toast(error.message, 'error');
    toast(status === 'active' ? 'התחנה הופעלה' : 'התחנה הושעתה');
    load();
  }

  return (
    <>
      <PageHeader
        title="תחנות"
        subtitle="כל התחנות במערכת – לכל אחת סביבה נפרדת, קוד כניסה משלה וחיבורי WhatsApp משלה"
        actions={
          <Button onClick={() => setEdit({ status: 'active', joined_at: today(), sub_end: addMonths(today(), 1), price: 200, max_arms: 2 })}>
            <Plus className="h-4 w-4" />
            הוספת תחנה חדשה
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="תחנות פעילות" value={`${stats.active}/${stats.total}`} icon={<Building2 className="h-5 w-5" />} tone="violet" />
        <Stat label="מנוי מסתיים השבוע" value={stats.expiring} icon={<CalendarPlus className="h-5 w-5" />} tone="amber" />
        <Stat label="מושעות / מנוי הסתיים" value={stats.blocked} icon={<AlertTriangle className="h-5 w-5" />} tone="red" />
        <Stat label="הכנסה חודשית (פעילות)" value={money(stats.revenue)} icon={<Wallet className="h-5 w-5" />} tone="green" />
      </div>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <Empty
            icon={<Building2 className="h-7 w-7" />}
            title="אין עדיין תחנות"
            text="צור תחנה ראשונה – היא תקבל מערכת ריקה ומוכנה, וקוד כניסה שתמסור למנהל התחנה."
            action={
              <Button onClick={() => setEdit({ status: 'active', joined_at: today(), sub_end: addMonths(today(), 1), price: 200, max_arms: 2 })}>
                <Plus className="h-4 w-4" />
                הוספת תחנה חדשה
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="border-b border-slate-100 p-3">
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input placeholder="חיפוש לפי שם, מנהל או טלפון" value={q} onChange={(e) => setQ(e.target.value)} className="pr-9" />
            </div>
          </div>
          <ul className="divide-y divide-slate-100">
            {shown.map((r) => {
              const sub = subState(r);
              const blocked = r.status === 'suspended' || (daysLeft(r.sub_end) ?? 1) < 0;
              return (
                <li key={r.id} className={cx('p-4 md:px-5', blocked && 'bg-rose-50/40')}>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-semibold">{r.name}</span>
                        <Badge tone={sub.tone} dot={!blocked}>
                          {sub.label}
                        </Badge>
                        {r.status === 'active' && blocked && <Badge tone="red">הגישה חסומה</Badge>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                        <span>מנהל: {r.manager_name || '—'}</span>
                        <span dir="ltr">{r.phone || ''}</span>
                        <span>קוד: ••••••{r.code_hint}</span>
                        {r.price != null && <span>{money(Number(r.price))} לחודש</span>}
                        <span>הצטרפה {fmtDate(r.joined_at)}</span>
                        <span>כניסה אחרונה: {r.last_login ? fmtTime(r.last_login) : 'עדיין לא'}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center lg:w-72">
                      <Metric icon={<Smartphone className="h-3.5 w-3.5" />} label="מכשירים" value={`${r.arms_online}/${r.arms_total}`} hint={r.max_arms ? `מקסימום ${r.max_arms}` : ''} ok={r.arms_total > 0 && r.arms_online === r.arms_total} />
                      <Metric icon={<UsersRound className="h-3.5 w-3.5" />} label="קבוצות" value={r.groups_count} />
                      <Metric icon={<Send className="h-3.5 w-3.5" />} label="הפצות" value={r.campaigns_count} />
                    </div>

                    <div className="flex flex-wrap gap-1.5 lg:w-auto lg:justify-end">
                      <Button size="sm" variant="primary" onClick={() => actAsStation(r.id)} title="כניסה לממשק התחנה כמנהל ראשי">
                        <LogIn className="h-4 w-4" />
                        כניסה
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEdit(r)} title="עריכת תחנה">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setCodeFor(r)} title="שינוי קוד כניסה">
                        <KeyRound className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setExtendFor(r)} title="הארכת מנוי">
                        <CalendarPlus className="h-4 w-4" />
                      </Button>
                      {r.status === 'active' ? (
                        <Button size="sm" variant="secondary" onClick={() => setStatus(r, 'suspended')} title="השעיית תחנה">
                          <PauseCircle className="h-4 w-4 text-amber-600" />
                        </Button>
                      ) : (
                        <Button size="sm" variant="success" onClick={() => setStatus(r, 'active')} title="הפעלת התחנה מחדש">
                          <PlayCircle className="h-4 w-4" />
                        </Button>
                      )}
                      <Button size="sm" variant="danger" onClick={() => setDelFor(r)} title="מחיקת תחנה">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
            {shown.length === 0 && <li className="p-8 text-center text-sm text-slate-500">לא נמצאו תחנות</li>}
          </ul>
        </Card>
      )}

      <StationForm
        value={edit}
        onClose={() => setEdit(null)}
        onSaved={(code, name) => {
          setEdit(null);
          load();
          if (code) setShownCode({ name, code });
        }}
      />
      <ChangeCode
        station={codeFor}
        onClose={() => setCodeFor(null)}
        onDone={(code) => {
          const name = codeFor?.name || '';
          setCodeFor(null);
          setShownCode({ name, code });
          load();
        }}
      />
      <ShowCode value={shownCode} onClose={() => setShownCode(null)} />
      <Extend station={extendFor} onClose={() => setExtendFor(null)} onDone={load} />
      <Delete station={delFor} onClose={() => setDelFor(null)} onDone={load} />
    </>
  );
}

function Metric({ icon, label, value, hint, ok }: { icon: React.ReactNode; label: string; value: any; hint?: string; ok?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50 px-2 py-2" title={hint}>
      <div className="flex items-center justify-center gap-1 text-[11px] text-slate-500">
        {icon}
        {label}
      </div>
      <div className={cx('font-semibold tabular-nums', ok && 'text-emerald-600')}>{value}</div>
    </div>
  );
}

function StationForm({ value, onClose, onSaved }: { value: Partial<Row> | null; onClose: () => void; onSaved: (code: string | null, name: string) => void }) {
  const [f, setF] = useState<any>({});
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = !value?.id;
  useEffect(() => {
    if (value) {
      setF({ ...value });
      setCode('');
    }
  }, [value]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  async function save() {
    if (!f.name?.trim()) return toast('חסר שם תחנה', 'error');
    if (code && code.replace(/\s/g, '').length < 6) return toast('קוד כניסה חייב להיות לפחות 6 תווים', 'error');
    setBusy(true);
    const { data, error } = await sb().rpc('station_save', { p: { ...f, code: isNew ? code : undefined } });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    toast(isNew ? 'התחנה נוצרה' : 'נשמר');
    onSaved(isNew ? (data as any)?.code : null, f.name);
  }

  return (
    <Modal
      open={!!value}
      onClose={onClose}
      title={isNew ? 'הוספת תחנה חדשה' : `עריכת ${value?.name}`}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy}>
            {isNew ? 'יצירת תחנה' : 'שמירה'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="שם התחנה">
          <Input value={f.name || ''} onChange={set('name')} autoFocus />
        </Field>
        <Field label="שם מנהל התחנה">
          <Input value={f.manager_name || ''} onChange={set('manager_name')} />
        </Field>
        <Field label="מספר טלפון">
          <Input dir="ltr" value={f.phone || ''} onChange={set('phone')} />
        </Field>
        {isNew && (
          <Field label="קוד כניסה" hint="השאר ריק ליצירת קוד מאובטח אוטומטית (8 תווים)">
            <Input dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="אוטומטי" className="font-mono tracking-widest" />
          </Field>
        )}
        <Field label="תאריך הצטרפות">
          <Input type="date" value={f.joined_at || ''} onChange={set('joined_at')} />
        </Field>
        <Field label="תאריך סיום מנוי" hint="ריק = ללא הגבלה">
          <Input type="date" value={f.sub_end || ''} onChange={set('sub_end')} />
        </Field>
        <Field label="מחיר חודשי (₪)">
          <Input type="number" min={0} value={f.price ?? ''} onChange={set('price')} />
        </Field>
        <Field label="מקסימום מכשירי WhatsApp">
          <Input type="number" min={1} value={f.max_arms ?? ''} onChange={set('max_arms')} />
        </Field>
        <Field label="סטטוס תחנה">
          <Select value={f.status || 'active'} onChange={set('status')}>
            <option value="active">פעילה</option>
            <option value="suspended">מושעית</option>
          </Select>
        </Field>
        <div className="md:col-span-2">
          <Field label="הערות (רק אתה רואה)">
            <Textarea rows={2} value={f.notes || ''} onChange={set('notes')} />
          </Field>
        </div>
      </div>
      {isNew && (
        <p className="mt-4 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-900">
          התחנה תקבל מערכת ריקה ונפרדת לגמרי: חיבורי WhatsApp, קבוצות, רשימות, הגדרות, מפעילים והיסטוריה משלה. מוכן מראש: מילת ההפעלה "עזרה" ותבנית שמוסיפה את מספר המבקש.
        </p>
      )}
    </Modal>
  );
}

function ShowCode({ value, onClose }: { value: { name: string; code: string } | null; onClose: () => void }) {
  const link = typeof window !== 'undefined' ? window.location.origin + '/login' : '';
  const msg = value ? `קוד הכניסה של ${value.name}: ${value.code}\nכניסה: ${link}` : '';
  return (
    <Modal
      open={!!value}
      onClose={onClose}
      title="קוד הכניסה של התחנה"
      footer={
        <Button
          onClick={() => {
            navigator.clipboard?.writeText(msg);
            toast('הועתק');
          }}
        >
          <Copy className="h-4 w-4" />
          העתק הודעה למנהל התחנה
        </Button>
      }
    >
      <div className="text-center">
        <div className="text-sm text-slate-500">{value?.name}</div>
        <div dir="ltr" className="my-4 select-all rounded-2xl bg-slate-900 py-5 font-mono text-3xl font-bold tracking-[0.35em] text-white">
          {value?.code}
        </div>
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          שמור את הקוד עכשיו – מטעמי אבטחה הוא נשמר מוצפן ולא יוצג שוב. אם יאבד, צור קוד חדש.
        </p>
      </div>
    </Modal>
  );
}

function ChangeCode({ station, onClose, onDone }: { station: Row | null; onClose: () => void; onDone: (code: string) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setCode(''), [station]);
  async function go() {
    setBusy(true);
    const { data, error } = await sb().rpc('station_set_code', { p_id: station!.id, p_code: code || null });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    onDone(data as string);
  }
  async function logoutAll() {
    const { error } = await sb().rpc('station_logout_all', { p_id: station!.id });
    if (error) return toast(error.message, 'error');
    toast('כל המכשירים של התחנה נותקו');
    onClose();
  }
  return (
    <Modal
      open={!!station}
      onClose={onClose}
      title={`שינוי קוד כניסה – ${station?.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={logoutAll}>
            רק לנתק את כולם
          </Button>
          <Button onClick={go} loading={busy}>
            <KeyRound className="h-4 w-4" />
            יצירת קוד חדש
          </Button>
        </>
      }
    >
      <Field label="קוד חדש" hint="השאר ריק ליצירת קוד אוטומטי">
        <Input dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="אוטומטי" className="font-mono tracking-widest" />
      </Field>
      <p className="mt-3 text-sm text-slate-500">הקוד הקודם יפסיק לעבוד מיד, וכל מי שמחובר עם הקוד הקודם ינותק.</p>
    </Modal>
  );
}

function Extend({ station, onClose, onDone }: { station: Row | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  async function go(months: number) {
    setBusy(months);
    const { data, error } = await sb().rpc('station_extend', { p_id: station!.id, p_months: months });
    setBusy(null);
    if (error) return toast(error.message, 'error');
    toast(`המנוי הוארך עד ${fmtDate(data as string)}`);
    onClose();
    onDone();
  }
  const base = station?.sub_end && (daysLeft(station.sub_end) ?? 0) >= 0 ? station.sub_end : today();
  return (
    <Modal open={!!station} onClose={onClose} title={`הארכת מנוי – ${station?.name}`}>
      <p className="mb-4 text-sm text-slate-600">
        המנוי הנוכחי: <b>{station?.sub_end ? fmtDate(station.sub_end) : 'ללא הגבלה'}</b>. הארכה מפעילה מחדש תחנה מושעית.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {[1, 3, 6, 12].map((m) => (
          <button
            key={m}
            onClick={() => go(m)}
            disabled={busy !== null}
            className="rounded-2xl border border-slate-200 p-4 text-right transition hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50"
          >
            <div className="font-semibold">{m === 1 ? 'חודש' : m === 12 ? 'שנה' : `${m} חודשים`}</div>
            <div className="text-xs text-slate-500">עד {fmtDate(addMonths(base, m))}</div>
            {station?.price != null && <div className="mt-1 text-xs text-indigo-700">{money(Number(station.price) * m)}</div>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function Delete({ station, onClose, onDone }: { station: Row | null; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setTyped(''), [station]);
  async function go() {
    setBusy(true);
    const { error } = await sb().from('stations').delete().eq('id', station!.id);
    setBusy(false);
    if (error) return toast(error.message, 'error');
    toast('התחנה נמחקה');
    onClose();
    onDone();
  }
  return (
    <Modal
      open={!!station}
      onClose={onClose}
      title="מחיקת תחנה"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button variant="danger" onClick={go} loading={busy} disabled={typed.trim() !== station?.name.trim()}>
            <Trash2 className="h-4 w-4" />
            מחיקה לצמיתות
          </Button>
        </>
      }
    >
      <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">
        כל הנתונים של <b>{station?.name}</b> יימחקו לצמיתות: חיבורי WhatsApp (המכשירים ינותקו), קבוצות, רשימות, הגדרות, מפעילים וכל ההיסטוריה. אי אפשר לבטל את זה.
      </p>
      <div className="mt-4">
        <Field label={`כדי לאשר, הקלד את שם התחנה: ${station?.name}`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
