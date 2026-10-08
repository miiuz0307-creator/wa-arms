'use client';
import { useCallback, useEffect, useState } from 'react';
import { Save, Gauge, ScrollText } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { ACTION_LABEL, fmtTime } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { Button, Card, Field, Input, PageHeader, Select, Spinner, toast } from '@/components/ui';

export default function SettingsPage() {
  return (
    <RequireRole min="admin">
      <Settings />
      <Log />
    </RequireRole>
  );
}

function Settings() {
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sb()
      .from('app_settings')
      .select('*')
      .eq('id', 1)
      .single()
      .then(({ data }) => setS(data));
  }, []);

  if (!s) return <Spinner />;

  async function save() {
    if (s.min_delay_sec < 0) return toast('ההמתנה לא יכולה להיות שלילית', 'error');
    if (s.max_delay_sec < s.min_delay_sec) return toast('ההמתנה המקסימלית קטנה מהמינימלית', 'error');
    setBusy(true);
    const patch = {
      min_delay_sec: s.min_delay_sec,
      max_delay_sec: s.max_delay_sec,
      per_arm_group_limit: s.per_arm_group_limit,
      distribution_mode: s.distribution_mode,
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb().from('app_settings').update(patch).eq('id', 1);
    setBusy(false);
    if (error) return toast(error.message, 'error');
    await logAct('settings_saved', 'settings', '1', patch);
    toast('ההגדרות נשמרו');
  }

  const set = (k: string) => (e: any) => setS({ ...s, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });

  return (
    <>
      <PageHeader title="הגדרות" subtitle="קצב שליחה וחלוקת עבודה בין הזרועות" />
      <Card className="p-5">
        <div className="mb-5 flex items-center gap-2 font-semibold">
          <Gauge className="h-5 w-5 text-indigo-500" />
          קצב ושליחה
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="המתנה מינימלית בין הודעות (שניות)" hint="לכל זרוע בנפרד. 0 = בלי המתנה">
            <Input type="number" min={0} value={s.min_delay_sec} onChange={set('min_delay_sec')} />
          </Field>
          <Field label="המתנה מקסימלית בין הודעות (שניות)" hint="המערכת בוחרת זמן אקראי בטווח – נראה טבעי יותר">
            <Input type="number" min={0} value={s.max_delay_sec} onChange={set('max_delay_sec')} />
          </Field>
          <Field label="חלוקת העבודה בין הזרועות">
            <Select value={s.distribution_mode} onChange={set('distribution_mode')}>
              <option value="round_robin">חלוקה שווה, עם תקרת קבוצות לזרוע</option>
              <option value="fill">בלי תקרה – כל זרוע שולחת כמה שהיא יכולה</option>
            </Select>
          </Field>
          {s.distribution_mode === 'round_robin' && (
            <Field label="מקסימום קבוצות לזרוע בכל הפצה">
              <Input type="number" min={1} value={s.per_arm_group_limit} onChange={set('per_arm_group_limit')} />
            </Field>
          )}
        </div>
        {s.min_delay_sec < 5 && (
          <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            ⚠️ פחות מ-5 שניות בין הודעות מעלה מאוד את הסיכון ש-WhatsApp יחסום את המספר. ההחלטה שלך.
          </p>
        )}
        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
          המגבלה היומית של כל זרוע מוגדרת במסך "חיבור זרועות". כשזרוע נכשלת בשליחה לקבוצה, המערכת מנסה דרך זרוע אחרת שחברה באותה קבוצה.
        </p>
        <div className="mt-5 flex justify-end">
          <Button onClick={save} loading={busy}>
            <Save className="h-4 w-4" />
            שמירה
          </Button>
        </div>
      </Card>
    </>
  );
}

function Log() {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(async () => {
    const { data } = await sb().from('activity_log').select('*').order('created_at', { ascending: false }).limit(200);
    setRows(data || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['activity_log'], load);

  return (
    <Card className="mt-6" >
      <div id="log" className="flex items-center gap-2 border-b border-slate-100 px-5 py-4 font-semibold">
        <ScrollText className="h-5 w-5 text-indigo-500" />
        יומן פעילות
      </div>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500">אין פעילות עדיין</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3 text-sm">
              <div className="min-w-0">
                <b className="font-medium">{l.actor_name || 'מערכת'}</b> · {ACTION_LABEL[l.action] || l.action}
                {l.details && (
                  <div className="mt-0.5 truncate text-xs text-slate-400" dir="ltr" style={{ textAlign: 'right' }}>
                    {JSON.stringify(l.details)}
                  </div>
                )}
              </div>
              <span className="shrink-0 text-xs text-slate-500">{fmtTime(l.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
