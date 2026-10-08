'use client';
import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Plus, QrCode, Power, PlugZap, RefreshCw, Trash2, Pencil, Smartphone, Loader2 } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { ARM_STATUS, timeAgo } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Spinner, toast } from '@/components/ui';

export default function ArmsPage() {
  return (
    <RequireRole min="admin">
      <Arms />
    </RequireRole>
  );
}

function Arms() {
  const { profile } = useAuth();
  const [arms, setArms] = useState<any[] | null>(null);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const load = useCallback(async () => {
    const [a, q, g] = await Promise.all([
      sb().from('arms').select('*').order('created_at'),
      sb().from('arm_qr').select('*'),
      sb().from('groups').select('arm_id'),
    ]);
    setArms(a.data || []);
    setQr(Object.fromEntries((q.data || []).map((r: any) => [r.arm_id, r.qr])));
    const c: Record<string, number> = {};
    for (const r of g.data || []) c[r.arm_id] = (c[r.arm_id] || 0) + 1;
    setGroups(c);
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['arms', 'arm_qr', 'groups'], load);

  async function command(arm: any, command: string, label: string) {
    const { error } = await sb().from('arm_commands').insert({ arm_id: arm.id, command, created_by: profile?.id });
    if (error) return toast(error.message, 'error');
    toast(label);
  }

  async function setActive(arm: any, is_active: boolean) {
    const { error } = await sb()
      .from('arms')
      .update(is_active ? { is_active, status: 'connecting' } : { is_active })
      .eq('id', arm.id);
    if (error) return toast(error.message, 'error');
    await logAct(is_active ? 'arm_resumed' : 'arm_paused', 'arm', arm.id, { name: arm.name });
    toast(is_active ? 'הזרוע מתחברת…' : 'הזרוע נותקה');
  }

  async function remove(arm: any) {
    if (!confirm(`למחוק את "${arm.name}"? החיבור ל-WhatsApp יתנתק וההיסטוריה של הזרוע תישאר.`)) return;
    const { error } = await sb().from('arms').delete().eq('id', arm.id);
    if (error) return toast(error.message, 'error');
    await logAct('arm_deleted', 'arm', arm.id, { name: arm.name });
    toast('הזרוע נמחקה');
  }

  if (!arms) return <Spinner />;

  return (
    <>
      <PageHeader
        title="חיבור זרועות"
        subtitle="כל זרוע היא מספר WhatsApp עצמאי שמחובר לשרת 24/7"
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            הוסף זרוע
          </Button>
        }
      />

      {arms.length === 0 ? (
        <Card>
          <Empty
            icon={<Smartphone className="h-7 w-7" />}
            title="עדיין אין זרועות"
            text="הוסף זרוע, סרוק את קוד ה-QR מהטלפון (WhatsApp ← מכשירים מקושרים ← קישור מכשיר), והיא תתחבר."
            action={
              <Button onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" />
                הוסף זרוע ראשונה
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {arms.map((a, i) => {
            const st = ARM_STATUS[a.status] || ARM_STATUS.pending;
            const today = new Date().toISOString().slice(0, 10);
            return (
              <Card key={a.id} className="flex flex-col overflow-hidden">
                <div className="flex items-start justify-between gap-3 p-5">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="brand-gradient grid h-11 w-11 shrink-0 place-items-center rounded-xl font-bold text-white">{i + 1}</div>
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{a.name}</div>
                      <div className="text-sm text-slate-500" dir="ltr" style={{ textAlign: 'right' }}>
                        {a.phone || 'לא מחובר'}
                      </div>
                    </div>
                  </div>
                  <Badge tone={st.tone} dot>
                    {st.label}
                  </Badge>
                </div>

                {a.status === 'qr' && qr[a.id] && (
                  <div className="mx-5 mb-4 flex flex-col items-center rounded-2xl bg-slate-50 p-4">
                    <div className="rounded-xl bg-white p-3 shadow-sm">
                      <QRCodeSVG value={qr[a.id]} size={200} />
                    </div>
                    <p className="mt-3 text-center text-xs leading-relaxed text-slate-600">
                      בטלפון: WhatsApp ← הגדרות ← מכשירים מקושרים ← קישור מכשיר, וסרוק את הקוד.
                      <br />
                      הקוד מתחלף אוטומטית.
                    </p>
                  </div>
                )}
                {(a.status === 'connecting' || (a.status === 'qr' && !qr[a.id])) && (
                  <div className="mx-5 mb-4 flex items-center justify-center gap-2 rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    מתחבר לשרת…
                  </div>
                )}
                {a.last_error && a.status !== 'online' && (
                  <div className="mx-5 mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">{a.last_error}</div>
                )}

                <dl className="mx-5 mb-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-slate-50 py-2">
                    <dt className="text-[11px] text-slate-500">קבוצות</dt>
                    <dd className="font-semibold tabular-nums">{groups[a.id] || 0}</dd>
                  </div>
                  <div className={`rounded-xl py-2 ${a.sent_day === today && a.sent_today >= a.daily_limit ? 'bg-rose-50' : 'bg-slate-50'}`}>
                    <dt className="text-[11px] text-slate-500">היום</dt>
                    <dd className="font-semibold tabular-nums">
                      {a.sent_day === today ? a.sent_today : 0}
                      <span className="text-xs font-normal text-slate-400">/{a.daily_limit >= 100000 ? '∞' : a.daily_limit}</span>
                    </dd>
                    {a.sent_day === today && a.sent_today >= a.daily_limit && (
                      <div className="text-[11px] font-semibold text-rose-700">הגיעה למגבלה – לא שולחת</div>
                    )}
                  </div>
                  <div className="rounded-xl bg-slate-50 py-2">
                    <dt className="text-[11px] text-slate-500">סה״כ נשלחו</dt>
                    <dd className="font-semibold tabular-nums">{Number(a.sent_total).toLocaleString('he-IL')}</dd>
                  </div>
                </dl>
                <div className="mx-5 mb-4 text-xs text-slate-500">
                  חיבור אחרון: {timeAgo(a.last_connected_at)} · נראתה לאחרונה: {timeAgo(a.last_seen_at)}
                </div>

                <div className="mt-auto flex flex-wrap gap-1.5 border-t border-slate-100 bg-slate-50/50 p-3">
                  {a.is_active ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => command(a, 'reset', 'מייצר QR חדש…')}>
                        <QrCode className="h-4 w-4" />
                        QR חדש
                      </Button>
                      {a.status === 'online' && (
                        <Button size="sm" variant="secondary" onClick={() => command(a, 'refresh_groups', 'מרענן קבוצות…')}>
                          <RefreshCw className="h-4 w-4" />
                          רענן קבוצות
                        </Button>
                      )}
                      {['offline', 'error'].includes(a.status) && (
                        <Button size="sm" variant="secondary" onClick={() => command(a, 'connect', 'מתחבר מחדש…')}>
                          <PlugZap className="h-4 w-4" />
                          חבר מחדש
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setActive(a, false)}>
                        <Power className="h-4 w-4" />
                        נתק
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="success" onClick={() => setActive(a, true)}>
                      <PlugZap className="h-4 w-4" />
                      חבר
                    </Button>
                  )}
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setEditing(a)} title="עריכה">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => remove(a)} title="מחיקה">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <AddArm open={adding} onClose={() => setAdding(false)} next={arms.length + 1} />
      <EditArm arm={editing} onClose={() => setEditing(null)} />
    </>
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
    const { data, error } = await sb().from('arms').insert({ name: name.trim(), created_by: profile?.id }).select().single();
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
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (arm) {
      setName(arm.name);
      setLimit(arm.daily_limit);
    }
  }, [arm]);

  async function save() {
    setBusy(true);
    const { error } = await sb().from('arms').update({ name: name.trim(), daily_limit: limit }).eq('id', arm.id);
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
        {limit > 500 && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            מעל 500 הודעות ביום ממספר אחד הסיכון לחסימה עולה. מומלץ לחלק בין כמה זרועות, ולהשאיר המתנה של לפחות 8 שניות בין הודעות.
          </p>
        )}
      </div>
    </Modal>
  );
}
