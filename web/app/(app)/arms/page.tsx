'use client';
import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Plus, QrCode, KeyRound, Power, PlugZap, RefreshCw, Trash2, Pencil, Smartphone, Loader2, Flame, ChevronDown, Gauge } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth, myUid } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { armHealth, limitReached, type ArmHealth } from '@/lib/armHealth';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Empty, Field, Input, Lamp, Modal, PageHeader, Select, Skeleton, Textarea, Toggle, ask, cx, toast } from '@/components/ui';
import { useInbox } from '@/components/StationInbox';
import { allGroups } from '@/lib/allRows';

const WARMUP_MS = 24 * 60 * 60_000;
/** A new number sends slowly (6 msgs/min) for 24h after linking, so WhatsApp does not flag it. */
const warmupUntil = (a: { linked_at?: string | null }) => {
  const t = a.linked_at ? Date.parse(a.linked_at) + WARMUP_MS : 0;
  return t > Date.now() ? new Date(t) : null;
};
const hhmm = (d: Date) => d.toLocaleString('he-IL', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export default function ArmsPage() {
  return (
    <RequireRole min="admin">
      <Arms />
    </RequireRole>
  );
}

const HEALTH_BOX: Record<ArmHealth['level'], string> = {
  ok: 'bg-emerald-50/70 ring-emerald-600/15',
  warn: 'bg-amber-50/80 ring-amber-600/20',
  bad: 'bg-rose-50/80 ring-rose-600/20',
  action: 'bg-sky-50/80 ring-sky-600/20',
};

function Arms() {
  const { profile, station } = useAuth();
  // stations have a number of arms in their plan; past it they ask the system owner for more
  const { inbox, reload: reloadInbox } = useInbox(!!station && !station.is_home);
  const atLimit = !!inbox && inbox.arms.max != null && inbox.arms.count >= inbox.arms.max;
  const [asking, setAsking] = useState(false);
  const [arms, setArms] = useState<any[] | null>(null);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const load = useCallback(async () => {
    const [a, q, g] = await Promise.all([
      sb().from('arms').select('*').order('created_at'), // rows: bounded – the arms of one station
      sb().from('arm_qr').select('*'), // rows: bounded – one QR per arm
      allGroups('arm_id'),
    ]);
    setArms(a.data || []);
    setQr(Object.fromEntries((q.data || []).map((r: any) => [r.arm_id, r.qr])));
    const c: Record<string, number> = {};
    for (const r of g.data || []) c[r.arm_id] = (c[r.arm_id] || 0) + 1;
    setGroups(c);
  }, []);

  // recent send errors per arm (last 2 hours, only those not fixed by a later send) – once a minute is enough
  const loadFailed = useCallback(async () => {
    const { data, error } = await sb().rpc('group_problems', { p_hours: 2 });
    if (error) return;
    const f: Record<string, number> = {};
    for (const p of (data as any[]) || []) if (p.arm_id && p.reason === 'send_error') f[p.arm_id] = (f[p.arm_id] || 0) + (p.n || 1);
    setFailed(f);
  }, []);

  useEffect(() => {
    load();
    loadFailed();
    const iv = setInterval(loadFailed, 60_000);
    return () => clearInterval(iv);
  }, [load, loadFailed]);
  useRealtime(['arms', 'arm_qr', 'groups'], load);

  const [pairFor, setPairFor] = useState<any>(null);
  const [pairPhone, setPairPhone] = useState('');
  async function sendPair() {
    const digits = pairPhone.replace(/\D/g, '');
    if (!/^0?5\d{8}$/.test(digits) && !/^9725\d{8}$/.test(digits)) return toast('מספר טלפון לא תקין – לדוגמה 050-1234567', 'error');
    const intl = digits.startsWith('972') ? digits : '972' + digits.replace(/^0/, '');
    await command(pairFor, `pair:${intl}`, 'מבקש קוד חיבור…');
    setPairFor(null);
    setPairPhone('');
  }

  async function command(arm: any, command: string, label: string) {
    const { error } = await sb().from('arm_commands').insert({ arm_id: arm.id, command, created_by: myUid(profile) });
    if (error) return toast(error.message, 'error');
    toast(label);
  }

  async function setActive(arm: any, is_active: boolean) {
    if (!is_active && !(await ask({ title: `לנתק את "${arm.name}"?`, text: 'הזרוע תפסיק לשלוח הודעות עד שתחבר אותה שוב. החיבור לטלפון נשמר.', ok: 'ניתוק' })))
      return;
    const { error } = await sb()
      .from('arms')
      .update(is_active ? { is_active, status: 'connecting' } : { is_active })
      .eq('id', arm.id);
    if (error) return toast(error.message, 'error');
    await logAct(is_active ? 'arm_resumed' : 'arm_paused', 'arm', arm.id, { name: arm.name });
    toast(is_active ? 'הזרוע מתחברת…' : 'הזרוע נותקה');
  }

  async function remove(arm: any) {
    if (
      !(await ask({
        title: `למחוק את "${arm.name}"?`,
        text: 'החיבור ל-WhatsApp יתנתק וההיסטוריה של הזרוע תישאר.',
        ok: 'מחיקת הזרוע',
        danger: true,
      }))
    )
      return;
    const { error } = await sb().from('arms').delete().eq('id', arm.id);
    if (error) return toast(error.message, 'error');
    await logAct('arm_deleted', 'arm', arm.id, { name: arm.name });
    toast('הזרוע נמחקה');
  }

  const header = (
    <PageHeader
      title="זרועות"
      subtitle="כל זרוע היא מספר WhatsApp שמחובר לשרת 24/7 ושולח את הנסיעות לקבוצות"
      actions={
        arms &&
        (atLimit ? (
          inbox?.arm_request ? (
            <Badge tone="amber">ביקשת עוד {inbox.arm_request.count} – ממתין לאישור מנהל המערכת</Badge>
          ) : (
            <Button onClick={() => setAsking(true)}>
              <Plus className="h-4 w-4" />
              בקשת זרוע נוספת
            </Button>
          )
        ) : (
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            הוספת זרוע
          </Button>
        ))
      }
    />
  );

  if (!arms)
    return (
      <>
        {header}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label="טוען">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-72 rounded-2xl" />
          ))}
        </div>
      </>
    );

  const healths = arms.map((a) => armHealth(a, { failedRecent: failed[a.id], hasQr: !!qr[a.id], pairing: !!qr[a.id]?.startsWith('PAIR:') }));
  const okCount = healths.filter((h) => h.level === 'ok').length;

  return (
    <>
      {header}

      {arms.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
          <span className="flex items-center gap-2">
            <Lamp tone={okCount === arms.length ? 'green' : okCount === 0 ? 'red' : 'amber'} />
            <b className="tabular-nums text-slate-900">
              {okCount}/{arms.length}
            </b>
            זרועות פועלות כרגיל
          </span>
          {okCount < arms.length && <span className="text-slate-500">לכל זרוע עם בעיה מופיע מה לעשות</span>}
        </div>
      )}

      {arms.length === 0 ? (
        <Card>
          <Empty
            icon={<Smartphone className="h-7 w-7" />}
            title="עדיין אין זרועות"
            text="הוסף זרוע, סרוק את קוד ה-QR מהטלפון (WhatsApp ← מכשירים מקושרים ← קישור מכשיר), והיא תתחבר ותתחיל לשלוח."
            action={
              <Button onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" />
                הוספת זרוע ראשונה
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {arms.map((a, i) => (
            <ArmCard
              key={a.id}
              a={a}
              n={i + 1}
              h={healths[i]}
              qr={qr[a.id]}
              groups={groups[a.id] || 0}
              onCommand={(c, l) => command(a, c, l)}
              onPair={() => {
                setPairPhone(a.phone || '');
                setPairFor(a);
              }}
              onActive={(v) => setActive(a, v)}
              onEdit={() => setEditing(a)}
              onRemove={() => remove(a)}
            />
          ))}
        </div>
      )}

      <Modal
        open={!!pairFor}
        onClose={() => setPairFor(null)}
        title={`חיבור עם קוד – ${pairFor?.name || ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPairFor(null)}>
              ביטול
            </Button>
            <Button onClick={sendPair}>
              <KeyRound className="h-4 w-4" /> קבלת קוד
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="מספר הטלפון של הוואטסאפ שמחברים" hint="המספר של הטלפון שעליו תקליד את הקוד">
            <Input dir="ltr" inputMode="tel" placeholder="050-1234567" value={pairPhone} onChange={(e) => setPairPhone(e.target.value)} autoFocus />
          </Field>
          <p className="text-sm leading-relaxed text-slate-600">
            תוך כמה שניות יופיע כאן בכרטיס של הזרוע קוד של 8 תווים. אם הזרוע כבר מחוברת למספר אחר, החיבור הקודם יוחלף.
          </p>
        </div>
      </Modal>

      <AddArm open={adding} onClose={() => setAdding(false)} next={arms.length + 1} />
      <RequestArms
        open={asking}
        max={inbox?.arms.max ?? null}
        onClose={() => setAsking(false)}
        onDone={() => {
          setAsking(false);
          reloadInbox();
        }}
      />
      <EditArm arm={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function ArmCard({
  a,
  n,
  h,
  qr,
  groups,
  onCommand,
  onPair,
  onActive,
  onEdit,
  onRemove,
}: {
  a: any;
  n: number;
  h: ArmHealth;
  qr?: string;
  groups: number;
  onCommand: (command: string, label: string) => void;
  onPair: () => void;
  onActive: (v: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [tech, setTech] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = a.sent_day === today ? a.sent_today : 0;
  const capped = limitReached(a);
  const warm = warmupUntil(a);
  const needsScan = h.level === 'action' && a.status !== 'connecting';
  const rescan = /QR/.test(h.action || '');

  // the one thing to do now
  let primary: React.ReactNode = null;
  if (!a.is_active) {
    primary = (
      <Button variant="success" onClick={() => onActive(true)}>
        <PlugZap className="h-4 w-4" />
        חיבור
      </Button>
    );
  } else if (needsScan && !qr) {
    primary = (
      <span className="flex flex-wrap gap-2">
        <Button onClick={() => onCommand('reset', 'מייצר QR חדש…')}>
          <QrCode className="h-4 w-4" />
          QR חדש
        </Button>
        <Button variant="secondary" onClick={onPair}>
          <KeyRound className="h-4 w-4" />
          חיבור עם קוד
        </Button>
      </span>
    );
  } else if (h.level === 'bad') {
    primary = rescan ? (
      <span className="flex flex-wrap gap-2">
        <Button onClick={() => onCommand('reset', 'מייצר QR חדש…')}>
          <QrCode className="h-4 w-4" />
          QR חדש
        </Button>
        <Button variant="secondary" onClick={onPair}>
          <KeyRound className="h-4 w-4" />
          חיבור עם קוד
        </Button>
      </span>
    ) : (
      <Button onClick={() => onCommand('connect', 'מתחבר מחדש…')}>
        <PlugZap className="h-4 w-4" />
        חיבור מחדש
      </Button>
    );
  } else if (capped) {
    primary = (
      <Button variant="secondary" onClick={onEdit}>
        <Gauge className="h-4 w-4" />
        שינוי המגבלה היומית
      </Button>
    );
  }

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 font-semibold tabular-nums text-slate-600">{n}</div>
          <div className="min-w-0">
            <div className="truncate font-semibold text-slate-900">{a.name}</div>
            <div className="text-sm tabular-nums text-slate-500" dir="ltr" style={{ textAlign: 'right' }}>
              {a.phone || 'עדיין לא מקושר לטלפון'}
            </div>
          </div>
        </div>
        <Lamp tone={h.tone} pulse={h.level === 'bad' || a.status === 'connecting'} />
      </div>

      {/* status in plain words */}
      <div className={cx('mx-5 mb-4 rounded-xl px-4 py-3 ring-1 ring-inset', HEALTH_BOX[h.level])}>
        <div className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
          {a.status === 'connecting' && <Loader2 className="h-4 w-4 animate-spin text-sky-600" />}
          {h.title}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-slate-700">{h.explain}</p>
        {h.action && <p className="mt-1.5 text-sm leading-relaxed text-slate-900">
          <span className="font-medium">מה לעשות: </span>
          {h.action}
        </p>}
        {primary && <div className="mt-3">{primary}</div>}
        {h.raw && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setTech(!tech)}
              aria-expanded={tech}
              className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"
            >
              פרטים טכניים
              <ChevronDown className={cx('h-3.5 w-3.5 transition', tech && 'rotate-180')} />
            </button>
            {tech && (
              <pre dir="ltr" className="mt-1.5 whitespace-pre-wrap break-all rounded-lg bg-white/70 p-2 text-left text-[11px] leading-relaxed text-slate-600">
                {h.raw}
              </pre>
            )}
          </div>
        )}
      </div>

      {a.status === 'qr' && qr?.startsWith('PAIR:') && (
        <div className="mx-5 mb-4 flex flex-col items-center rounded-2xl bg-slate-50 p-4">
          <div className="text-xs text-slate-500">קוד החיבור</div>
          <div dir="ltr" className="mt-1 select-all rounded-xl bg-white px-5 py-3 font-mono text-3xl font-bold tracking-[0.2em] text-slate-900 shadow-sm">
            {qr.slice(5)}
          </div>
          <p className="mt-3 text-center text-xs leading-relaxed text-slate-600">
            בטלפון: WhatsApp ← הגדרות ← מכשירים מקושרים ← קישור מכשיר ← &quot;קישור באמצעות מספר טלפון&quot;, והקלד את הקוד.
            <br />
            הקוד תקף כמה דקות.
          </p>
        </div>
      )}
      {a.status === 'qr' && qr && !qr.startsWith('PAIR:') && (
        <div className="mx-5 mb-4 flex flex-col items-center rounded-2xl bg-slate-50 p-4">
          <div className="rounded-xl bg-white p-3 shadow-sm">
            <QRCodeSVG value={qr} size={200} />
          </div>
          <p className="mt-3 text-center text-xs leading-relaxed text-slate-600">
            בטלפון: WhatsApp ← הגדרות ← מכשירים מקושרים ← קישור מכשיר, וסרוק את הקוד.
            <br />
            הקוד מתחלף אוטומטית.
          </p>
          <button type="button" onClick={onPair} className="mt-2 flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:underline">
            <KeyRound className="h-4 w-4" /> אין אפשרות לסרוק? חיבור עם קוד במקום
          </button>
        </div>
      )}
      {a.status === 'qr' && !qr && (
        <div className="mx-5 mb-4 flex items-center justify-center gap-2 rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          מכין קוד QR…
        </div>
      )}
      {warm && (
        <div className="mx-5 mb-4 flex items-start gap-2 rounded-xl bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-900">
          <Flame className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          בחימום עד {hhmm(warm)} – שולחת לאט (6 הודעות בדקה) כדי להגן על המספר
        </div>
      )}

      <dl className="mx-5 mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-slate-50 py-2">
          <dt className="text-[11px] text-slate-500">קבוצות</dt>
          <dd className="font-semibold tabular-nums">{groups.toLocaleString('he-IL')}</dd>
        </div>
        <div className={cx('rounded-xl py-2', capped ? 'bg-rose-50' : 'bg-slate-50')}>
          <dt className="text-[11px] text-slate-500">נשלחו היום</dt>
          <dd className="font-semibold tabular-nums">
            {sentToday}
            <span className="text-xs font-normal text-slate-400">/{a.daily_limit >= 100000 ? '∞' : a.daily_limit}</span>
          </dd>
        </div>
        <div className="rounded-xl bg-slate-50 py-2">
          <dt className="text-[11px] text-slate-500">סה״כ נשלחו</dt>
          <dd className="font-semibold tabular-nums">{Number(a.sent_total || 0).toLocaleString('he-IL')}</dd>
        </div>
      </dl>
      <div className="mx-5 mb-4 text-xs text-slate-500">
        חיבור אחרון: {timeAgo(a.last_connected_at)} · נראתה לאחרונה: {timeAgo(a.last_seen_at)}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-slate-100 bg-slate-50/50 p-3">
        {a.is_active ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => onCommand('reset', 'מייצר QR חדש…')}>
              <QrCode className="h-4 w-4" />
              QR חדש
            </Button>
            <Button size="sm" variant="secondary" onClick={onPair}>
              <KeyRound className="h-4 w-4" />
              חיבור עם קוד
            </Button>
            {a.status === 'online' && (
              <Button size="sm" variant="secondary" onClick={() => onCommand('refresh_groups', 'מרענן קבוצות…')}>
                <RefreshCw className="h-4 w-4" />
                רענון קבוצות
              </Button>
            )}
            {['offline', 'error', 'paused'].includes(a.status) && (
              <Button size="sm" variant="secondary" onClick={() => onCommand('connect', 'מתחבר מחדש…')}>
                <PlugZap className="h-4 w-4" />
                חיבור מחדש
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onActive(false)}>
              <Power className="h-4 w-4" />
              ניתוק
            </Button>
          </>
        ) : (
          <Button size="sm" variant="success" onClick={() => onActive(true)}>
            <PlugZap className="h-4 w-4" />
            חיבור
          </Button>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onEdit} title="עריכה" aria-label={`עריכת ${a.name}`}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="ghost" className="text-rose-600" onClick={onRemove} title="מחיקה" aria-label={`מחיקת ${a.name}`}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

function RequestArms({ open, max, onClose, onDone }: { open: boolean; max: number | null; onClose: () => void; onDone: () => void }) {
  const [count, setCount] = useState(1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setCount(1);
      setNote('');
    }
  }, [open]);
  async function send() {
    setBusy(true);
    const { error } = await sb().rpc('station_request_arms', { p_count: count, p_note: note || null });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    toast('הבקשה נשלחה למנהל המערכת');
    onDone();
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="בקשת זרוע נוספת"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={send} loading={busy}>
            שליחת בקשה
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-600">
        החבילה שלך כוללת {max ?? '—'} זרועות, וכולן בשימוש. מנהל המערכת יקבל את הבקשה, ואחרי אישור יופיע כאן כפתור להוספה.
      </p>
      <div className="grid gap-4">
        <Field label="כמה זרועות נוספות">
          <Select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="הערה למנהל (אופציונלי)">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-0" />
        </Field>
      </div>
    </Modal>
  );
}

function AddArm({ open, onClose, next }: { open: boolean; onClose: () => void; next: number }) {
  const { profile } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(`זרוע ${next}`);
  }, [open, next]);

  async function save() {
    setBusy(true);
    const { data, error } = await sb().from('arms').insert({ name: name.trim(), created_by: myUid(profile) }).select().single();
    setBusy(false);
    if (error) return toast(error.message, 'error');
    await logAct('arm_added', 'arm', data.id, { name: data.name });
    toast('הזרוע נוספה – קוד QR יופיע בעוד כמה שניות');
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="זרוע חדשה"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>
            הוסף וצור QR
          </Button>
        </>
      }
    >
      <Field label="שם הזרוע" hint="לדוגמה: זרוע 1, מספר עבודה, אשדוד">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <p className="mt-4 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-900">
        מומלץ להשתמש במספר ייעודי ולא במספר האישי שלך: שליחה לקבוצות רבות עלולה לגרום ל-WhatsApp לחסום את המספר.
      </p>
    </Modal>
  );
}

function EditArm({ arm, onClose }: { arm: any; onClose: () => void }) {
  const [name, setName] = useState('');
  const [limit, setLimit] = useState(300);
  const [warm, setWarm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (arm) {
      setName(arm.name);
      setLimit(arm.daily_limit);
      setWarm(!!warmupUntil(arm));
    }
  }, [arm]);

  async function save() {
    setBusy(true);
    const wasWarm = !!warmupUntil(arm);
    const patch: any = { name: name.trim(), daily_limit: limit };
    // switching warm-up on starts a fresh 24 hours; switching it off ends it now. The engine picks it up within a minute.
    if (warm !== wasWarm) patch.linked_at = warm ? new Date().toISOString() : null;
    const { error } = await sb().from('arms').update(patch).eq('id', arm.id);
    if (!error && warm !== wasWarm) await logAct(warm ? 'arm_warmup_on' : 'arm_warmup_off', 'arm', arm.id, { name: arm.name });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    toast('נשמר');
    onClose();
  }

  return (
    <Modal
      open={!!arm}
      onClose={onClose}
      title="עריכת זרוע"
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
      <div className="space-y-4">
        <Field label="שם">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="מקסימום הודעות ביום לזרוע" hint="כשמגיעים לתקרה, הזרוע עוצרת עד מחר והשאר ממשיכות. אפשר לבחור כל מספר.">
          <Input type="number" min={1} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {[300, 500, 1000, 2000, 5000, 1000000].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setLimit(n)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${limit === n ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`}
            >
              {n === 1000000 ? 'ללא הגבלה' : n}
            </button>
          ))}
        </div>
        <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 p-3">
          <div className="text-sm">
            <div className="font-medium">חימום מספר חדש</div>
            <div className="text-xs text-slate-500">
              {warm && warmupUntil(arm)
                ? `פעיל עד ${hhmm(warmupUntil(arm)!)}. `
                : ''}
              24 שעות של שליחה איטית (6 הודעות בדקה) כדי ש-WhatsApp לא יחסום מספר חדש. כיבוי – הזרוע שולחת בקצב הרגיל תוך דקה.
            </div>
          </div>
          <Toggle checked={warm} onChange={setWarm} />
        </div>
        {limit > 500 && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            מעל 500 הודעות ביום ממספר אחד הסיכון לחסימה עולה. מומלץ לחלק בין כמה זרועות, ולהשאיר המתנה של לפחות 8 שניות בין הודעות.
          </p>
        )}
      </div>
    </Modal>
  );
}
