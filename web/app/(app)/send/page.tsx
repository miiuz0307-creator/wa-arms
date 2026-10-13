'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ArrowRight, Send, ListChecks, MousePointerClick, Check, Clock, Smartphone } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { ARM_STATUS } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { GroupPicker, mergeGroups } from '@/components/GroupPicker';
import { Button, Card, Empty, Lamp, PageHeader, Section, Segmented, Select, Skeleton, Textarea, cx, toast } from '@/components/ui';
import { allGroups, allRows } from '@/lib/allRows';

export default function SendPage() {
  return (
    <RequireRole min="operator">
      <Wizard />
    </RequireRole>
  );
}

const STEPS = ['כתיבת הודעה', 'בחירת יעדים', 'סיכום ושליחה'];

const linkBtn =
  'inline-flex h-10 items-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50';

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
  // the footer the system owner adds to this station's messages (shown in the preview only)
  const [footer, setFooter] = useState('');

  useEffect(() => {
    (async () => {
      const [a, g, l, s] = await Promise.all([
        sb().from('arms').select('*').eq('is_active', true).order('created_at'),
        allGroups('arm_id,wa_group_id,name,participants'),
        sb().from('distribution_lists').select('id,name').order('name'),
        sb().from('app_settings').select('*').limit(1).single(),
      ]);
      setArms(a.data || []);
      setRows(g.data || []);
      setLists(l.data || []);
      setSettings(s.data);
      setArmSel(new Set((a.data || []).filter((x: any) => x.status === 'online').map((x: any) => x.id)));
      if (l.data?.length) setListId(l.data[0].id);
    })();
    sb()
      .rpc('station_footer')
      .then(({ data }) => {
        const f = data as { enabled?: boolean; footer_text?: string } | null;
        setFooter(f?.enabled && f.footer_text ? f.footer_text : '');
      });
  }, []);

  useEffect(() => {
    if (!listId) return;
    Promise.all([
      allRows(() => sb().from('list_groups').select('wa_group_id').eq('list_id', listId).order('wa_group_id')),
      sb().from('list_arms').select('arm_id').eq('list_id', listId), // rows: bounded – the arms of one list
    ]).then(([g, a]) => setListInfo({ groups: (g.data || []).map((r: any) => r.wa_group_id), arms: (a.data || []).map((r: any) => r.arm_id) }));
  }, [listId]);

  const armNames = useMemo(() => Object.fromEntries((arms || []).map((a) => [a.id, a.name])), [arms]);
  const groups = useMemo(() => mergeGroups(rows, armNames, armSel), [rows, armNames, armSel]);

  // keep selected groups valid when arms change
  useEffect(() => {
    const valid = new Set(groups.map((g) => g.wa_group_id));
    setGrpSel((s) => new Set([...s].filter((x) => valid.has(x))));
  }, [groups]);

  const header = <PageHeader title="שליחת הודעה" subtitle="כותבים פעם אחת, בוחרים לאן, והמערכת מחלקת את השליחה בין הזרועות של התחנה." />;

  if (!arms || !settings)
    return (
      <>
        {header}
        <div className="space-y-4" role="status" aria-label="טוען">
          <Skeleton className="h-8 w-full max-w-md" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-72" />
            <Skeleton className="h-72" />
          </div>
        </div>
      </>
    );

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
    if (error) return toast(`השליחה לא התחילה: ${error.message}`, 'error');
    toast('השליחה התחילה');
    router.push(`/history/${data}`);
  }

  return (
    <>
      {header}

      <ol className="mb-6 flex items-center gap-2" aria-label="שלבי השליחה">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2 last:flex-none" aria-current={i === step ? 'step' : undefined}>
            <span
              className={cx(
                'grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold tabular-nums',
                i < step ? 'bg-emerald-600 text-white' : i === step ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-200',
              )}
            >
              {i < step ? <Check className="h-4 w-4" aria-label="הושלם" /> : i + 1}
            </span>
            <span className={cx('text-sm font-medium', i === step ? 'text-slate-900' : 'hidden text-slate-500 sm:block')}>{s}</span>
            {i < STEPS.length - 1 && <span className={cx('h-px min-w-3 flex-1', i < step ? 'bg-emerald-300' : 'bg-slate-200')} />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4 md:p-5">
            <label htmlFor="msg" className="mb-2 block text-sm font-medium text-slate-700">
              ההודעה
            </label>
            <Textarea
              id="msg"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="כתוב כאן את הנסיעה: מאיפה, לאן, מחיר ושעה"
              className="min-h-56 text-base md:min-h-64"
              autoFocus
            />
            <div className="mt-2 text-left text-xs tabular-nums text-slate-500">{text.length} תווים</div>
          </Card>
          <WaPreview label="כך זה ייראה בקבוצה">
            {text.trim() ? (
              <Bubble text={text} footer={footer} />
            ) : (
              <div className="py-6 text-center text-sm text-[#54656f] dark:text-[#8696a0]">ההודעה תופיע כאן בזמן שאתה כותב</div>
            )}
          </WaPreview>
        </div>
      )}

      {step === 1 && (
        <Card className="p-4 md:p-5">
          <Segmented<'list' | 'manual'>
            value={mode}
            onChange={setMode}
            className="mb-5 flex w-full sm:inline-flex sm:w-auto [&>button]:flex-1 [&>button]:justify-center [&>button]:py-2"
            options={[
              {
                value: 'manual',
                label: (
                  <>
                    <MousePointerClick className="h-4 w-4" />
                    בחירה ידנית
                  </>
                ),
              },
              {
                value: 'list',
                label: (
                  <>
                    <ListChecks className="h-4 w-4" />
                    רשימת הפצה
                  </>
                ),
              },
            ]}
          />

          {mode === 'manual' ? (
            arms.length === 0 ? (
              <Empty
                icon={<Smartphone className="h-7 w-7" />}
                title="אין זרועות פעילות"
                text="כדי לשלוח צריך לפחות מספר וואטסאפ אחד שמחובר לתחנה."
                action={
                  <Link href="/arms" className={linkBtn}>
                    לחיבור זרוע
                  </Link>
                }
              />
            ) : (
              <div className="space-y-6">
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-slate-700">מאילו זרועות לשלוח</legend>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {arms.map((a) => {
                      const on = armSel.has(a.id);
                      const st = ARM_STATUS[a.status];
                      return (
                        <label
                          key={a.id}
                          className={cx(
                            'flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition',
                            on ? 'border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-200' : 'border-slate-200 hover:border-slate-300',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => {
                              const s = new Set(armSel);
                              e.target.checked ? s.add(a.id) : s.delete(a.id);
                              setArmSel(s);
                            }}
                            className="h-[18px] w-[18px] shrink-0 rounded border-slate-300 accent-indigo-600"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{a.name}</span>
                          <span className="flex shrink-0 items-center gap-1.5 text-xs text-slate-600">
                            <Lamp tone={st?.tone || 'slate'} />
                            {st?.label || a.status}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <div>
                  <div className="mb-2 text-sm font-medium text-slate-700">לאילו קבוצות</div>
                  <GroupPicker groups={groups} selected={grpSel} onChange={setGrpSel} />
                </div>
              </div>
            )
          ) : lists.length === 0 ? (
            <Empty
              icon={<ListChecks className="h-7 w-7" />}
              title="עדיין אין רשימות הפצה"
              text="רשימה שומרת קבוצת יעדים קבועה, כדי שלא תצטרך לבחור אותם מחדש בכל שליחה."
              action={
                <Link href="/groups" className={linkBtn}>
                  ליצירת רשימה
                </Link>
              }
            />
          ) : (
            <div className="max-w-md space-y-3">
              <label htmlFor="list" className="block text-sm font-medium text-slate-700">
                רשימת ההפצה
              </label>
              <Select id="list" value={listId} onChange={(e) => setListId(e.target.value)}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                <span>
                  <b className="font-semibold tabular-nums text-slate-900">{listInfo.groups.length}</b> קבוצות
                </span>
                <span>
                  {listInfo.arms.length ? (
                    <>
                      <b className="font-semibold tabular-nums text-slate-900">{listInfo.arms.length}</b> זרועות
                    </>
                  ) : (
                    'כל הזרועות הפעילות'
                  )}
                </span>
              </div>
            </div>
          )}
        </Card>
      )}

      {step === 2 && (
        <div className="grid gap-4 lg:grid-cols-5">
          <Section title="סיכום לפני שליחה" className="lg:col-span-2" bodyClass="p-5">
            <dl className="space-y-3 text-sm">
              <Row
                label="זרועות"
                value={
                  <span className="tabular-nums">
                    {finalArms.length} <span className="font-normal text-slate-500">({onlineCount} מחוברות)</span>
                  </span>
                }
              />
              <Row label="קבוצות יעד" value={<span className="tabular-nums">{finalGroups.length}</span>} />
              <Row label="המתנה בין הודעות" value={<span className="tabular-nums">{`${settings.min_delay_sec}–${settings.max_delay_sec} שניות`}</span>} />
              <Row
                label="זמן משוער"
                value={
                  <span className="flex items-center gap-1 tabular-nums">
                    <Clock className="h-3.5 w-3.5 text-slate-400" />~{minutes} דק׳
                  </span>
                }
              />
            </dl>
            {onlineCount === 0 && (
              <div className="mt-4 flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                אף זרוע שנבחרה לא מחוברת כרגע. ההפצה תמתין עד שזרוע תתחבר.
              </div>
            )}
            <Button size="lg" className="mt-6 w-full" onClick={start} loading={busy}>
              <Send className="h-5 w-5" />
              התחלת השליחה
            </Button>
          </Section>
          <WaPreview label="ההודעה שתישלח" className="lg:col-span-3">
            <Bubble text={text} footer={footer} />
          </WaPreview>
        </div>
      )}

      <div className="mt-6 flex justify-between gap-3">
        <Button variant="secondary" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
          <ArrowRight className="h-4 w-4" />
          הקודם
        </Button>
        {step < 2 && (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
            {step === 0 ? 'לבחירת יעדים' : 'לסיכום'}
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
      </div>
      {step === 1 && !canNext && (
        <p className="mt-2 text-left text-xs text-slate-500">{finalArms.length === 0 ? 'כדי להמשיך, בחר לפחות זרוע אחת.' : 'כדי להמשיך, בחר לפחות קבוצה אחת.'}</p>
      )}
    </>
  );
}

/** WhatsApp-like chat background with the preview bubble (keeps `.wa-bubble`). */
function WaPreview({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cx('overflow-hidden rounded-2xl border border-slate-200/70 bg-[#efeae2] p-4 dark:bg-[#0b141a] md:p-5', className)}>
      <div className="mb-3 text-xs font-medium text-[#54656f] dark:text-[#8696a0]">{label}</div>
      {children}
    </div>
  );
}

/** The message bubble; the station footer (if the owner set one) follows after a blank line. */
function Bubble({ text, footer }: { text: string; footer: string }) {
  return (
    <>
      <div className="wa-bubble mr-auto max-w-[85%] p-3 text-sm shadow-sm">
        {text}
        {footer && (
          <>
            {'\n\n'}
            {footer}
          </>
        )}
      </div>
      {footer && <p className="mt-2 text-xs text-[#54656f] dark:text-[#8696a0]">החתימה מתווספת אוטומטית על ידי בעל המערכת</p>}
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-semibold text-slate-900">{value}</dd>
    </div>
  );
}
