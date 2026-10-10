'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Radar, Zap, FileText, Save, UserCheck, Quote, ChevronDown } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Field, Input, Select, Spinner, Textarea, Toggle, PageHeader, toast, cx } from '@/components/ui';
import { useRealtime } from '@/lib/hooks';

export function HelpSettings() {
  return (
    <RequireRole min="admin">
      <Help />
    </RequireRole>
  );
}

const SAMPLE = 'בני ברק → ירושלים\n220 ₪\nעזרה';

function Help() {
  const [d, setD] = useState<any>(null);

  const load = useCallback(async () => {
    const [s, src, trg, tpl, lists, arms, groups, ops] = await Promise.all([
      sb().from('app_settings').select('*').limit(1).single(),
      sb().from('source_groups').select('*').order('created_at'),
      sb().from('triggers').select('*').order('created_at'),
      sb().from('templates').select('*').order('created_at'),
      sb().from('distribution_lists').select('id,name').order('name'),
      sb().from('arms').select('id,name').order('created_at'),
      sb().from('groups').select('wa_group_id,name,arm_id').limit(5000),
      sb().from('wa_operators').select('*').order('created_at', { ascending: false }),
    ]);
    setD({
      settings: s.data,
      sources: src.data || [],
      triggers: trg.data || [],
      templates: tpl.data || [],
      lists: lists.data || [],
      arms: arms.data || [],
      groups: groups.data || [],
      operators: ops.data || [],
    });
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['wa_operators'], load);

  if (!d) return <Spinner />;

  async function toggleMaster(v: boolean) {
    const { error } = await sb().from('app_settings').update({ auto_distribution_enabled: v, updated_at: new Date().toISOString() }).eq('id', d.settings.id);
    if (error) return toast(error.message, 'error');
    await logAct('help_settings', 'settings', '1', { auto_distribution_enabled: v });
    toast(v ? 'הפצה אוטומטית הופעלה' : 'הפצה אוטומטית כובתה');
    load();
  }

  return (
    <div className="space-y-4">
      <QuoteHowTo />
      <MessageTemplate d={d} reload={load} />
      <Operators d={d} reload={load} />
      <Triggers d={d} reload={load} />
      <Advanced>
        <Card className={cx('flex items-center justify-between gap-4 p-5', d.settings.auto_distribution_enabled && 'border-emerald-200 bg-emerald-50/50')}>
          <div>
            <div className="font-semibold">{d.settings.auto_distribution_enabled ? 'האזנה לקבוצות מקור פעילה' : 'האזנה לקבוצות מקור כבויה'}</div>
            <div className="text-sm text-slate-500">
              הפצה בלי Reply: כל הודעה בקבוצת מקור שמכילה את המילה מופצת כמו שהיא. לא קשור להפצה מ-Reply + "עזרה", שעובדת תמיד.
            </div>
          </div>
          <Toggle checked={d.settings.auto_distribution_enabled} onChange={toggleMaster} />
        </Card>
        <Sources d={d} reload={load} />
      </Advanced>
    </div>
  );
}

function Section({ icon, title, text, children, action }: any) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600">{icon}</div>
          <div>
            <h2 className="font-semibold">{title}</h2>
            <p className="text-xs text-slate-500">{text}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

function Sources({ d, reload }: any) {
  const [pick, setPick] = useState('');
  const uniqueGroups = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of d.groups) if (!m.has(g.wa_group_id)) m.set(g.wa_group_id, g.name);
    const used = new Set(d.sources.map((s: any) => s.wa_group_id));
    return [...m].filter(([id]) => !used.has(id)).sort((a, b) => (a[1] || '').localeCompare(b[1] || '', 'he'));
  }, [d]);

  async function add() {
    if (!pick) return;
    const name = uniqueGroups.find(([id]) => id === pick)?.[1];
    const { error } = await sb().from('source_groups').insert({ wa_group_id: pick, name });
    if (error) return toast(error.message, 'error');
    await logAct('help_settings', 'source_group', pick, { added: name });
    setPick('');
    reload();
  }
  async function upd(id: string, patch: any) {
    const { error } = await sb().from('source_groups').update(patch).eq('id', id);
    if (error) return toast(error.message, 'error');
    reload();
  }
  async function del(s: any) {
    if (!confirm(`להפסיק להאזין ל"${s.name}"?`)) return;
    await sb().from('source_groups').delete().eq('id', s.id);
    reload();
  }

  return (
    <Section icon={<Radar className="h-5 w-5" />} title="קבוצות מקור / סדרנים" text="קבוצות שהמערכת מאזינה להן">
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} className="min-w-60 flex-1">
          <option value="">בחר קבוצה להוספה…</option>
          {uniqueGroups.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <Button onClick={add} disabled={!pick}>
          <Plus className="h-4 w-4" />
          הוסף
        </Button>
      </div>
      {d.sources.length === 0 ? (
        <div className="py-4 text-center text-sm text-slate-500">עדיין לא הוגדרו קבוצות מקור</div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          {d.sources.map((s: any) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-40 flex-1 font-medium">{s.name || s.wa_group_id}</div>
              <Select value={s.listen_arm_id || ''} onChange={(e) => upd(s.id, { listen_arm_id: e.target.value || null })} className="w-auto">
                <option value="">כל זרוע שבקבוצה מאזינה</option>
                {d.arms.map((a: any) => (
                  <option key={a.id} value={a.id}>
                    מאזינה: {a.name}
                  </option>
                ))}
              </Select>
              <Toggle checked={s.is_active} onChange={(v) => upd(s.id, { is_active: v })} />
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => del(s)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Triggers({ d, reload }: any) {
  const [kw, setKw] = useState('');
  async function add() {
    if (!kw.trim()) return;
    const { error } = await sb()
      .from('triggers')
      .insert({ keyword: kw.trim(), list_id: null, template_id: d.triggers[0]?.template_id || d.templates[0]?.id || null });
    if (error) return toast(error.code === '23505' ? 'הטריגר כבר קיים' : error.message, 'error');
    await logAct('help_settings', 'trigger', kw.trim(), { added: kw.trim() });
    setKw('');
    reload();
  }
  async function upd(id: string, patch: any) {
    const { error } = await sb().from('triggers').update(patch).eq('id', id);
    if (error) return toast(error.message, 'error');
    reload();
  }
  async function del(t: any) {
    if (!confirm(`למחוק את הטריגר "${t.keyword}"?`)) return;
    await sb().from('triggers').delete().eq('id', t.id);
    reload();
  }

  return (
    <Section icon={<Zap className="h-5 w-5" />} title="מילת הפעלה" text="המילה שכותבים ב-Reply לנסיעה כדי להפיץ אותה">
      <div className="mb-4 flex gap-2">
        <Input placeholder="מילת טריגר חדשה, למשל: הפצה" value={kw} onChange={(e) => setKw(e.target.value)} className="max-w-xs" />
        <Button onClick={add} disabled={!kw.trim()}>
          <Plus className="h-4 w-4" />
          הוסף
        </Button>
      </div>
      <div className="space-y-3">
        {d.triggers.map((t: any) => (
          <div key={t.id} className="grid items-end gap-3 rounded-xl border border-slate-100 p-4 md:grid-cols-[1fr_2fr_auto]">
            <Field label="מילה">
              <div className="flex h-[42px] items-center rounded-xl bg-indigo-50 px-3.5 font-semibold text-indigo-700">{t.keyword}</div>
            </Field>
            <Field label="רשימת יעד">
              <Select value={t.list_id || ''} onChange={(e) => upd(t.id, { list_id: e.target.value || null })}>
                <option value="">כל רשימות ההפצה (מומלץ)</option>
                {d.lists.map((l: any) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-center gap-3 pb-2">
              <span className="text-xs text-slate-500">פעיל</span>
              <Toggle checked={t.is_active} onChange={(v) => upd(t.id, { is_active: v })} />
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => del(t)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 md:col-span-3">
              <input type="checkbox" className="accent-indigo-600" checked={t.strip_keyword} onChange={(e) => upd(t.id, { strip_keyword: e.target.checked })} />
              להסיר את מילת הטריגר מההודעה המופצת
            </label>
          </div>
        ))}
      </div>
    </Section>
  );
}

// One message template for the whole station: the one used by the trigger word
function MessageTemplate({ d, reload }: any) {
  const current = d.templates.find((x: any) => x.id === d.triggers[0]?.template_id) || null;
  async function create() {
    const { data, error } = await sb().from('templates').insert({ name: 'ברירת מחדל', prefix: '', suffix: '📞 לבקשה במספר: {PHONE}' }).select().single();
    if (error) return toast(error.message, 'error');
    await sb().from('triggers').update({ template_id: data.id }).neq('id', '00000000-0000-0000-0000-000000000000');
    reload();
  }
  return (
    <Section icon={<FileText className="h-5 w-5" />} title="נוסח ההודעה המופצת" text="מה מתווסף לנסיעה כשמפיצים אותה">
      {current ? (
        <TemplateEditor key={current.id} t={current} reload={reload} />
      ) : (
        <Button onClick={create}>
          <Plus className="h-4 w-4" />
          יצירת נוסח
        </Button>
      )}
    </Section>
  );
}

function Templates({ d, reload }: any) {
  return (
    <Section
      icon={<FileText className="h-5 w-5" />}
      title="תבניות הודעה"
      text="טקסט לפני ואחרי ההודעה. {PHONE} מוחלף במספר של מבקש העזרה"
      action={
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await sb().from('templates').insert({ name: 'תבנית חדשה', prefix: '', suffix: '📞 {PHONE}' });
            reload();
          }}
        >
          <Plus className="h-4 w-4" />
          תבנית חדשה
        </Button>
      }
    >
      <div className="space-y-4">
        {d.templates.map((t: any) => (
          <TemplateEditor key={t.id} t={t} reload={reload} />
        ))}
      </div>
    </Section>
  );
}

function TemplateEditor({ t, reload }: any) {
  const [name, setName] = useState(t.name);
  const [prefix, setPrefix] = useState(t.prefix);
  const [suffix, setSuffix] = useState(t.suffix);
  const [busy, setBusy] = useState(false);
  const dirty = name !== t.name || prefix !== t.prefix || suffix !== t.suffix;

  const preview = [prefix.trim(), SAMPLE.split('\n').filter((l) => l.trim() !== 'עזרה').join('\n'), suffix.trim()]
    .filter(Boolean)
    .join('\n\n')
    .split('{PHONE}')
    .join('050-1234567');

  async function save() {
    setBusy(true);
    const { error } = await sb().from('templates').update({ name, prefix, suffix }).eq('id', t.id);
    setBusy(false);
    if (error) return toast(error.message, 'error');
    await logAct('help_settings', 'template', t.id, { name });
    toast('התבנית נשמרה');
    reload();
  }
  async function del() {
    if (!confirm('למחוק את התבנית?')) return;
    await sb().from('templates').delete().eq('id', t.id);
    reload();
  }

  return (
    <div className="grid gap-4 rounded-xl border border-slate-100 p-4 lg:grid-cols-2">
      <div className="space-y-3">
        <Field label="טקסט לפני ההודעה">
          <Textarea value={prefix} onChange={(e) => setPrefix(e.target.value)} className="min-h-16" />
        </Field>
        <Field label="טקסט אחרי ההודעה" hint="{PHONE} = המספר של מי שכתב עזרה. אפשר גם לכתוב מספר קבוע – הוא יופיע כמו שהוא.">
          <Textarea value={suffix} onChange={(e) => setSuffix(e.target.value)} className="min-h-16" />
        </Field>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} loading={busy} disabled={!dirty}>
            <Save className="h-4 w-4" />
            שמירה
          </Button>
        </div>
      </div>
      <div className="rounded-xl bg-[#efeae2] p-4">
        <div className="mb-2 text-xs font-medium text-slate-500">תצוגה מקדימה (הודעה לדוגמה)</div>
        <div className="wa-bubble mr-auto max-w-[90%] p-3 text-sm shadow-sm">{preview}</div>
      </div>
    </div>
  );
}

function Advanced({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ChevronDown className={cx('h-4 w-4 transition', open && 'rotate-180')} />
        מתקדם: האזנה לקבוצות מקור (בלי Reply)
      </button>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}

function QuoteHowTo() {
  return (
    <Card className="border-amber-200 bg-amber-50/40 p-5">
      <div className="mb-2 flex items-center gap-2 font-semibold">
        <Quote className="h-5 w-5 text-amber-600" />
        הפצה מציטוט – ישירות מוואטסאפ
      </div>
      <ol className="list-inside list-decimal space-y-1 text-sm text-slate-700">
        <li>בקבוצה עושים Reply להודעת הנסיעה וכותבים <b>עזרה</b> בלבד, בלי שום מילה נוספת (רק ממספר מאושר).</li>
        <li>הבוט מוריד את מספר הלקוח, מוסיף את המספר של מי שכתב "עזרה" (לפי התבנית, {'{PHONE}'}), ומפיץ מיד.</li>
        <li>על הודעת ה"עזרה" מופיע <b>⏳</b> כשהבוט קלט, <b>✅</b> כשההפצה הסתיימה, ו־<b>❌</b> אם לא נשלחה.</li>
        <li>לעצור הפצה: עושים Reply להודעת הנסיעה או להודעת ה"עזרה" וכותבים <b>ביטול</b>, <b>נ</b> או <b>נמכר</b>. ההפצה נעצרת מיד, על בקשת העזרה מופיע <b>🛑</b> ועל הודעת הביטול <b>👍</b>.</li>
        <li><b>🔁</b> = הנסיעה הזו כבר בהפצה או הופצה בחצי השעה האחרונה, ולכן לא נשלחה שוב. נסיעה שבוטלה אפשר להפיץ מחדש.</li>
        <li>כשיש כמה זרועות: נסיעה אחת – כולן שולחות אותה יחד. כמה נסיעות – כל זרוע לוקחת נסיעה אחרת, ומי שמסיימת עוזרת לסיים את השאר.</li>
        <li>הבוט לא שולח הודעות בפרטי. הפרטים – במסך "היסטוריה", והסיבה ל־❌ ביומן הפעילות.</li>
      </ol>
      <p className="mt-2 text-xs text-slate-500">
        מי יכול להפעיל – נקבע בחלק "מי יכול לכתוב עזרה" למטה.
      </p>
    </Card>
  );
}

const OP_STATUS: Record<string, { label: string; tone: any }> = {
  pending: { label: 'ממתין לאישור', tone: 'amber' },
  approved: { label: 'מאושר', tone: 'green' },
  blocked: { label: 'חסום', tone: 'red' },
};

function Operators({ d, reload }: any) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const norm = (p: string) => {
    let x = p.replace(/\D/g, '');
    if (x.startsWith('972')) x = '0' + x.slice(3);
    return /^0\d{9}$/.test(x) ? `${x.slice(0, 3)}-${x.slice(3)}` : '';
  };

  async function add() {
    const p = norm(phone);
    if (!p) return toast('מספר טלפון לא תקין', 'error');
    const { error } = await sb().from('wa_operators').insert({ name: name || null, phone: p, status: 'approved' });
    if (error) return toast(error.message, 'error');
    await logAct('operator_updated', 'operator', p, { added: name || p });
    setName('');
    setPhone('');
    reload();
  }
  async function setStatus(o: any, status: string) {
    const { error } = await sb().from('wa_operators').update({ status }).eq('id', o.id);
    if (error) return toast(error.message, 'error');
    await logAct('operator_updated', 'operator', o.id, { name: o.name, status });
    reload();
  }
  async function setOpen(v: boolean) {
    const { error } = await sb().from('app_settings').update({ open_trigger: v, updated_at: new Date().toISOString() }).eq('id', d.settings.id);
    if (error) return toast(error.message, 'error');
    await logAct('help_settings', 'settings', String(d.settings.id), { open_trigger: v });
    toast(v ? 'כל מי שבקבוצה יכול להפעיל עזרה' : 'רק מספרים מאושרים יכולים להפעיל עזרה');
    reload();
  }
  async function del(o: any) {
    if (!confirm('להסיר את המפעיל?')) return;
    await sb().from('wa_operators').delete().eq('id', o.id);
    reload();
  }

  return (
    <Section icon={<UserCheck className="h-5 w-5" />} title="מי יכול לכתוב עזרה" text="סדרנים שהפצה שלהם יוצאת">
      <div className="mb-5 grid gap-2 sm:grid-cols-2">
        {[
          [false, 'רק מספרים מאושרים', 'מוסיפים סדרנים אחד אחד (או מאשרים מי שניסה). מי שלא ברשימה – הבוט מתעלם ממנו.'],
          [true, 'כל מי שבקבוצה', 'כל סדרן שכותב "עזרה" מפיץ מיד. אפשר עדיין לחסום מספר מסוים.'],
        ].map(([v, title, text]: any) => (
          <button
            key={String(v)}
            onClick={() => !!d.settings.open_trigger !== v && setOpen(v)}
            className={cx(
              'rounded-2xl border p-4 text-right transition',
              !!d.settings.open_trigger === v ? 'border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200' : 'border-slate-200 hover:bg-slate-50',
            )}
          >
            <div className="font-semibold">{title}</div>
            <div className="mt-0.5 text-xs text-slate-500">{text}</div>
          </button>
        ))}
      </div>
      <DuplicateWindow settings={d.settings} reload={reload} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input placeholder="שם" value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
        <Input placeholder="050-0000000" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-44" />
        <Button onClick={add} disabled={!phone.trim()}>
          <Plus className="h-4 w-4" />
          הוסף מאושר
        </Button>
      </div>
      {d.operators.length === 0 ? (
        <div className="py-4 text-center text-sm text-slate-500">
          עדיין אין מפעילים. מי שינסה להפיץ מציטוט יופיע כאן לאישור, או שאפשר להוסיף מספר מראש.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          {d.operators.map((o: any) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-40 flex-1">
                <div className="font-medium">{o.name || 'ללא שם'}</div>
                <div className="text-xs text-slate-500" dir="ltr" style={{ textAlign: 'right' }}>
                  {o.phone || o.wa_lid || o.wa_jid || '—'}
                </div>
              </div>
              <Badge tone={OP_STATUS[o.status]?.tone} dot>
                {OP_STATUS[o.status]?.label}
              </Badge>
              {o.status !== 'approved' && (
                <Button size="sm" variant="success" onClick={() => setStatus(o, 'approved')}>
                  אשר
                </Button>
              )}
              {o.status !== 'blocked' && (
                <Button size="sm" variant="ghost" onClick={() => setStatus(o, 'blocked')}>
                  חסום
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => del(o)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// How long the same ride isn't distributed again after a "עזרה" on it (0 = always send again)
function DuplicateWindow({ settings, reload }: any) {
  const current = Number(settings?.duplicate_window_min ?? 10);
  const [val, setVal] = useState(String(current));
  const [busy, setBusy] = useState(false);
  useEffect(() => setVal(String(current)), [current]);
  const presets = [0, 5, 10, 30, 60];

  async function save(min: number) {
    if (!Number.isFinite(min) || min < 0 || min > 1440) return toast('מספר דקות בין 0 ל-1440', 'error');
    setBusy(true);
    const { error } = await sb()
      .from('app_settings')
      .update({ duplicate_window_min: Math.round(min), updated_at: new Date().toISOString() })
      .eq('id', settings.id);
    setBusy(false);
    if (error) return toast(error.message, 'error');
    await logAct('help_settings', 'settings', String(settings.id), { duplicate_window_min: Math.round(min) });
    toast(min === 0 ? 'כל "עזרה" תפיץ שוב, גם על נסיעה שכבר הופצה' : `נסיעה שהופצה לא תופץ שוב במשך ${Math.round(min)} דקות`);
    reload();
  }

  return (
    <div className="mb-5 rounded-2xl border border-slate-200 p-4">
      <div className="font-semibold">אותה נסיעה פעמיים</div>
      <div className="mt-0.5 text-xs text-slate-500">
        אם כותבים "עזרה" על נסיעה שכבר הופצה – כמה דקות לא להפיץ אותה שוב (הבוט שם 🔁). 0 = תמיד להפיץ שוב.
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p}
            disabled={busy}
            onClick={() => p !== current && save(p)}
            className={cx(
              'rounded-xl border px-3 py-1.5 text-sm transition',
              p === current ? 'border-indigo-300 bg-indigo-50 font-semibold text-indigo-700' : 'border-slate-200 hover:bg-slate-50',
            )}
          >
            {p === 0 ? 'בלי הגבלה' : `${p} דק'`}
          </button>
        ))}
        <Input type="number" min={0} max={1440} dir="ltr" value={val} onChange={(e) => setVal(e.target.value)} className="w-24" />
        <Button variant="secondary" onClick={() => save(Number(val))} disabled={busy || Number(val) === current}>
          שמור
        </Button>
      </div>
    </div>
  );
}
