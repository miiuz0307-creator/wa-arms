'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PenLine, Building2, Check } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Checkbox, Empty, PageHeader, Section, Spinner, Textarea, ask, cx, toast } from '@/components/ui';
import { timeAgo } from '@/lib/format';

// "חתימה בהודעות": the line the system owner adds under every message every station sends
// (rides, help, manual sends). Set it for all stations in one action, or per station.

type Row = { station_id: string; station_name: string; is_home: boolean; status: string; footer_text: string; enabled: boolean; updated_at: string | null };

export default function FooterPage() {
  return (
    <RequireRole min="owner">
      <Footers />
    </RequireRole>
  );
}

const SAMPLE = '🚕 נסיעה מתל אביב לנתב״ג\nיציאה: 05:30 · 4 נוסעים\n📞 לבקשה במספר: 050-0000000';

function Footers() {
  const { isSuper, station } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [text, setText] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'all' | 'sel' | 'off' | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('owner_footers');
    if (error) {
      toast(error.message, 'error');
      setRows([]);
      return;
    }
    setRows((data as Row[]) || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // start the editor from the most common current footer
  useEffect(() => {
    if (!rows || text) return;
    const counts = new Map<string, number>();
    rows.filter((r) => r.enabled && r.footer_text).forEach((r) => counts.set(r.footer_text, (counts.get(r.footer_text) || 0) + 1));
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (top) setText(top[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const withFooter = useMemo(() => (text.trim() ? `${SAMPLE}\n\n${text.trim()}` : SAMPLE), [text]);
  const onCount = rows?.filter((r) => r.enabled).length || 0;

  if (!isSuper || station?.acting) return <div className="py-20 text-center text-slate-500">המסך הזה זמין רק לבעל המערכת.</div>;
  if (!rows) return <Spinner />;

  async function apply(scope: 'all' | 'sel' | 'off') {
    const ids = scope === 'all' || scope === 'off' ? null : [...sel];
    const t = scope === 'off' ? '' : text.trim();
    if (scope !== 'off' && !t) return toast('כתוב את החתימה קודם', 'error');
    const n = scope === 'sel' ? sel.size : rows!.length;
    const ok = await ask({
      title: scope === 'off' ? 'להסיר את החתימה מכל התחנות?' : scope === 'all' ? 'להחיל את החתימה על כל התחנות?' : `להחיל את החתימה על ${n} תחנות?`,
      text:
        scope === 'off'
          ? 'מההודעה הבאה, הודעות התחנות יישלחו בלי שורת חתימה.'
          : `השורה תתווסף מתחת לכל הודעה שתישלח מעכשיו ב-${n} תחנות – נסיעות, עזרה ושליחה ידנית. הודעות שכבר נשלחו לא משתנות.`,
      ok: scope === 'off' ? 'הסרת החתימה' : 'החלה',
      danger: scope === 'off',
    });
    if (!ok) return;
    setBusy(scope);
    const { data, error } = await sb().rpc('owner_footer_set', { p_stations: ids, p_text: t, p_enabled: scope !== 'off' });
    setBusy(null);
    if (error) return toast(error.message, 'error');
    await logAct('footer_set', 'station', undefined, { scope, stations: data, text: t });
    toast(scope === 'off' ? 'החתימה הוסרה' : `החתימה הוחלה על ${data} תחנות`);
    setSel(new Set());
    load();
  }

  async function switchOff(r: Row) {
    const { error } = await sb().rpc('owner_footer_set', { p_stations: [r.station_id], p_text: r.footer_text, p_enabled: false });
    if (error) return toast(error.message, 'error');
    toast(`החתימה כובתה ב${r.station_name}`);
    load();
  }

  return (
    <>
      <PageHeader
        title="חתימה בהודעות"
        subtitle="שורה שתופיע מתחת לכל הודעה שהתחנות מפיצות – נסיעות, עזרה ושליחה ידנית. אפשר להחיל על כל התחנות בפעולה אחת או על תחנות מסוימות."
      />

      <div className="grid gap-4 lg:grid-cols-5">
        <Section title="נוסח החתימה" icon={<PenLine className="h-4 w-4" />} className="lg:col-span-3" bodyClass="space-y-4 p-5">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            placeholder="לדוגמה: 🚕 הופץ באמצעות BotiX · להצטרפות: 050-0000000"
            aria-label="נוסח החתימה"
            className="min-h-24"
          />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>אפשר אימוג׳י ושורות. עד 500 תווים.</span>
            <span className="tabular-nums">{text.length}/500</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => apply('all')} loading={busy === 'all'} disabled={!text.trim()}>
              החלה על כל התחנות ({rows.length})
            </Button>
            <Button variant="secondary" onClick={() => apply('sel')} loading={busy === 'sel'} disabled={!text.trim() || sel.size === 0}>
              החלה על התחנות שנבחרו ({sel.size})
            </Button>
            {onCount > 0 && (
              <Button variant="ghost" className="text-rose-700" onClick={() => apply('off')} loading={busy === 'off'}>
                הסרה מכל התחנות
              </Button>
            )}
          </div>
        </Section>

        <Card className="p-5 lg:col-span-2">
          <div className="mb-3 text-sm font-medium text-slate-600">כך תיראה הודעה בקבוצה</div>
          <div className="rounded-2xl bg-[#efeae2] p-4 dark:bg-[#0b141a]">
            <div className="wa-bubble ms-auto max-w-[92%] px-3 py-2 text-[14px] leading-relaxed shadow-sm">{withFooter}</div>
          </div>
        </Card>
      </div>

      <Section
        title="החתימה בכל תחנה"
        icon={<Building2 className="h-4 w-4" />}
        className="mt-4"
        action={
          <button
            type="button"
            className="text-sm font-medium text-indigo-600 hover:underline"
            onClick={() => setSel(sel.size === rows.length ? new Set() : new Set(rows.map((r) => r.station_id)))}
          >
            {sel.size === rows.length ? 'ניקוי הבחירה' : 'בחירת הכול'}
          </button>
        }
      >
        {rows.length === 0 ? (
          <Empty title="אין תחנות עדיין" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const same = r.enabled && r.footer_text === text.trim();
              return (
                <li key={r.station_id} className={cx('flex items-start gap-3 px-5 py-3.5', sel.has(r.station_id) && 'bg-indigo-50/60')}>
                  <div className="pt-0.5">
                    <Checkbox
                      checked={sel.has(r.station_id)}
                      onChange={(v) => {
                        const s = new Set(sel);
                        v ? s.add(r.station_id) : s.delete(r.station_id);
                        setSel(s);
                      }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{r.station_name}</span>
                      {r.is_home && <Badge>תחנת הבית</Badge>}
                      {r.status !== 'active' && <Badge tone="amber">מושהית</Badge>}
                      {r.enabled ? (
                        <Badge tone="green" dot>
                          חתימה פעילה
                        </Badge>
                      ) : (
                        <Badge>בלי חתימה</Badge>
                      )}
                      {same && (
                        <span className="flex items-center gap-1 text-xs text-emerald-700">
                          <Check className="h-3.5 w-3.5" /> כמו הנוסח שבעריכה
                        </span>
                      )}
                    </div>
                    {r.enabled && r.footer_text && <div className="mt-1 whitespace-pre-line text-sm text-slate-600">{r.footer_text}</div>}
                    {r.updated_at && <div className="mt-1 text-xs text-slate-400">עודכן {timeAgo(r.updated_at)}</div>}
                  </div>
                  {r.enabled && (
                    <Button size="sm" variant="ghost" onClick={() => switchOff(r)}>
                      כיבוי
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}
