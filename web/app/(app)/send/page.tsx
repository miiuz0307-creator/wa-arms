'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Send, ListChecks, MousePointerClick, Check, Clock } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { ARM_STATUS } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { GroupPicker, mergeGroups } from '@/components/GroupPicker';
import { Badge, Button, Card, Checkbox, PageHeader, Select, Spinner, Textarea, cx, toast } from '@/components/ui';

export default function SendPage() {
  return (
    <RequireRole min="operator">
      <Wizard />
    </RequireRole>
  );
}

const STEPS = ['כתיבת הודעה', 'בחירת יעדים', 'סיכום ושליחה'];

function Wizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'list' | 'manual'>('manual');
  const [arms, setArms] = useState<any[] | null>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [armSel, setArmSel] = useState<Set<string>>(new Set());
  const [grpSel, setGrpSel] = useState<Set<string>>(new Set());
  const [listId, setListId] = useState('');
  const [listInfo, setListInfo] = useState<{ groups: string[]; arms: string[] }>({ groups: [], arms: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [a, g, l, s] = await Promise.all([
        sb().from('arms').select('*').eq('is_active', true).order('created_at'),
        sb().from('groups').select('arm_id,wa_group_id,name,participants').limit(5000),
        sb().from('distribution_lists').select('id,name').order('name'),
        sb().from('app_settings').select('*').eq('id', 1).single(),
      ]);
      setArms(a.data || []);
      setRows(g.data || []);
      setLists(l.data || []);
      setSettings(s.data);
      setArmSel(new Set((a.data || []).filter((x: any) => x.status === 'online').map((x: any) => x.id)));
      if (l.data?.length) setListId(l.data[0].id);
    })();
  }, []);

  useEffect(() => {
    if (!listId) return;
    Promise.all([
      sb().from('list_groups').select('wa_group_id').eq('list_id', listId),
      sb().from('list_arms').select('arm_id').eq('list_id', listId),
    ]).then(([g, a]) => setListInfo({ groups: (g.data || []).map((r: any) => r.wa_group_id), arms: (a.data || []).map((r: any) => r.arm_id) }));
  }, [listId]);

  const armNames = useMemo(() => Object.fromEntries((arms || []).map((a) => [a.id, a.name])), [arms]);
  const groups = useMemo(() => mergeGroups(rows, armNames, armSel), [rows, armNames, armSel]);

  // keep selected groups valid when arms change
  useEffect(() => {
    const valid = new Set(groups.map((g) => g.wa_group_id));
    setGrpSel((s) => new Set([...s].filter((x) => valid.has(x))));
  }, [groups]);

  if (!arms || !settings) return <Spinner />;

  const finalArms = mode === 'list' ? (listInfo.arms.length ? listInfo.arms : arms.map((a) => a.id)) : [...armSel];
  const finalGroups = mode === 'list' ? listInfo.groups : [...grpSel];
  const onlineCount = finalArms.filter((id) => arms.find((a) => a.id === id)?.status === 'online').length;
  const avgDelay = (settings.min_delay_sec + settings.max_delay_sec) / 2;
  const minutes = Math.ceil((finalGroups.length * avgDelay) / Math.max(1, onlineCount) / 60);
  const canNext = step === 0 ? text.trim().length > 0 : step === 1 ? finalArms.length > 0 && finalGroups.length > 0 : true;

  async function start() {
    setBusy(true);
    const { data, error } = await sb().rpc('create_manual_campaign', {
      p_message: text,
      p_arm_ids: mode === 'list' && !listInfo.arms.length ? null : finalArms,
      p_group_ids: mode === 'list' ? null : finalGroups,
      p_list_id: mode === 'list' ? listId : null,
    });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    toast('השליחה התחילה');
    router.push(`/history/${data}`);
  }

  return (
    <>
      <PageHeader title="שליחת הודעה" subtitle="כותבים פעם אחת, המערכת מחלקת את העבודה בין הזרועות" />

      <ol className="mb-6 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span
              className={cx(
                'grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold',
                i < step ? 'bg-emerald-500 text-white' : i === step ? 'brand-gradient text-white' : 'bg-slate-200 text-slate-500',
              )}
            >
              {i < step ? <Check className="h-4 w-4" /> : i + 1}
            </span>
            <span className={cx('hidden text-sm font-medium sm:block', i === step ? 'text-slate-900' : 'text-slate-500')}>{s}</span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-slate-200" />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="כתוב כאן את ההודעה…"
              className="min-h-64 text-base"
              autoFocus
            />
            <div className="mt-2 text-left text-xs text-slate-400">{text.length} תווים</div>
          </Card>
          <Card className="bg-[#efeae2] p-5">
            <div className="mb-2 text-xs font-medium text-slate-500">תצוגה מקדימה</div>
            {text.trim() ? <div className="wa-bubble mr-auto max-w-[85%] p-3 text-sm shadow-sm">{text}</div> : <div className="text-sm text-slate-400">ההודעה תופיע כאן</div>}
          </Card>
        </div>
      )}

      {step === 1 && (
        <Card className="p-5">
          <div className="mb-5 inline-flex rounded-xl bg-slate-100 p-1">
            <button
              onClick={() => setMode('manual')}
              className={cx('flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium', mode === 'manual' ? 'bg-white shadow-sm' : 'text-slate-500')}
            >
              <MousePointerClick className="h-4 w-4" />
              בחירה ידנית
            </button>
            <button
              onClick={() => setMode('list')}
              className={cx('flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium', mode === 'list' ? 'bg-white shadow-sm' : 'text-slate-500')}
            >
              <ListChecks className="h-4 w-4" />
              רשימת הפצה
            </button>
          </div>

          {mode === 'manual' ? (
            <div className="space-y-5">
              <div>
                <div className="mb-2 text-sm font-medium text-slate-700">מאילו זרועות לשלוח</div>
                <div className="flex flex-wrap gap-2">
                  {arms.map((a) => (
                    <label
                      key={a.id}
                      className={cx(
                        'flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2',
                        armSel.has(a.id) ? 'border-indigo-200 bg-indigo-50' : 'border-slate-200',
                      )}
                    >
                      <Checkbox
                        checked={armSel.has(a.id)}
                        onChange={(v) => {
                          const s = new Set(armSel);
                          v ? s.add(a.id) : s.delete(a.id);
                          setArmSel(s);
                        }}
                        label={<span className="text-sm font-medium">{a.name}</span>}
                      />
                      <Badge tone={ARM_STATUS[a.status]?.tone} dot>
                        {ARM_STATUS[a.status]?.label}
                      </Badge>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 text-sm font-medium text-slate-700">לאילו קבוצות</div>
                <GroupPicker groups={groups} selected={grpSel} onChange={setGrpSel} />
              </div>
            </div>
          ) : lists.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">אין עדיין רשימות הפצה. צור אחת במסך "רשימות הפצה".</div>
          ) : (
            <div className="max-w-md space-y-3">
              <Select value={listId} onChange={(e) => setListId(e.target.value)}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
              <div className="text-sm text-slate-600">
                {listInfo.groups.length} קבוצות · {listInfo.arms.length ? `${listInfo.arms.length} זרועות` : 'כל הזרועות הפעילות'}
              </div>
            </div>
          )}
        </Card>
      )}

      {step === 2 && (
        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="p-5 lg:col-span-2">
            <h3 className="mb-4 font-semibold">סיכום</h3>
            <dl className="space-y-3 text-sm">
              <Row label="זרועות" value={`${finalArms.length} (${onlineCount} מחוברות)`} />
              <Row label="קבוצות יעד" value={finalGroups.length} />
              <Row label="המתנה בין הודעות" value={`${settings.min_delay_sec}–${settings.max_delay_sec} שניות`} />
              <Row
                label="זמן משוער"
                value={
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />~{minutes} דק׳
                  </span>
                }
              />
            </dl>
            {onlineCount === 0 && (
              <div className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                אף זרוע שנבחרה לא מחוברת כרגע. ההפצה תחכה עד שזרוע תתחבר.
              </div>
            )}
            <Button size="lg" className="mt-6 w-full" onClick={start} loading={busy}>
              <Send className="h-5 w-5" />
              התחל שליחה
            </Button>
          </Card>
          <Card className="bg-[#efeae2] p-5 lg:col-span-3">
            <div className="mb-2 text-xs font-medium text-slate-500">ההודעה</div>
            <div className="wa-bubble mr-auto max-w-[85%] p-3 text-sm shadow-sm">{text}</div>
          </Card>
        </div>
      )}

      <div className="mt-6 flex justify-between">
        <Button variant="secondary" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
          <ArrowRight className="h-4 w-4" />
          הקודם
        </Button>
        {step < 2 && (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
            הבא
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 last:border-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
