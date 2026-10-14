'use client';
import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, UserPlus } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Card, Field, Input, Modal, Select, Toggle, toast } from '@/components/ui';

// People with a personal login code: the owner adds a name (+ phone, station) and the system makes the code.
// The code gives station-manager rights in that station – never owner rights.

type Member = {
  id: string;
  station_id: string;
  station_name: string;
  is_home: boolean;
  name: string;
  phone: string | null;
  code_hint: string | null;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
};

export function TeamCodes() {
  const [rows, setRows] = useState<Member[] | null>(null);
  const [stations, setStations] = useState<{ id: string; name: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<{ name: string; code: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('owner_members');
    if (error) {
      setRows([]);
      return;
    }
    setRows((data as Member[]) || []);
  }, []);
  useEffect(() => {
    load();
    sb()
      .rpc('stations_overview')
      .then(({ data }) => setStations(((data as any[]) || []).map((s) => ({ id: s.id, name: s.name }))));
  }, [load]);

  async function newCode(m: Member) {
    if (!confirm(`ליצור קוד חדש ל${m.name}? הקוד הישן יפסיק לעבוד והוא ינותק.`)) return;
    const { data, error } = await sb().rpc('owner_member_new_code', { p_id: m.id });
    if (error) return toast(error.message, 'error');
    await logAct('member_new_code', 'member', m.id, { name: m.name });
    setShown({ name: m.name, code: data as string });
    load();
  }

  async function setActive(m: Member, v: boolean) {
    const { error } = await sb().rpc('owner_member_set_active', { p_id: m.id, p_active: v });
    if (error) return toast(error.message, 'error');
    await logAct(v ? 'member_on' : 'member_off', 'member', m.id, { name: m.name });
    toast(v ? 'הקוד פעיל שוב' : 'הגישה נחסמה והוא נותק');
    load();
  }

  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
          <KeyRound className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-semibold">אנשים עם קוד כניסה</div>
          <div className="text-slate-600">מוסיפים אדם, והמערכת יוצרת לו קוד אישי. הוא נכנס עם הקוד כמנהל התחנה שבחרת – בלי גישה לתחנות, לתשלומים ולניהול העדכונים.</div>
        </div>
        <Button onClick={() => setAdding(true)}>
          <UserPlus className="h-4 w-4" />
          הוספת אדם
        </Button>
      </div>
      {rows && rows.length === 0 && <div className="px-5 py-6 text-center text-sm text-slate-500">עוד לא הוספת אף אחד.</div>}
      <ul className="divide-y divide-slate-100">
        {(rows || []).map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <div className="min-w-40 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-medium">
                {m.name}
                <Badge>{m.is_home ? 'המערכת שלי' : m.station_name}</Badge>
                {!m.is_active && <Badge tone="amber">חסום</Badge>}
              </div>
              <div className="text-xs text-slate-500">
                <span dir="ltr">קוד: •••••••{m.code_hint}</span>
                {m.phone && <span dir="ltr"> · {m.phone}</span>}
                {' · '}
                {m.last_login_at ? `נכנס ${timeAgo(m.last_login_at)}` : 'עוד לא נכנס'}
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => newCode(m)}>
              קוד חדש
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{m.is_active ? 'פעיל' : 'חסום'}</span>
              <Toggle checked={m.is_active} onChange={(v) => setActive(m, v)} />
            </div>
          </li>
        ))}
      </ul>

      {adding && (
        <AddMember
          stations={stations}
          onClose={() => setAdding(false)}
          onAdded={(name, code) => {
            setAdding(false);
            setShown({ name, code });
            load();
          }}
        />
      )}

      <Modal open={!!shown} onClose={() => setShown(null)} title={`הקוד של ${shown?.name || ''}`}>
        <div className="space-y-4">
          <div className="rounded-2xl bg-slate-50 py-5 text-center font-mono text-3xl font-bold tracking-[0.25em]" dir="ltr">
            {shown?.code}
          </div>
          <p className="text-sm text-slate-600">שמור או שלח אותו עכשיו – אחרי הסגירה רואים רק את 2 התווים האחרונים. נכנסים במסך הכניסה, בתיבה ״קוד גישה״.</p>
          <Button
            className="w-full"
            onClick={() => {
              navigator.clipboard?.writeText(`הקוד שלך לכניסה למערכת: ${shown?.code}\n${window.location.origin}/login`);
              toast('הועתק');
            }}
          >
            <Copy className="h-4 w-4" />
            העתקת הקוד עם קישור הכניסה
          </Button>
        </div>
      </Modal>
    </Card>
  );
}

function AddMember({
  stations,
  onClose,
  onAdded,
}: {
  stations: { id: string; name: string }[];
  onClose: () => void;
  onAdded: (name: string, code: string) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [station, setStation] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return toast('כתוב שם', 'error');
    setBusy(true);
    const { data, error } = await sb().rpc('owner_member_add', { p_station: station || null, p_name: name, p_phone: phone });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    await logAct('member_added', 'member', (data as any)?.id, { name, station: station || 'home' });
    onAdded(name.trim(), (data as any).code);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="הוספת אדם"
      footer={
        <Button onClick={save} loading={busy} className="w-full">
          הוספה ויצירת קוד
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="שם">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="טלפון" hint="לא חובה">
          <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        </Field>
        <Field label="נכנס אל">
          <Select value={station} onChange={(e) => setStation(e.target.value)}>
            <option value="">המערכת שלי</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
