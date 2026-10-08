'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ListPlus, UsersRound } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { ARM_STATUS, timeAgo } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { GroupPicker } from '@/components/GroupPicker';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, cx, toast } from '@/components/ui';

export default function GroupsPage() {
  return (
    <RequireRole min="operator">
      <Groups />
    </RequireRole>
  );
}

function Groups() {
  const { can, profile } = useAuth();
  const [arms, setArms] = useState<any[] | null>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [armId, setArmId] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    const [a, g] = await Promise.all([
      sb().from('arms').select('id,name,status').order('created_at'),
      sb().from('groups').select('*').order('name').limit(5000),
    ]);
    setArms(a.data || []);
    setRows(g.data || []);
    setArmId((cur) => cur || a.data?.[0]?.id || '');
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['groups', 'arms'], load);

  useEffect(() => setSelected(new Set()), [armId]);

  const armGroups = useMemo(() => rows.filter((r) => r.arm_id === armId), [rows, armId]);
  const arm = arms?.find((a) => a.id === armId);
  const lastSync = armGroups.reduce((m: string | null, r: any) => (!m || r.updated_at > m ? r.updated_at : m), null);

  async function refresh() {
    const { error } = await sb().from('arm_commands').insert({ arm_id: armId, command: 'refresh_groups', created_by: profile?.id });
    if (error) return toast(error.message, 'error');
    toast('מרענן קבוצות מ-WhatsApp…');
  }

  if (!arms) return <Spinner />;
  if (arms.length === 0)
    return (
      <>
        <PageHeader title="ניהול קבוצות" />
        <Card>
          <Empty icon={<UsersRound className="h-7 w-7" />} title="אין זרועות מחוברות" text="חבר זרוע כדי לראות את הקבוצות שלה." />
        </Card>
      </>
    );

  return (
    <>
      <PageHeader title="ניהול קבוצות" subtitle="הקבוצות שכל זרוע חברה בהן, מסונכרנות אוטומטית מ-WhatsApp" />

      <div className="scroll-thin -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
        {arms.map((a) => {
          const count = rows.filter((r) => r.arm_id === a.id).length;
          return (
            <button
              key={a.id}
              onClick={() => setArmId(a.id)}
              className={cx(
                'flex shrink-0 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition',
                a.id === armId ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
              )}
            >
              <span className={cx('h-2 w-2 rounded-full', a.status === 'online' ? 'bg-emerald-500' : 'bg-slate-300')} />
              {a.name}
              <span className="text-xs text-slate-400">{count}</span>
            </button>
          );
        })}
      </div>

      <Card className="p-4 md:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Badge tone={ARM_STATUS[arm?.status]?.tone} dot>
              {ARM_STATUS[arm?.status]?.label}
            </Badge>
            <span className="text-sm text-slate-500">סונכרן {timeAgo(lastSync)}</span>
          </div>
          <div className="flex gap-2">
            {can('admin') && (
              <Button size="sm" variant="secondary" onClick={refresh} disabled={arm?.status !== 'online'}>
                <RefreshCw className="h-4 w-4" />
                רענן מ-WhatsApp
              </Button>
            )}
            <Button size="sm" onClick={() => setAddOpen(true)} disabled={selected.size === 0}>
              <ListPlus className="h-4 w-4" />
              הוסף {selected.size || ''} לרשימת הפצה
            </Button>
          </div>
        </div>
        {armGroups.length === 0 ? (
          <Empty title="אין קבוצות לזרוע הזו" text={arm?.status === 'online' ? 'נסה "רענן מ-WhatsApp".' : 'הקבוצות יופיעו אחרי שהזרוע תתחבר.'} />
        ) : (
          <GroupPicker groups={armGroups} selected={selected} onChange={setSelected} maxHeight="max-h-[60dvh]" />
        )}
      </Card>

      <AddToList
        open={addOpen}
        onClose={() => setAddOpen(false)}
        armId={armId}
        groups={armGroups.filter((g) => selected.has(g.wa_group_id))}
        onDone={() => setSelected(new Set())}
      />
    </>
  );
}

function AddToList({ open, onClose, armId, groups, onDone }: { open: boolean; onClose: () => void; armId: string; groups: any[]; onDone: () => void }) {
  const { profile } = useAuth();
  const [lists, setLists] = useState<any[]>([]);
  const [listId, setListId] = useState('new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    sb()
      .from('distribution_lists')
      .select('id,name')
      .order('name')
      .then(({ data }) => {
        setLists(data || []);
        setListId(data?.[0]?.id || 'new');
      });
    setName('');
  }, [open]);

  async function save() {
    setBusy(true);
    let id = listId;
    if (listId === 'new') {
      const { data, error } = await sb().from('distribution_lists').insert({ name: name.trim(), created_by: profile?.id }).select().single();
      if (error) {
        setBusy(false);
        return toast(error.message, 'error');
      }
      id = data.id;
    }
    const { error } = await sb()
      .from('list_groups')
      .upsert(groups.map((g) => ({ list_id: id, wa_group_id: g.wa_group_id, group_name: g.name })), { onConflict: 'list_id,wa_group_id' });
    await sb().from('list_arms').upsert({ list_id: id, arm_id: armId }, { onConflict: 'list_id,arm_id' });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    await logAct('list_saved', 'list', id, { added: groups.length });
    toast(`${groups.length} קבוצות נוספו לרשימה`);
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="הוספה לרשימת הפצה"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy} disabled={listId === 'new' && !name.trim()}>
            הוסף
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="רשימה">
          <Select value={listId} onChange={(e) => setListId(e.target.value)}>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value="new">+ רשימה חדשה</option>
          </Select>
        </Field>
        {listId === 'new' && (
          <Field label="שם הרשימה החדשה">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: נהגים אשדוד" autoFocus />
          </Field>
        )}
        <p className="text-sm text-slate-500">{groups.length} קבוצות נבחרו. הזרוע הנוכחית תתווסף לרשימה כזרוע שולחת.</p>
      </div>
    </Modal>
  );
}
