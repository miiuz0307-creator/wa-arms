'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Radar, Zap, FileText, Save, UserCheck, Quote, ChevronDown, X, Ban, Check } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Select, Skeleton, Textarea, Toggle, ask, toast, cx } from '@/components/ui';
import { useRealtime } from '@/lib/hooks';
import { allGroups } from '@/lib/allRows';

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
      sb().from('source_groups').select('*').order('created_at'), // rows: bounded – source groups of one station
      sb().from('triggers').select('*').order('created_at'), // rows: bounded – a few trigger words
      sb().from('templates').select('*').order('created_at'), // rows: bounded – a few templates
      sb().from('distribution_lists').select('id,name').order('name'), // rows: bounded – lists of one station
      sb().from('arms').select('id,name').order('created_at'), // rows: bounded – the station's arms
      allGroups('wa_group_id,name,arm_id'),
      sb().from('wa_operators').select('*').order('created_at', { ascending: false }), // rows: bounded – approved / waiting dispatchers of one station
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

  if (!d)
    return (
      <div className="space-y-4" role="status" aria-label="טוען">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
        <Skeleton className="h-72" />
      </div>
    );

  async function toggleMaster(v: boolean) {
    const { error } = await sb().from('app_settings').update({ auto_distribution_enabled: v, updated_at: new Date().toISOString() }).eq('id', d.settings.id);
    if (error) return toast(`השינוי לא נשמר: ${error.message}`, 'error');
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
        <Card className="flex items-center justify-between gap-4 p-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
              האזנה לקבוצות מקור
              <Badge tone={d.settings.auto_distribution_enabled ? 'green' : 'slate'} dot>
                {d.settings.auto_distribution_enabled ? 'פעילה' : 'כבויה'}
              </Badge>
            </div>
            <div className="mt-1 text-sm leading-relaxed text-slate-500">
              הפצה בלי Reply: כל הודעה בקבוצת מקור שמכילה את המילה מופצת כמו שהיא. זה לא קשור להפצה מ-Reply + &quot;עזרה&quot;, שעובדת תמיד.
            </div>
          </div>
          <Toggle checked={d.settings.auto_distribution_enabled} onChange={toggleMaster} label="האזנה לקבוצות מקור" />
        </Card>
        <Sources d={d} reload={load} />
      </Advanced>
    </div>
  );
}

/** Card with an icon, a title and a one-line explanation. */
function Section({ icon, title, text, children, action }: any) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600 [&_svg]:h-[18px] [&_svg]:w-[18px]">{icon}</div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
            <p className="text-xs leading-relaxed text-slate-500">{text}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="p-4 md:p-5">{children}</div>
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
    if (error) return toast(`הקבוצה לא נוספה: ${error.message}`, 'error');
    toast('הקבוצה נוספה');
    await logAct('help_settings', 'source_group', pick, { added: name });
    setPick('');
    reload();
  }
  async function upd(id: string, patch: any) {
    const { error } = await sb().from('source_groups').update(patch).eq('id', id);
    if (error) return toast(`השינוי לא נשמר: ${error.message}`, 'error');
    reload();
  }
  async function del(s: any) {
    if (!(await ask({ title: 'להפסיק להאזין לקבוצה?', text: `"${s.name || s.wa_group_id}" תוסר מקבוצות המקור.`, ok: 'הסרה', danger: true }))) return;
    await sb().from('source_groups').delete().eq('id', s.id);
    toast('הקבוצה הוסרה');
    reload();
  }

  return (
    <Section icon={<Radar className="h-5 w-5" />} title="קבוצות מקור / סדרנים" text="קבוצות שהמערכת מאזינה להן">
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} className="min-w-0 flex-1 basis-56" aria-label="קבוצה להוספה">
          <option value="">בחר קבוצה להוספה…</option>
          {uniqueGroups.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <Button onClick={add} disabled={!pick}>
          <Plus className="h-4 w-4" />
          הוספה
        </Button>
      </div>
      {d.sources.length === 0 ? (
        <div className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">עדיין לא הוגדרו קבוצות מקור. בחר קבוצה למעלה כדי להתחיל להאזין לה.</div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200/70">
          {d.sources.map((s: any) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 basis-40 truncate font-medium text-slate-900">{s.name || s.wa_group_id}</div>
              <Select value={s.listen_arm_id || ''} onChange={(e) => upd(s.id, { listen_arm_id: e.target.value || null })} className="w-auto min-w-0 max-w-full" aria-label="איזו זרוע מאזינה">
                <option value="">כל זרוע שבקבוצה מאזינה</option>
                {d.arms.map((a: any) => (
                  <option key={a.id} value={a.id}>
                    מאזינה: {a.name}
                  </option>
                ))}
              </Select>
              <Toggle checked={s.is_active} onChange={(v) => upd(s.id, { is_active: v })} label="האזנה פעילה" />
              <Button size="sm" variant="ghost" className="!text-rose-600 hover:!bg-rose-50" onClick={() => del(s)} aria-label={`הסרת ${s.name || 'הקבוצה'}`} title="הסרה">
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
    if (error) return toast(error.code === '23505' ? 'המילה הזו כבר קיימת' : `המילה לא נוספה: ${error.message}`, 'error');
    toast('המילה נוספה');
    await logAct('help_settings', 'trigger', kw.trim(), { added: kw.trim() });
    setKw('');
    reload();
  }
  async function upd(id: string, patch: any) {
    const { error } = await sb().from('triggers').update(patch).eq('id', id);
    if (error) return toast(`השינוי לא נשמר: ${error.message}`, 'error');
    reload();
  }
  async function del(t: any) {
    if (!(await ask({ title: 'למחוק את מילת ההפעלה?', text: `אחרי המחיקה, "${t.keyword}" כבר לא תפיץ נסיעות.`, ok: 'מחיקה', danger: true }))) return;
    await sb().from('triggers').delete().eq('id', t.id);
    toast('המילה נמחקה');
    reload();
  }

  return (
    <Section icon={<Zap className="h-5 w-5" />} title="מילת הפעלה" text="המילה שכותבים ב-Reply לנסיעה כדי להפיץ אותה">
      <div className="mb-4 flex gap-2">
        <Input placeholder="מילה חדשה, למשל: הפצה" aria-label="מילת הפעלה חדשה" value={kw} onChange={(e) => setKw(e.target.value)} className="min-w-0 max-w-xs flex-1" />
        <Button variant="secondary" onClick={add} disabled={!kw.trim()}>
          <Plus className="h-4 w-4" />
          הוספה
        </Button>
      </div>
      <div className="space-y-3">
        {d.triggers.map((t: any) => (
          <div key={t.id} className="grid items-end gap-3 rounded-xl border border-slate-200/70 p-4 md:grid-cols-[1fr_2fr_auto]">
            <Field label="מילה">
              <div className="flex h-[42px] items-center rounded-xl bg-slate-100 px-3.5 font-semibold text-slate-900">{t.keyword}</div>
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
              <span className="text-xs text-slate-500">{t.is_active ? 'פעילה' : 'כבויה'}</span>
              <Toggle checked={t.is_active} onChange={(v) => upd(t.id, { is_active: v })} label={`המילה ${t.keyword} פעילה`} />
              <Button size="sm" variant="ghost" className="!text-rose-600 hover:!bg-rose-50" onClick={() => del(t)} aria-label={`מחיקת המילה ${t.keyword}`} title="מחיקה">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="text-sm text-slate-600 md:col-span-3">
              <Checkbox checked={!!t.strip_keyword} onChange={(v) => upd(t.id, { strip_keyword: v })} label="להסיר את מילת ההפעלה מההודעה המופצת" />
            </div>
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
    if (error) return toast(`הנוסח לא נוצר: ${error.message}`, 'error');
    await sb().from('triggers').update({ template_id: data.id }).neq('id', '00000000-0000-0000-0000-000000000000');
    reload();
  }
  return (
    <Section icon={<FileText className="h-5 w-5" />} title="נוסח ההודעה המופצת" text="מה מתווסף לנסיעה כשמפיצים אותה">
      {current ? (
        <TemplateEditor key={current.id} t={current} reload={reload} />
      ) : (
        <Empty
          icon={<FileText className="h-7 w-7" />}
          title="עדיין אין נוסח"
          text="הנוסח קובע מה מתווסף לנסיעה כשמפיצים אותה – למשל המספר של מי שביקש עזרה."
          action={
            <Button onClick={create}>
              <Plus className="h-4 w-4" />
              יצירת נוסח
            </Button>
          }
        />
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
    if (error) return toast(`הנוסח לא נשמר: ${error.message}`, 'error');
    await logAct('help_settings', 'template', t.id, { name });
    toast('הנוסח נשמר');
    reload();
  }
  async function del() {
    if (!(await ask({ title: 'למחוק את התבנית?', ok: 'מחיקה', danger: true }))) return;
    await sb().from('templates').delete().eq('id', t.id);
    reload();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <Field label="טקסט לפני ההודעה">
          <Textarea value={prefix} onChange={(e) => setPrefix(e.target.value)} className="min-h-16" />
        </Field>
        <Field label="טקסט אחרי ההודעה" hint="{PHONE} = המספר של מי שכתב עזרה. אפשר גם לכתוב מספר קבוע – הוא יופיע כמו שהוא.">
          <Textarea value={suffix} onChange={(e) => setSuffix(e.target.value)} className="min-h-16" />
        </Field>
        <div className="flex gap-2">
          <Button onClick={save} loading={busy} disabled={!dirty}>
            <Save className="h-4 w-4" />
            שמירת הנוסח
          </Button>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200/70 bg-[#efeae2] p-4 dark:bg-[#0b141a]">
        <div className="mb-2 text-xs font-medium text-[#54656f] dark:text-[#8696a0]">תצוגה מקדימה (נסיעה לדוגמה)</div>
        <div className="wa-bubble mr-auto max-w-[90%] p-3 text-sm shadow-sm">{preview}</div>
      </div>
    </div>
  );
}

function Advanced({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-1.5 rounded-lg px-1 text-sm font-medium text-slate-500 hover:text-slate-800"
      >
        <ChevronDown className={cx('h-4 w-4 transition', open && 'rotate-180')} />
        מתקדם: האזנה לקבוצות מקור (בלי Reply)
      </button>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}

function QuoteHowTo() {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
          <Quote className="h-[18px] w-[18px]" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-slate-900">הפצה מציטוט – ישירות מוואטסאפ</h2>
          <p className="text-xs text-slate-500">איך הסדרנים מפיצים נסיעה בלי לפתוח את האפליקציה</p>
        </div>
      </div>
      <ol className="list-decimal space-y-1.5 pr-5 text-sm leading-relaxed text-slate-700 marker:font-semibold marker:text-slate-400">
        <li>בקבוצה עושים Reply להודעת הנסיעה וכותבים <b>עזרה</b> בלבד, בלי שום מילה נוספת (רק ממספר מאושר).</li>
        <li>הבוט מוריד את מספר הלקוח, מוסיף את המספר של מי שכתב "עזרה" (לפי התבנית, {'{PHONE}'}), ומפיץ מיד.</li>
        <li>על הודעת ה"עזרה" מופיע <b>⏳</b> כשהבוט קלט, <b>✅</b> כשההפצה הסתיימה, ו־<b>❌</b> אם לא נשלחה.</li>
        <li>לעצור הפצה: עושים Reply להודעת הנסיעה או להודעת ה"עזרה" וכותבים <b>ביטול</b>, <b>נ</b> או <b>נמכר</b>. ההפצה נעצרת מיד, על בקשת העזרה מופיע <b>🛑</b> ועל הודעת הביטול <b>👍</b>.</li>
        <li><b>🔁</b> = הנסיעה הזו כבר בהפצה או הופצה בחצי השעה האחרונה, ולכן לא נשלחה שוב. נסיעה שבוטלה אפשר להפיץ מחדש.</li>
        <li>כשיש כמה זרועות: נסיעה אחת – כולן שולחות אותה יחד. כמה נסיעות – כל זרוע לוקחת נסיעה אחרת, ומי שמסיימת עוזרת לסיים את השאר.</li>
        <li>הבוט לא שולח הודעות בפרטי. הפרטים – במסך "היסטוריה", והסיבה ל־❌ ביומן הפעילות.</li>
      </ol>
      <p className="mt-3 text-xs text-slate-500">
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
    if (!p) return toast('מספר הטלפון לא תקין. הקלד 10 ספרות, למשל 050-1234567.', 'error');
    const { error } = await sb().from('wa_operators').insert({ name: name || null, phone: p, status: 'approved' });
    if (error) return toast(`המספר לא נוסף: ${error.message}`, 'error');
    toast('המספר אושר');
    await logAct('operator_updated', 'operator', p, { added: name || p });
    setName('');
    setPhone('');
    reload();
  }
  async function setStatus(o: any, status: string) {
    const { error } = await sb().from('wa_operators').update({ status }).eq('id', o.id);
    if (error) return toast(`השינוי לא נשמר: ${error.message}`, 'error');
    await logAct('operator_updated', 'operator', o.id, { name: o.name, status });
    toast(status === 'approved' ? 'המספר אושר' : 'המספר נחסם');
    reload();
  }
  async function setOpen(v: boolean) {
    const { error } = await sb().from('app_settings').update({ open_trigger: v, updated_at: new Date().toISOString() }).eq('id', d.settings.id);
    if (error) return toast(`השינוי לא נשמר: ${error.message}`, 'error');
    await logAct('help_settings', 'settings', String(d.settings.id), { open_trigger: v });
    toast(v ? 'כל מי שבקבוצה יכול להפעיל עזרה' : 'רק מספרים מאושרים יכולים להפעיל עזרה');
    reload();
  }
  async function del(o: any) {
    if (!(await ask({ title: 'להסיר את המספר?', text: `${o.name || o.phone || 'המספר'} יוסר מהרשימה. אם ינסה להפיץ שוב, יופיע כאן לאישור.`, ok: 'הסרה', danger: true }))) return;
    await sb().from('wa_operators').delete().eq('id', o.id);
    toast('המספר הוסר');
    reload();
  }

  return (
    <Section icon={<UserCheck className="h-5 w-5" />} title="מי יכול לכתוב עזרה" text="סדרנים שהפצה שלהם יוצאת">
      <div className="mb-5 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="מי יכול לכתוב עזרה">
        {[
          [false, 'רק מספרים מאושרים', 'מוסיפים סדרנים אחד אחד (או מאשרים מי שניסה). מי שלא ברשימה – הבוט מתעלם ממנו.'],
          [true, 'כל מי שבקבוצה', 'כל סדרן שכותב "עזרה" מפיץ מיד. אפשר עדיין לחסום מספר מסוים.'],
        ].map(([v, title, text]: any) => (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={!!d.settings.open_trigger === v}
            onClick={() => !!d.settings.open_trigger !== v && setOpen(v)}
            className={cx(
              'flex items-start gap-3 rounded-2xl border p-4 text-right transition',
              !!d.settings.open_trigger === v ? 'border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-200' : 'border-slate-200 hover:bg-slate-50',
            )}
          >
            <span
              className={cx(
                'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border',
                !!d.settings.open_trigger === v ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-white',
              )}
            >
              {!!d.settings.open_trigger === v && <Check className="h-3 w-3" />}
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-slate-900">{title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{text}</span>
            </span>
          </button>
        ))}
      </div>
      <StopWords settings={d.settings} reload={reload} />
      <DuplicateWindow settings={d.settings} reload={reload} />
      <div className="mb-2 text-sm font-medium text-slate-700">מספרים מאושרים וממתינים</div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Input placeholder="שם" aria-label="שם הסדרן" value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 basis-32 sm:w-40 sm:flex-none" />
        <Input placeholder="050-0000000" aria-label="טלפון הסדרן" type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} className="min-w-0 flex-1 basis-36 sm:w-44 sm:flex-none" />
        <Button variant="secondary" onClick={add} disabled={!phone.trim()}>
          <Plus className="h-4 w-4" />
          הוספת מספר מאושר
        </Button>
      </div>
      {d.operators.length === 0 ? (
        <div className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          עדיין אין מפעילים. מי שינסה להפיץ מציטוט יופיע כאן לאישור, או שאפשר להוסיף מספר מראש.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200/70">
          {d.operators.map((o: any) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 px-4 py-3 sm:gap-3">
              <div className="min-w-0 flex-1 basis-40">
                <div className="truncate font-medium text-slate-900">{o.name || 'ללא שם'}</div>
                <div className="truncate text-xs tabular-nums text-slate-500" dir="ltr" style={{ textAlign: 'right' }}>
                  {o.phone || o.wa_lid || o.wa_jid || '—'}
                </div>
              </div>
              <Badge tone={OP_STATUS[o.status]?.tone} dot>
                {OP_STATUS[o.status]?.label}
              </Badge>
              {o.status !== 'approved' && (
                <Button size="sm" variant="success" onClick={() => setStatus(o, 'approved')}>
                  <Check className="h-3.5 w-3.5" />
                  אישור
                </Button>
              )}
              {o.status !== 'blocked' && (
                <Button size="sm" variant="ghost" onClick={() => setStatus(o, 'blocked')}>
                  <Ban className="h-3.5 w-3.5" />
                  חסימה
                </Button>
              )}
              <Button size="sm" variant="ghost" className="!text-rose-600 hover:!bg-rose-50" onClick={() => del(o)} aria-label={`הסרת ${o.name || o.phone || 'המספר'}`} title="הסרה">
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
    if (!Number.isFinite(min) || min < 0 || min > 1440) return toast('הקלד מספר דקות בין 0 ל-1440', 'error');
    setBusy(true);
    const { error } = await sb()
      .from('app_settings')
      .update({ duplicate_window_min: Math.round(min), updated_at: new Date().toISOString() })
      .eq('id', settings.id);
    setBusy(false);
    if (error) return toast(`השינוי לא נשמר: ${error.message}`, 'error');
    await logAct('help_settings', 'settings', String(settings.id), { duplicate_window_min: Math.round(min) });
    toast(min === 0 ? 'כל "עזרה" תפיץ שוב, גם על נסיעה שכבר הופצה' : `נסיעה שהופצה לא תופץ שוב במשך ${Math.round(min)} דקות`);
    reload();
  }

  return (
    <div className="mb-5 rounded-2xl border border-slate-200/70 p-4">
      <div className="font-semibold text-slate-900">אותה נסיעה פעמיים</div>
      <div className="mt-0.5 text-xs text-slate-500">
        אם כותבים "עזרה" על נסיעה שכבר הופצה – כמה דקות לא להפיץ אותה שוב (הבוט שם 🔁). 0 = תמיד להפיץ שוב.
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            disabled={busy}
            aria-pressed={p === current}
            onClick={() => p !== current && save(p)}
            className={cx(
              'h-9 rounded-lg border px-3 text-sm font-medium tabular-nums transition',
              p === current ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
            )}
          >
            {p === 0 ? 'בלי הגבלה' : `${p} דק'`}
          </button>
        ))}
        <Input type="number" min={0} max={1440} dir="ltr" aria-label="דקות" value={val} onChange={(e) => setVal(e.target.value)} className="w-24 tabular-nums" />
        <Button variant="secondary" onClick={() => save(Number(val))} disabled={busy || Number(val) === current}>
          שמירה
        </Button>
      </div>
    </div>
  );
}

// Words that stop a distribution when written as a reply to the ride or to the "עזרה"
function StopWords({ settings, reload }: any) {
  const current: string[] = Array.isArray(settings?.cancel_words) && settings.cancel_words.length ? settings.cancel_words : ['ביטול', 'בטל', 'נ', 'נמכר', 'נמכרה'];
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(list: string[]) {
    const clean = Array.from(new Set(list.map((w) => w.trim()).filter(Boolean)));
    if (!clean.length) return toast('צריך להשאיר לפחות מילת עצירה אחת', 'error');
    setBusy(true);
    const { error } = await sb().from('app_settings').update({ cancel_words: clean, updated_at: new Date().toISOString() }).eq('id', settings.id);
    setBusy(false);
    if (error) return toast(`מילות העצירה לא נשמרו: ${error.message}`, 'error');
    await logAct('help_settings', 'settings', String(settings.id), { cancel_words: clean });
    toast('מילות העצירה נשמרו');
    setWord('');
    reload();
  }

  return (
    <div className="mb-5 rounded-2xl border border-slate-200/70 p-4">
      <div className="font-semibold text-slate-900">מילות עצירה</div>
      <div className="mt-0.5 text-xs text-slate-500">
        כותבים אחת מהן כתגובה (ציטוט) לנסיעה או ל"עזרה" – ההפצה נעצרת. כל הודעה אחרת בקבוצה לא משפיעה.
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {current.map((w) => (
          <span key={w} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 pe-1 ps-3 text-sm font-medium text-slate-800">
            {w}
            <button
              type="button"
              disabled={busy || current.length <= 1}
              onClick={() => save(current.filter((x) => x !== w))}
              className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30"
              aria-label={`הסרת המילה ${w}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
        <Input placeholder="מילה חדשה" aria-label="מילת עצירה חדשה" value={word} onChange={(e) => setWord(e.target.value)} className="w-32" />
        <Button variant="secondary" onClick={() => save([...current, word])} disabled={busy || !word.trim()}>
          <Plus className="h-4 w-4" />
          הוספה
        </Button>
      </div>
    </div>
  );
}
