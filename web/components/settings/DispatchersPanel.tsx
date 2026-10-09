'use client';
import { useCallback, useEffect, useState } from 'react';
import { Contact, PhoneMissed, Save, Trash2, Sparkles } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { fmtTime } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Empty, Input, PageHeader, Spinner, toast } from '@/components/ui';

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
      sb().from('dispatchers').select('*').order('created_at', { ascending: false }),
      sb().from('campaigns').select('*').eq('status', 'pending_phone').order('created_at', { ascending: false }),
    ]);
    setList(d.data || []);
    setPending(p.data || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['campaigns'], load);

  if (!list) return <Spinner />;

  return (
    <>
      <p className="mb-4 text-sm text-slate-500">המספרים של מי שמבקש עזרה בקבוצות מקור. המערכת לומדת אותם לבד, ואפשר להשלים ידנית.</p>

      {pending.length > 0 && (
        <Card className="mb-4 border-amber-200">
          <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/70 px-5 py-4 font-semibold text-amber-900">
            <PhoneMissed className="h-4 w-4" />
            ממתין לטיפול – לא זוהה מספר ({pending.length})
          </div>
          <ul className="divide-y divide-slate-100">
            {pending.map((c) => (
              <PendingRow key={c.id} c={c} onDone={load} />
            ))}
          </ul>
        </Card>
      )}

      <Card>
        {list.length === 0 ? (
          <Empty icon={<Contact className="h-7 w-7" />} title="עדיין אין סדרנים" text="כשסדרן יבקש עזרה בקבוצת מקור, הוא יופיע כאן אוטומטית." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.map((d) => (
              <DispatcherRow key={d.id} d={d} onChange={load} />
            ))}
          </ul>
        )}
      </Card>
    </>
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
      toast('נשמר – ההפצה מתחילה');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setBusy(false);
  }

  async function dismiss() {
    await sb().from('campaigns').update({ status: 'cancelled' }).eq('id', c.id);
    await sb().from('campaign_targets').update({ status: 'skipped' }).eq('campaign_id', c.id).eq('status', 'pending');
    onDone();
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-4">
      <div className="min-w-48 flex-1">
        <div className="font-medium">{c.requester_name || 'לא ידוע'}</div>
        <div className="text-xs text-slate-500">
          {c.source_group_name} · {fmtTime(c.created_at)} · {c.total} יעדים
        </div>
        <div className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-slate-600">{c.message_text}</div>
      </div>
      <Input dir="ltr" placeholder="050-0000000" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-40" />
      <Button size="sm" onClick={save} loading={busy} disabled={!normPhone(phone)}>
        שמור והפץ
      </Button>
      <Button size="sm" variant="ghost" onClick={dismiss}>
        בטל
      </Button>
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
    if (error) return toast(error.message, 'error');
    toast('נשמר');
    onChange();
  }
  async function del() {
    if (!confirm('למחוק את הסדרן?')) return;
    await sb().from('dispatchers').delete().eq('id', d.id);
    onChange();
  }

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="שם" className="w-44" />
      <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="טלפון" className="w-40" />
      {d.auto_detected ? (
        <Badge tone="green">
          <Sparkles className="h-3 w-3" />
          זוהה אוטומטית
        </Badge>
      ) : !d.phone ? (
        <Badge tone="amber">חסר מספר</Badge>
      ) : (
        <Badge>ידני</Badge>
      )}
      <div className="flex-1" />
      <Button size="sm" variant="secondary" onClick={save} disabled={!dirty}>
        <Save className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="ghost" className="text-rose-600" onClick={del}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}
