'use client';
import { useCallback, useEffect, useState } from 'react';
import { Contact, PhoneMissed, Save, Trash2, Sparkles } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { fmtTime } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Empty, Input, Section, Skeleton, ask, toast } from '@/components/ui';

export function DispatchersPanel() {
  return (
    <RequireRole min="operator">
      <Dispatchers />
    </RequireRole>
  );
}

function normPhone(s: string) {
  let d = s.replace(/\D/g, '');
  if (d.startsWith('972') && d.length === 12) d = '0' + d.slice(3);
  if (d.startsWith('0') && d.length === 10) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return d ? '+' + d : '';
}

function Dispatchers() {
  const [list, setList] = useState<any[] | null>(null);
  const [pending, setPending] = useState<any[]>([]);

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([
      sb().from('dispatchers').select('*').order('created_at', { ascending: false }), // rows: bounded – the dispatchers of one station
      sb().from('campaigns').select('*').eq('status', 'pending_phone').order('created_at', { ascending: false }), // rows: bounded – help requests still waiting for a phone
    ]);
    setList(d.data || []);
    setPending(p.data || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['campaigns'], load);

  if (!list)
    return (
      <Card>
        <ul className="divide-y divide-slate-100" role="status" aria-label="טוען">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="flex gap-3 px-5 py-3.5">
              <Skeleton className="h-10 w-44" />
              <Skeleton className="h-10 w-40" />
            </li>
          ))}
        </ul>
      </Card>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-slate-500">
        המספרים של מי שמבקש עזרה בקבוצות המקור. המערכת לומדת אותם לבד מההודעות, ואפשר להשלים או לתקן ידנית.
      </p>

      {pending.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-start gap-3 border-b border-amber-200/70 bg-amber-50 px-5 py-3.5">
            <PhoneMissed className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <div className="font-semibold text-amber-900">
                <span className="tabular-nums">{pending.length}</span> בקשות עזרה ממתינות – לא זוהה מספר
              </div>
              <div className="mt-0.5 text-sm text-amber-800">הקלד את הטלפון של המבקש וההפצה תתחיל מיד.</div>
            </div>
          </div>
          <ul className="divide-y divide-slate-100">
            {pending.map((c) => (
              <PendingRow key={c.id} c={c} onDone={load} />
            ))}
          </ul>
        </Card>
      )}

      <Section title="סדרנים" icon={<Contact className="h-4 w-4" />} action={list.length > 0 ? <span className="text-xs tabular-nums text-slate-500">{list.length}</span> : undefined}>
        {list.length === 0 ? (
          <Empty icon={<Contact className="h-7 w-7" />} title="עדיין אין סדרנים" text="כשסדרן יכתוב &quot;עזרה&quot; בקבוצת מקור, הוא יופיע כאן אוטומטית עם המספר שלו." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.map((d) => (
              <DispatcherRow key={d.id} d={d} onChange={load} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function PendingRow({ c, onDone }: { c: any; onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    const p = normPhone(phone);
    if (!p) return;
    setBusy(true);
    try {
      if (c.requester_jid) {
        const col = c.requester_jid.endsWith('@lid') ? 'wa_lid' : 'wa_jid';
        const { data: existing } = await sb().from('dispatchers').select('id').eq(col, c.requester_jid).maybeSingle();
        if (existing) await sb().from('dispatchers').update({ phone: p }).eq('id', existing.id);
        else await sb().from('dispatchers').insert({ name: c.requester_name, phone: p, [col]: c.requester_jid });
      }
      const { error } = await sb().from('campaigns').update({ requester_phone: p, status: 'queued' }).eq('id', c.id);
      if (error) throw error;
      await logAct('phone_resolved', 'campaign', c.id, { phone: p });
      toast('המספר נשמר – ההפצה מתחילה');
      onDone();
    } catch (e: any) {
      toast(`המספר לא נשמר: ${e.message}`, 'error');
    }
    setBusy(false);
  }

  async function dismiss() {
    if (!(await ask({ title: 'לבטל את בקשת העזרה?', text: 'ההודעה לא תופץ לקבוצות.', ok: 'ביטול הבקשה', danger: true }))) return;
    await sb().from('campaigns').update({ status: 'cancelled' }).eq('id', c.id);
    await sb().from('campaign_targets').update({ status: 'skipped' }).eq('campaign_id', c.id).eq('status', 'pending');
    toast('הבקשה בוטלה');
    onDone();
  }

  return (
    <li className="space-y-3 px-5 py-4 md:flex md:items-center md:gap-4 md:space-y-0">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-slate-900">{c.requester_name || 'לא ידוע'}</div>
        <div className="text-xs text-slate-500">
          {c.source_group_name} · <span className="tabular-nums">{fmtTime(c.created_at)}</span> · <span className="tabular-nums">{c.total}</span> יעדים
        </div>
        <div className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-slate-600">{c.message_text}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input dir="ltr" type="tel" aria-label="הטלפון של המבקש" placeholder="050-0000000" value={phone} onChange={(e) => setPhone(e.target.value)} className="min-w-0 flex-1 md:w-40 md:flex-none" />
        <Button onClick={save} loading={busy} disabled={!normPhone(phone)}>
          שמירה והפצה
        </Button>
        <Button variant="ghost" onClick={dismiss}>
          ביטול
        </Button>
      </div>
    </li>
  );
}

function DispatcherRow({ d, onChange }: { d: any; onChange: () => void }) {
  const [name, setName] = useState(d.name || '');
  const [phone, setPhone] = useState(d.phone || '');
  const dirty = name !== (d.name || '') || phone !== (d.phone || '');

  async function save() {
    const { error } = await sb()
      .from('dispatchers')
      .update({ name: name || null, phone: phone ? normPhone(phone) : null })
      .eq('id', d.id);
    if (error) return toast(`הסדרן לא נשמר: ${error.message}`, 'error');
    toast('הסדרן נשמר');
    onChange();
  }
  async function del() {
    if (!(await ask({ title: 'למחוק את הסדרן?', text: `${d.name || d.phone || 'הסדרן'} יימחק מהרשימה. אם יבקש עזרה שוב, המערכת תלמד אותו מחדש.`, ok: 'מחיקה', danger: true }))) return;
    const { error } = await sb().from('dispatchers').delete().eq('id', d.id);
    if (error) return toast(`הסדרן לא נמחק: ${error.message}`, 'error');
    toast('הסדרן נמחק');
    onChange();
  }

  return (
    <li className="flex flex-wrap items-center gap-2 px-5 py-3 md:gap-3">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="שם" aria-label="שם הסדרן" className="min-w-0 flex-1 basis-40 md:w-44 md:flex-none" />
      <Input dir="ltr" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון" aria-label="טלפון הסדרן" className="min-w-0 flex-1 basis-36 md:w-40 md:flex-none" />
      {d.auto_detected ? (
        <Badge tone="green">
          <Sparkles className="h-3 w-3" />
          זוהה אוטומטית
        </Badge>
      ) : !d.phone ? (
        <Badge tone="amber" dot>
          חסר מספר
        </Badge>
      ) : (
        <Badge>הוזן ידנית</Badge>
      )}
      <div className="flex-1" />
      <Button size="sm" variant={dirty ? 'primary' : 'secondary'} onClick={save} disabled={!dirty} aria-label="שמירת הסדרן" title="שמירה">
        <Save className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="ghost" className="!text-rose-600 hover:!bg-rose-50" onClick={del} aria-label="מחיקת הסדרן" title="מחיקה">
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}
