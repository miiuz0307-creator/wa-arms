'use client';
import { useCallback, useEffect, useState } from 'react';
import { Save, Gauge, ScrollText, AlertTriangle, Info } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { ACTION_LABEL, fmtTime } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { HelpSettings } from '@/components/settings/HelpSettings';
import { DispatchersPanel } from '@/components/settings/DispatchersPanel';
import { ChangePassword } from '@/components/settings/ChangePassword';
import { MailSettings } from '@/components/settings/MailSettings';
import { Button, Empty, Field, Input, PageHeader, Section, Segmented, Select, Skeleton, cx, toast } from '@/components/ui';
import { allRows } from '@/lib/allRows';

const TABS = [
  ['help', 'עזרה ומפעילים'],
  ['speed', 'קצב שליחה'],
  ['dispatchers', 'סדרנים'],
  ['log', 'יומן פעילות'],
  ['account', 'סיסמה'],
  ['mail', 'מייל המערכת'],
] as const;

export default function SettingsPage() {
  const [tab, setTab] = useState<string>('help');
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && TABS.some(([k]) => k === t)) setTab(t);
  }, []);
  const go = (t: string) => {
    setTab(t);
    window.history.replaceState(null, '', `/settings?tab=${t}`);
  };
  return (
    <RequireRole min="admin">
      <PageHeader title="הגדרות" subtitle="איך התחנה מזהה בקשות עזרה, באיזה קצב היא שולחת, מי הסדרנים ומה קרה לאחרונה." />
      <div className="scroll-thin -mx-4 mb-5 overflow-x-auto px-4 md:mx-0 md:px-0">
        <Segmented<string> value={tab} onChange={go} options={TABS.map(([value, label]) => ({ value, label }))} />
      </div>
      {tab === 'help' && <HelpSettings />}
      {tab === 'speed' && <Settings />}
      {tab === 'dispatchers' && <DispatchersPanel />}
      {tab === 'log' && <Log />}
      {tab === 'account' && <ChangePassword />}
      {tab === 'mail' && <MailSettings />}
    </RequireRole>
  );
}

function Note({ tone = 'slate', children }: { tone?: 'slate' | 'amber'; children: React.ReactNode }) {
  return (
    <div
      className={cx(
        'flex gap-2.5 rounded-xl p-3 text-sm leading-relaxed',
        tone === 'amber' ? 'bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-600/20' : 'bg-slate-50 text-slate-700',
      )}
    >
      {tone === 'amber' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        'h-9 rounded-lg border px-3 text-sm font-medium tabular-nums transition',
        on ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
      )}
    >
      {children}
    </button>
  );
}

function Settings() {
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'minutes' | 'rate' | 'seconds'>('minutes');
  const [minutes, setMinutes] = useState(1);
  const [load, setLoad] = useState({ groups: 0, arms: 1 });

  useEffect(() => {
    (async () => {
      const [lg, a] = await Promise.all([
        allRows(() => sb().from('list_groups').select('list_id').order('list_id').order('wa_group_id')),
        sb().from('arms').select('id').eq('status', 'online'), // rows: bounded – the station's arms
      ]);
      const per: Record<string, number> = {};
      for (const r of lg.data || []) per[r.list_id] = (per[r.list_id] || 0) + 1;
      setLoad({ groups: Math.max(0, ...Object.values(per)), arms: Math.max(1, (a.data || []).length) });
    })();
  }, []);

  useEffect(() => {
    sb()
      .from('app_settings')
      .select('*')
      .limit(1)
      .single()
      .then(({ data }) => {
        setS(data);
        setMode(data?.rate_per_minute ? 'rate' : 'seconds');
      });
  }, []);

  const minutesRate = Math.min(600, Math.max(1, Math.ceil(load.groups / Math.max(0.1, minutes) / load.arms)));

  if (!s)
    return (
      <div className="space-y-3" role="status" aria-label="טוען">
        <Skeleton className="h-12" />
        <Skeleton className="h-80" />
      </div>
    );

  async function save() {
    if (mode === 'rate' && (s.rate_per_minute < 1 || s.rate_per_minute > 600)) return toast('הקצב צריך להיות בין 1 ל-600 הודעות בדקה', 'error');
    if (s.min_delay_sec < 0) return toast('ההמתנה לא יכולה להיות שלילית', 'error');
    if (s.max_delay_sec < s.min_delay_sec) return toast('ההמתנה המקסימלית קטנה מהמינימלית. תקן ונסה שוב.', 'error');
    setBusy(true);
    const patch = {
      min_delay_sec: s.min_delay_sec,
      max_delay_sec: s.max_delay_sec,
      rate_per_minute: mode === 'minutes' ? minutesRate : mode === 'rate' ? Number(s.rate_per_minute) || 10 : null,
      per_arm_group_limit: s.per_arm_group_limit,
      distribution_mode: s.distribution_mode,
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb().from('app_settings').update(patch).eq('id', s.id);
    setBusy(false);
    if (error) return toast(`ההגדרות לא נשמרו: ${error.message}`, 'error');
    await logAct('settings_saved', 'settings', String(s.id), patch);
    toast('ההגדרות נשמרו');
  }

  const set = (k: string) => (e: any) => setS({ ...s, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  const rate = Number(s.rate_per_minute) || 0;

  return (
    <Section
      title="קצב ושליחה"
      icon={<Gauge className="h-4 w-4" />}
      bodyClass="space-y-6 p-5"
      action={
        <Button onClick={save} loading={busy} size="sm" className="hidden md:inline-flex">
          <Save className="h-4 w-4" />
          שמירה
        </Button>
      }
    >
      <div>
        <div className="mb-2 text-sm font-medium text-slate-700">איך לקבוע את הקצב</div>
        <div className="scroll-thin -mx-1 overflow-x-auto px-1">
          <Segmented<'minutes' | 'rate' | 'seconds'>
            value={mode}
            onChange={(k) => {
              setMode(k);
              if (k === 'rate' && !s.rate_per_minute) setS({ ...s, rate_per_minute: 15 });
            }}
            options={[
              { value: 'minutes', label: 'זמן להפצה (דקות)' },
              { value: 'rate', label: 'הודעות בדקה' },
              { value: 'seconds', label: 'שניות בין הודעות' },
            ]}
          />
        </div>
      </div>

      {mode === 'minutes' && (
        <div className="space-y-3">
          <Field label="תוך כמה דקות לסיים הפצה" hint="המערכת מחשבת לבד כמה מהר כל זרוע שולחת.">
            <Input type="number" min={0.5} step={0.5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="max-w-40 tabular-nums" />
          </Field>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 5, 10].map((n) => (
              <Chip key={n} on={minutes === n} onClick={() => setMinutes(n)}>
                {n} דק׳
              </Chip>
            ))}
          </div>
          <Note>
            <span className="tabular-nums">{load.groups}</span> קבוצות ברשימה הגדולה · <span className="tabular-nums">{load.arms}</span> זרועות מחוברות. כל זרוע
            תשלח <b className="tabular-nums">{minutesRate} הודעות בדקה</b>.
          </Note>
          {minutesRate > 12 && (
            <Note tone="amber">
              <span className="tabular-nums">{minutesRate}</span> הודעות בדקה ממספר אחד – WhatsApp עלול לדחות חלק מההודעות ולחסום את המספר. כדי לעמוד בזמן בבטחה
              צריך בערך <b className="tabular-nums">{Math.ceil(load.groups / Math.max(0.1, minutes) / 12)}</b> זרועות שחברות באותן קבוצות.
            </Note>
          )}
        </div>
      )}

      {mode === 'rate' && (
        <div className="space-y-3">
          <Field label="כמה הודעות בדקה (לכל זרוע)" hint="בחר מהכפתורים או הקלד מספר. כמה זרועות יחד מכפילות את הקצב.">
            <Input type="number" min={1} max={600} value={s.rate_per_minute} onChange={set('rate_per_minute')} className="max-w-40 tabular-nums" />
          </Field>
          <div className="flex flex-wrap gap-2">
            {[10, 20, 30, 50, 75, 100].map((n) => (
              <Chip key={n} on={rate === n} onClick={() => setS({ ...s, rate_per_minute: n })}>
                {n} בדקה
              </Chip>
            ))}
          </div>
          {rate > 0 && load.groups > 0 && (
            <p className="text-xs text-slate-500">
              כ-<span className="tabular-nums">{Math.round((load.groups / rate) * 10) / 10}</span> דקות להפצה ל-<span className="tabular-nums">{load.groups}</span> קבוצות עם
              זרוע אחת.
            </p>
          )}
          {rate > 12 && <Note tone="amber">יותר מ-12 הודעות בדקה ממספר אחד מעלה מאוד את הסיכון ש-WhatsApp יחסום אותו. ההחלטה שלך.</Note>}
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {mode === 'seconds' && (
          <>
            <Field label="המתנה מינימלית בין הודעות (שניות)" hint="לכל זרוע בנפרד. 0 = בלי המתנה.">
              <Input type="number" min={0} value={s.min_delay_sec} onChange={set('min_delay_sec')} className="tabular-nums" />
            </Field>
            <Field label="המתנה מקסימלית בין הודעות (שניות)" hint="המערכת בוחרת זמן אקראי בטווח, כך זה נראה טבעי יותר.">
              <Input type="number" min={0} value={s.max_delay_sec} onChange={set('max_delay_sec')} className="tabular-nums" />
            </Field>
          </>
        )}
        <Field label="חלוקת העבודה בין הזרועות">
          <Select value={s.distribution_mode} onChange={set('distribution_mode')}>
            <option value="round_robin">חלוקה שווה, עם תקרת קבוצות לזרוע</option>
            <option value="fill">בלי תקרה – כל זרוע שולחת כמה שהיא יכולה</option>
          </Select>
        </Field>
        {s.distribution_mode === 'round_robin' && (
          <Field label="מקסימום קבוצות לזרוע בכל הפצה">
            <Input type="number" min={1} value={s.per_arm_group_limit} onChange={set('per_arm_group_limit')} className="tabular-nums" />
          </Field>
        )}
      </div>
      {mode === 'seconds' && s.min_delay_sec < 5 && (
        <Note tone="amber">פחות מ-5 שניות בין הודעות מעלה מאוד את הסיכון ש-WhatsApp יחסום את המספר. ההחלטה שלך.</Note>
      )}
      <Note>
        המגבלה היומית של כל זרוע מוגדרת במסך &quot;זרועות&quot;. כשזרוע נכשלת בשליחה לקבוצה, המערכת מנסה דרך זרוע אחרת שחברה באותה קבוצה.
      </Note>
      <div className="flex justify-end border-t border-slate-100 pt-5">
        <Button onClick={save} loading={busy} className="w-full sm:w-auto">
          <Save className="h-4 w-4" />
          שמירת ההגדרות
        </Button>
      </div>
    </Section>
  );
}

function Log() {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(async () => {
    // rows: bounded – the latest 200 entries (limit)
    const { data } = await sb().from('activity_log').select('*').order('created_at', { ascending: false }).limit(200);
    setRows(data || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['activity_log'], load);

  return (
    <Section title="יומן פעילות" icon={<ScrollText className="h-4 w-4" />} action={rows && rows.length > 0 ? <span className="text-xs text-slate-500">200 הפעולות האחרונות</span> : undefined}>
      <div id="log" />
      {!rows ? (
        <ul className="divide-y divide-slate-100" role="status" aria-label="טוען">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="space-y-2 px-5 py-3.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <Empty icon={<ScrollText className="h-7 w-7" />} title="עדיין אין פעילות" text="כל שינוי בהגדרות, שליחה, הוספת סדרן או זרוע יירשמו כאן, עם מי עשה ומתי." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((l) => (
            <li key={l.id} className="flex items-start justify-between gap-3 px-5 py-3.5 text-sm">
              <div className="min-w-0">
                <div className="text-slate-900">
                  <b className="font-medium">{l.actor_name || 'מערכת'}</b> <span className="text-slate-600">· {ACTION_LABEL[l.action] || l.action}</span>
                </div>
                {l.details && (
                  <div className="mt-0.5 truncate font-mono text-xs text-slate-400" dir="ltr" style={{ textAlign: 'right' }}>
                    {JSON.stringify(l.details)}
                  </div>
                )}
              </div>
              <span className="shrink-0 text-xs tabular-nums text-slate-500">{fmtTime(l.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
