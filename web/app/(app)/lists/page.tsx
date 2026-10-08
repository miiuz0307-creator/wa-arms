'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, ListChecks, Pencil, Trash2, Smartphone, UsersRound } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { RequireRole } from '@/components/Shell';
import { GroupPicker, mergeGroups } from '@/components/GroupPicker';
import { Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Spinner, toast } from '@/components/ui';

export default function ListsPage() {
  return (
    <RequireRole min="operator">
      <Lists />
    </RequireRole>
  );
}

function Lists() {
  const [lists, setLists] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<any>(null);

  const load = useCallback(async () => {
    const { data } = await sb().from('distribution_lists').select('*, list_groups(count), list_arms(count)').order('name');
    setLists(data || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function remove(l: any) {
    if (!confirm(`למחוק את הרשימה "${l.name}"?`)) return;
    const { error } = await sb().from('distribution_lists').delete().eq('id', l.id);
    if (error) return toast(error.message, 'error');
    await logAct('list_deleted', 'list', l.id, { name: l.name });
    toast('הרשימה נמחקה');
    load();
  }

  if (!lists) return <Spinner />;

  return (
    <>
      <PageHeader
        title="רשימות הפצה"
        subtitle="קבוצות יעד וזרועות שולחות, שמורים בשם אחד"
        actions={
          <Button onClick={() => setEditing({})}>
            <Plus className="h-4 w-4" />
            רשימה חדשה
          </Button>
        }
      />
      {lists.length === 0 ? (
        <Card>
          <Empty
            icon={<ListChecks className="h-7 w-7" />}
            title="אין רשימות הפצה"
            text='לדוגמה: "נהגים אשדוד" – כל הקבוצות של האזור, ודרך אילו זרועות לשלוח אליהן.'
            action={<Button onClick={() => setEditing({})}>יצירת רשימה</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {lists.map((l) => (
            <Card key={l.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-lg font-semibold">{l.name}</div>
                  {l.description && <div className="mt-0.5 text-sm text-slate-500">{l.description}</div>}
                </div>
                <div className="flex shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => remove(l)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="mt-4 flex gap-4 text-sm text-slate-600">
                <span className="flex items-center gap-1.5">
                  <UsersRound className="h-4 w-4 text-indigo-500" />
                  {l.list_groups?.[0]?.count ?? 0} קבוצות
                </span>
                <span className="flex items-center gap-1.5">
                  <Smartphone className="h-4 w-4 text-pink-500" />
                  {l.list_arms?.[0]?.count ?? 0} זרועות
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
      <ListEditor list={editing} onClose={() => setEditing(null)} onSaved={load} />
    </>
  );
}

function ListEditor({ list, onClose, onSaved }: { list: any; onClose: () => void; onSaved: () => void }) {
  const { profile } = useAuth();
  const [arms, setArms] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [armSel, setArmSel] = useState<Set<string>>(new Set());
  const [grpSel, setGrpSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!list) return;
    (async () => {
      const [a, g, lg, la] = await Promise.all([
        sb().from('arms').select('id,name,status').order('created_at'),
        sb().from('groups').select('arm_id,wa_group_id,name,participants').limit(5000),
        list.id ? sb().from('list_groups').select('wa_group_id').eq('list_id', list.id) : Promise.resolve({ data: [] }),
        list.id ? sb().from('list_arms').select('arm_id').eq('list_id', list.id) : Promise.resolve({ data: [] }),
      ]);
      setArms(a.data || []);
      setRows(g.data || []);
      setName(list.name || '');
      setDesc(list.description || '');
      setGrpSel(new Set((lg.data || []).map((r: any) => r.wa_group_id)));
      setArmSel(new Set((la.data || []).map((r: any) => r.arm_id)));
    })();
  }, [list]);

  const armNames = useMemo(() => Object.fromEntries(arms.map((a) => [a.id, a.name])), [arms]);
  const groups = useMemo(() => mergeGroups(rows, armNames), [rows, armNames]);

  async function save() {
    setBusy(true);
    try {
      let id = list.id;
      if (id) {
        const { error } = await sb().from('distribution_lists').update({ name: name.trim(), description: desc || null }).eq('id', id);
        if (error) throw error;
      } else {
        const { data, error } = await sb()
          .from('distribution_lists')
          .insert({ name: name.trim(), description: desc || null, created_by: profile?.id })
          .select()
          .single();
        if (error) throw error;
        id = data.id;
      }
      await sb().from('list_groups').delete().eq('list_id', id);
      await sb().from('list_arms').delete().eq('list_id', id);
      const gRows = groups.filter((g) => grpSel.has(g.wa_group_id)).map((g) => ({ list_id: id, wa_group_id: g.wa_group_id, group_name: g.name }));
      // keep selected groups that are no longer visible (arm offline / left) – they stay in the list
      for (const gid of grpSel) if (!gRows.find((r) => r.wa_group_id === gid)) gRows.push({ list_id: id, wa_group_id: gid, group_name: null });
      for (let i = 0; i < gRows.length; i += 500) {
        const { error } = await sb().from('list_groups').insert(gRows.slice(i, i + 500));
        if (error) throw error;
      }
      if (armSel.size) {
        const { error } = await sb().from('list_arms').insert([...armSel].map((arm_id) => ({ list_id: id, arm_id })));
        if (error) throw error;
      }
      await logAct('list_saved', 'list', id, { name, groups: gRows.length, arms: armSel.size });
      toast('הרשימה נשמרה');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(e.message || 'שגיאה בשמירה', 'error');
    }
    setBusy(false);
  }

  return (
    <Modal
      open={!!list}
      onClose={onClose}
      wide
      title={list?.id ? 'עריכת רשימה' : 'רשימת הפצה חדשה'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>
            שמירה ({grpSel.size} קבוצות)
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="שם הרשימה">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="נהגים אשדוד" />
          </Field>
          <Field label="תיאור (לא חובה)">
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
          </Field>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium text-slate-700">זרועות שולחות</div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {arms.map((a) => (
              <Checkbox
                key={a.id}
                checked={armSel.has(a.id)}
                onChange={(v) => {
                  const s = new Set(armSel);
                  v ? s.add(a.id) : s.delete(a.id);
                  setArmSel(s);
                }}
                label={<span className="text-sm">{a.name}</span>}
              />
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">בלי בחירה = כל הזרועות הפעילות. כל קבוצה נשלחת דרך זרוע שחברה בה.</p>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium text-slate-700">קבוצות יעד</div>
          <GroupPicker groups={groups} selected={grpSel} onChange={setGrpSel} maxHeight="max-h-[38dvh]" />
        </div>
      </div>
    </Modal>
  );
}
