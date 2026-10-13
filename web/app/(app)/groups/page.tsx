'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ListPlus, ListMinus, UsersRound, Plus, Pencil, Trash2, Smartphone, Search, Users } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth, myUid } from '@/lib/auth';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, cx, toast } from '@/components/ui';
import { allGroups, allRows } from '@/lib/allRows';

// "ניהול קבוצות והפצה": one screen for groups and distribution lists.
// One source of truth: list_groups (list ↔ WhatsApp group) and list_arms (list ↔ sending arms) – the same
// tables the engine reads. A group is shown once even when several arms are in it.

export default function GroupsPage() {
  return (
    <RequireRole min="operator">
      <GroupsAndLists />
    </RequireRole>
  );
}

type Row = {
  id: string; // wa_group_id
  name: string;
  participants: number | null;
  armIds: string[];
  lists: string[];
  available: boolean;
  reason: string | null;
};

const ALL = '';

function GroupsAndLists() {
  const { can, profile } = useAuth();
  const [arms, setArms] = useState<any[] | null>(null);
  const [groups, setGroups] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [listGroups, setListGroups] = useState<any[]>([]);
  const [listArms, setListArms] = useState<any[]>([]);
  const [noPerm, setNoPerm] = useState<Set<string>>(new Set());

  const [q, setQ] = useState('');
  const [armF, setArmF] = useState(ALL);
  const [listF, setListF] = useState(ALL);
  const [statusF, setStatusF] = useState<'all' | 'ok' | 'bad'>('all');
  const [showUnavailable, setShowUnavailable] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());

  const [addOpen, setAddOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [listEdit, setListEdit] = useState<any>(null);
  const [armsEdit, setArmsEdit] = useState<any>(null);

  const load = useCallback(async () => {
    const [a, g, l, lg, la] = await Promise.all([
      sb().from('arms').select('id,name,status,is_active').order('created_at'),
      allGroups('arm_id,wa_group_id,name,participants'),
      sb().from('distribution_lists').select('id,name,description').order('name'),
      allRows(() => sb().from('list_groups').select('list_id,wa_group_id,group_name').order('list_id').order('wa_group_id')),
      sb().from('list_arms').select('list_id,arm_id'), // rows: bounded – lists × arms of one station
    ]);
    setArms(a.data || []);
    setGroups(g.data || []);
    setLists(l.data || []);
    setListGroups(lg.data || []);
    setListArms(la.data || []);
  }, []);
  // groups where sending was refused for lack of permission (admins-only) in the last 48h – loaded once,
  // not on every live update, because it reads many rows
  const loadPerm = useCallback(async () => {
    const since = new Date(Date.now() - 2 * 86400000).toISOString();
    const np = await allRows(() =>
      sb().from('campaign_targets').select('wa_group_id,arm_id').eq('status', 'skipped').ilike('error', '%הרשאה%').gte('claimed_at', since).order('id'),
    );
    setNoPerm(new Set((np.data || []).map((r: any) => `${r.arm_id}|${r.wa_group_id}`)));
  }, []);
  useEffect(() => {
    load();
    loadPerm().catch(() => {});
  }, [load, loadPerm]);
  useRealtime(['groups', 'arms', 'list_groups', 'list_arms', 'distribution_lists'], load);

  const armById = useMemo(() => Object.fromEntries((arms || []).map((a) => [a.id, a])), [arms]);
  const listById = useMemo(() => Object.fromEntries(lists.map((l) => [l.id, l])), [lists]);

  // why a group cannot get rides. `pool` = the sending arms chosen for a list (null/empty = any arm of the station)
  function reasonOf(r: Row, pool: string[] | null): string | null {
    if (r.armIds.length === 0) return 'אף זרוע אינה חברה בקבוצה';
    const members = pool && pool.length ? r.armIds.filter((id) => pool.includes(id)) : r.armIds;
    if (members.length === 0) return 'אף זרוע שולחת של הרשימה אינה בקבוצה';
    const usable = members.filter((id) => armById[id]?.is_active && armById[id]?.status === 'online');
    if (usable.length === 0) return pool && pool.length ? 'הזרועות השולחות של הרשימה מנותקות או מושבתות' : 'הזרוע מנותקת';
    if (usable.every((id) => noPerm.has(`${id}|${r.id}`))) return 'אין הרשאת שליחה (רק מנהלים)';
    return null;
  }
  const armsOfList = (listId: string) => listArms.filter((x) => x.list_id === listId).map((x) => x.arm_id as string);

  // one row per WhatsApp group, with its arms, its lists and its real availability
  const rows: Row[] = useMemo(() => {
    const m = new Map<string, Row>();
    for (const g of groups) {
      const r: Row = m.get(g.wa_group_id) || { id: g.wa_group_id, name: g.name || g.wa_group_id, participants: g.participants, armIds: [], lists: [], available: false, reason: null };
      r.armIds.push(g.arm_id);
      if (!r.name || r.name === r.id) r.name = g.name || r.name;
      m.set(g.wa_group_id, r);
    }
    // groups that are in a list but no arm is in them any more
    for (const lg of listGroups) {
      if (!m.has(lg.wa_group_id))
        m.set(lg.wa_group_id, { id: lg.wa_group_id, name: lg.group_name || lg.wa_group_id, participants: null, armIds: [], lists: [], available: false, reason: null });
      m.get(lg.wa_group_id)!.lists.push(lg.list_id);
    }
    for (const r of m.values()) {
      r.reason = reasonOf(r, null);
      r.available = !r.reason;
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'he'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, listGroups, armById, noPerm]);

  const viewRows: Row[] = useMemo(() => {
    if (!listF) return rows;
    const pool = armsOfList(listF);
    if (!pool.length) return rows;
    return rows.map((r) => {
      const reason = reasonOf(r, pool);
      return { ...r, reason, available: !reason };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, listF, listArms]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return viewRows.filter(
      (r) =>
        (!t || r.name.toLowerCase().includes(t)) &&
        (!armF || r.armIds.includes(armF)) &&
        (!listF || r.lists.includes(listF)) &&
        (statusF === 'all' || (statusF === 'ok' ? r.available : !r.available)) &&
        (showUnavailable || r.available || (listF && r.lists.includes(listF))),
    );
  }, [viewRows, q, armF, listF, statusF, showUnavailable]);

  useEffect(() => setSel(new Set()), [armF, listF]);

  const countsFor = (listId: string) => {
    const pool = armsOfList(listId);
    const inList = rows.filter((r) => r.lists.includes(listId));
    const ok = inList.filter((r) => !reasonOf(r, pool)).length;
    return { total: inList.length, ok, bad: inList.length - ok };
  };

  async function refreshArm() {
    if (!armF) return;
    const { error } = await sb().from('arm_commands').insert({ arm_id: armF, command: 'refresh_groups', created_by: myUid(profile) });
    if (error) return toast(error.message, 'error');
    toast('מרענן קבוצות מ-WhatsApp…');
  }

  async function deleteList(l: any) {
    const { data: trig } = await sb().from('triggers').select('keyword').eq('list_id', l.id);
    const used = (trig || []).map((t: any) => t.keyword).filter(Boolean);
    const warn = used.length ? `\n\nשים לב: הרשימה משמשת את מילות ההפעלה: ${used.join(', ')}. אחרי המחיקה הן לא יפיצו עד שתבחר להן רשימה אחרת.` : '';
    if (!confirm(`למחוק את הרשימה "${l.name}"?\nהקבוצות עצמן לא יימחקו.${warn}`)) return;
    const { error } = await sb().from('distribution_lists').delete().eq('id', l.id);
    if (error) return toast(error.message, 'error');
    await logAct('list_deleted', 'list', l.id, { name: l.name });
    toast('הרשימה נמחקה');
    if (listF === l.id) setListF(ALL);
    load();
  }

  if (!arms) return <Spinner />;

  const selRows = rows.filter((r) => sel.has(r.id));
  const allShownSelected = filtered.length > 0 && filtered.every((r) => sel.has(r.id));
  const curList = listF ? listById[listF] : null;
  const curCounts = listF ? countsFor(listF) : null;
  const curListArms = listF ? listArms.filter((x) => x.list_id === listF).map((x) => armById[x.arm_id]?.name).filter(Boolean) : [];

  return (
    <>
      <PageHeader
        title="ניהול קבוצות והפצה"
        subtitle="כל הקבוצות של הזרועות, ושיוך לרשימות הפצה – ממקום אחד"
        actions={
          <Button onClick={() => setListEdit({})}>
            <Plus className="h-4 w-4" /> רשימה חדשה
          </Button>
        }
      />

      {/* lists */}
      <div className="scroll-thin -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
        <button
          onClick={() => setListF(ALL)}
          className={cx(
            'flex shrink-0 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition',
            !listF ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
          )}
        >
          כל הקבוצות <span className="text-xs text-slate-400">{rows.length}</span>
        </button>
        {lists.map((l) => (
          <button
            key={l.id}
            onClick={() => setListF(l.id)}
            className={cx(
              'flex shrink-0 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition',
              listF === l.id ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
            )}
          >
            {l.name} <span className="text-xs text-slate-400">{countsFor(l.id).total}</span>
            {countsFor(l.id).bad > 0 && <span className="h-2 w-2 rounded-full bg-rose-500" title={`${countsFor(l.id).bad} קבוצות לא יקבלו נסיעות`} />}
          </button>
        ))}
      </div>

      {curList && curCounts && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold">{curList.name}</div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                <span>{curCounts.total} קבוצות</span>
                <span className="text-emerald-700">● {curCounts.ok} זמינות</span>
                <span className="text-rose-700">● {curCounts.bad} לא יקבלו נסיעות</span>
                <span className="flex items-center gap-1">
                  <Smartphone className="h-4 w-4 text-pink-500" />
                  {curListArms.length ? curListArms.join(' · ') : 'כל הזרועות הפעילות'}
                </span>
              </div>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" onClick={() => setArmsEdit(curList)}>
                <Smartphone className="h-4 w-4" /> זרועות שולחות
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setListEdit(curList)} aria-label="שינוי שם">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => deleteList(curList)} aria-label="מחיקת רשימה">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-3 md:p-4">
        {/* filters */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input placeholder="חיפוש קבוצה…" value={q} onChange={(e) => setQ(e.target.value)} className="pr-9" />
          </div>
          <Select value={armF} onChange={(e) => setArmF(e.target.value)} className="w-auto">
            <option value="">כל הזרועות</option>
            {arms.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select value={statusF} onChange={(e) => setStatusF(e.target.value as any)} className="w-auto">
            <option value="all">כל הסטטוסים</option>
            <option value="ok">זמינות</option>
            <option value="bad">לא זמינות</option>
          </Select>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <Toggle checked={showUnavailable} onChange={setShowUnavailable} />
            הצג קבוצות לא זמינות
          </label>
          {armF && can('admin') && (
            <Button size="sm" variant="secondary" onClick={refreshArm} disabled={armById[armF]?.status !== 'online'}>
              <RefreshCw className="h-4 w-4" /> רענן מ-WhatsApp
            </Button>
          )}
        </div>

        {/* bulk actions */}
        <div className="mb-2 flex flex-wrap items-center gap-2 border-y border-slate-100 py-2">
          <Checkbox
            checked={allShownSelected}
            onChange={(v) => {
              const s = new Set(sel);
              filtered.forEach((r) => (v ? s.add(r.id) : s.delete(r.id)));
              setSel(s);
            }}
            label={<span className="text-sm">בחר את כל המוצגות ({filtered.length})</span>}
          />
          <span className="text-sm text-slate-500">נבחרו {sel.size}</span>
          <div className="ms-auto flex gap-2">
            <Button size="sm" onClick={() => setAddOpen(true)} disabled={sel.size === 0}>
              <ListPlus className="h-4 w-4" /> הוסף לרשימה
            </Button>
            {listF && (
              <Button size="sm" variant="secondary" onClick={() => setRemoveOpen(true)} disabled={sel.size === 0}>
                <ListMinus className="h-4 w-4" /> הסר מהרשימה
              </Button>
            )}
          </div>
        </div>

        {/* groups */}
        {filtered.length === 0 ? (
          <Empty icon={<UsersRound className="h-7 w-7" />} title="לא נמצאו קבוצות" text={rows.length === 0 ? 'חבר זרוע והקבוצות שלה יופיעו כאן.' : 'נסה לשנות את החיפוש או הסינון.'} />
        ) : (
          <ul className="scroll-thin max-h-[65dvh] divide-y divide-slate-50 overflow-y-auto">
            {filtered.map((r) => {
              const on = sel.has(r.id);
              return (
                <li key={r.id}>
                  <label className={cx('flex cursor-pointer items-start gap-3 px-2 py-2.5 transition', on ? 'bg-indigo-50/60' : 'hover:bg-slate-50')}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const s = new Set(sel);
                        s.has(r.id) ? s.delete(r.id) : s.add(r.id);
                        setSel(s);
                      }}
                      className="mt-1 h-4 w-4 accent-indigo-600"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{r.name}</span>
                        {r.available ? (
                          <Badge tone="green" dot>
                            זמינה
                          </Badge>
                        ) : (
                          <Badge tone="red" dot>
                            לא זמינה – {r.reason}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">
                        {r.armIds.length ? r.armIds.map((id) => armById[id]?.name || '?').join(' · ') : 'אין זרוע'}
                      </div>
                      {r.lists.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.lists.map((id) => (
                            <span key={id} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                              {listById[id]?.name || '—'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {r.participants != null && (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
                        <Users className="h-3.5 w-3.5" />
                        {r.participants}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <AddToList
        open={addOpen}
        onClose={() => setAddOpen(false)}
        lists={lists}
        listArms={listArms}
        armById={armById}
        groups={selRows}
        defaultList={listF}
        onDone={() => {
          setSel(new Set());
          load();
        }}
      />
      <RemoveFromList
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        list={curList}
        groups={selRows.filter((r) => listF && r.lists.includes(listF))}
        onDone={() => {
          setSel(new Set());
          load();
        }}
      />
      <ListNameEditor
        list={listEdit}
        onClose={() => setListEdit(null)}
        onSaved={(id) => {
          load();
          if (id) setListF(id);
        }}
      />
      <ListArmsEditor list={armsEdit} arms={arms} listArms={listArms} onClose={() => setArmsEdit(null)} onSaved={load} />
    </>
  );
}

function AddToList({
  open,
  onClose,
  lists,
  listArms,
  armById,
  groups,
  defaultList,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  lists: any[];
  listArms: any[];
  armById: Record<string, any>;
  groups: Row[];
  defaultList: string;
  onDone: () => void;
}) {
  const { profile } = useAuth();
  const [listId, setListId] = useState('new');
  const [name, setName] = useState('');
  const [addArms, setAddArms] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setListId(defaultList || lists[0]?.id || 'new');
    setName('');
    setAddArms(true);
    // only when the window opens – the screen refreshes every few seconds and must not reset the choice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const already = groups.filter((g) => listId !== 'new' && g.lists.includes(listId)).length;
  const unavailable = groups.filter((g) => !g.available).length;
  // a list with chosen sending arms can only reach groups one of those arms is in
  const chosenArms = listId === 'new' ? [] : listArms.filter((x) => x.list_id === listId).map((x) => x.arm_id);
  const unreachable = chosenArms.length ? groups.filter((g) => g.armIds.length && !g.armIds.some((a) => chosenArms.includes(a))) : [];
  const missingArms = [...new Set(unreachable.map((g) => g.armIds.find((a) => armById[a]?.is_active) || g.armIds[0]).filter(Boolean))] as string[];

  async function save() {
    setBusy(true);
    try {
      let id = listId;
      if (listId === 'new') {
        const { data, error } = await sb().from('distribution_lists').insert({ name: name.trim(), created_by: myUid(profile) }).select().single();
        if (error) throw error;
        id = data.id;
      }
      const rowsToAdd = groups.map((g) => ({ list_id: id, wa_group_id: g.id, group_name: g.name }));
      for (let i = 0; i < rowsToAdd.length; i += 500) {
        const { error } = await sb().from('list_groups').upsert(rowsToAdd.slice(i, i + 500), { onConflict: 'list_id,wa_group_id' });
        if (error) throw error;
      }
      if (addArms && missingArms.length) {
        const { error } = await sb()
          .from('list_arms')
          .upsert(missingArms.map((arm_id) => ({ list_id: id, arm_id })), { onConflict: 'list_id,arm_id' });
        if (error) throw error;
      }
      await logAct('list_saved', 'list', id, { added: groups.length, arms_added: addArms ? missingArms.length : 0 });
      toast(`${groups.length} קבוצות שויכו לרשימה`);
      onDone();
      onClose();
    } catch (e: any) {
      toast(e.message || 'שגיאה בשמירה', 'error');
    }
    setBusy(false);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="שיוך לרשימת הפצה"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy} disabled={listId === 'new' && !name.trim()}>
            אישור ושמירה
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
        <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
          <div className="font-medium">סיכום לפני שמירה</div>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>{groups.length} קבוצות נבחרו</li>
            {already > 0 && <li>{already} כבר ברשימה – לא יתווספו פעמיים</li>}
            {unavailable > 0 && <li className="text-rose-700">{unavailable} לא זמינות כרגע – יישמרו ברשימה, ולא תהיה אליהן שליחה עד שיחזרו להיות זמינות</li>}
            <li>קבוצה שנמצאת בכמה רשימות מקבלת כל נסיעה פעם אחת בלבד</li>
          </ul>
        </div>
        {missingArms.length > 0 && (
          <Checkbox
            checked={addArms}
            onChange={setAddArms}
            label={
              <span className="text-sm">
                {unreachable.length} קבוצות שאף זרוע שולחת של הרשימה לא חברה בהן – הוסף לרשימה את הזרועות: {missingArms.map((a) => armById[a]?.name).join(', ')}
              </span>
            }
          />
        )}
      </div>
    </Modal>
  );
}

function RemoveFromList({ open, onClose, list, groups, onDone }: { open: boolean; onClose: () => void; list: any; groups: Row[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!list) return;
    setBusy(true);
    try {
      const ids = groups.map((g) => g.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await sb().from('list_groups').delete().eq('list_id', list.id).in('wa_group_id', ids.slice(i, i + 200));
        if (error) throw error;
      }
      await logAct('list_saved', 'list', list.id, { removed: ids.length });
      toast(`${ids.length} קבוצות הוסרו מהרשימה`);
      onDone();
      onClose();
    } catch (e: any) {
      toast(e.message || 'שגיאה', 'error');
    }
    setBusy(false);
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="הסרה מרשימת הפצה"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy} disabled={!groups.length}>
            הסר {groups.length} קבוצות
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">
        להסיר {groups.length} קבוצות מהרשימה &quot;{list?.name}&quot;? הקבוצות עצמן נשארות במערכת ובשאר הרשימות.
      </p>
    </Modal>
  );
}

function ListNameEditor({ list, onClose, onSaved }: { list: any; onClose: () => void; onSaved: (id?: string) => void }) {
  const { profile } = useAuth();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!list) return;
    setName(list.name || '');
    setDesc(list.description || '');
  }, [list]);
  async function save() {
    setBusy(true);
    try {
      let id = list.id;
      if (id) {
        const { error } = await sb().from('distribution_lists').update({ name: name.trim(), description: desc || null }).eq('id', id);
        if (error) throw error;
      } else {
        const { data, error } = await sb().from('distribution_lists').insert({ name: name.trim(), description: desc || null, created_by: myUid(profile) }).select().single();
        if (error) throw error;
        id = data.id;
      }
      await logAct('list_saved', 'list', id, { name });
      toast('הרשימה נשמרה');
      onSaved(id);
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
      title={list?.id ? 'שינוי שם הרשימה' : 'רשימת הפצה חדשה'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>
            שמירה
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="שם הרשימה">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="נהגים אשדוד" autoFocus />
        </Field>
        <Field label="תיאור (לא חובה)">
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        {!list?.id && <p className="text-sm text-slate-500">אחרי היצירה: בחר קבוצות מהרשימה הכללית ולחץ &quot;הוסף לרשימה&quot;.</p>}
      </div>
    </Modal>
  );
}

function ListArmsEditor({ list, arms, listArms, onClose, onSaved }: { list: any; arms: any[]; listArms: any[]; onClose: () => void; onSaved: () => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!list) return;
    setSel(new Set(listArms.filter((x) => x.list_id === list.id).map((x) => x.arm_id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);
  async function save() {
    setBusy(true);
    try {
      const before = new Set(listArms.filter((x) => x.list_id === list.id).map((x) => x.arm_id));
      const add = [...sel].filter((a) => !before.has(a));
      const del = [...before].filter((a) => !sel.has(a));
      if (add.length) {
        const { error } = await sb().from('list_arms').upsert(add.map((arm_id) => ({ list_id: list.id, arm_id })), { onConflict: 'list_id,arm_id' });
        if (error) throw error;
      }
      if (del.length) {
        const { error } = await sb().from('list_arms').delete().eq('list_id', list.id).in('arm_id', del);
        if (error) throw error;
      }
      await logAct('list_saved', 'list', list.id, { arms: sel.size });
      toast('הזרועות השולחות נשמרו');
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
      title={`זרועות שולחות – ${list?.name || ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={save} loading={busy}>
            שמירה
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {arms.map((a) => (
          <Checkbox
            key={a.id}
            checked={sel.has(a.id)}
            onChange={(v) => {
              const s = new Set(sel);
              v ? s.add(a.id) : s.delete(a.id);
              setSel(s);
            }}
            label={
              <span className="flex items-center gap-2 text-sm">
                <span className={cx('h-2 w-2 rounded-full', a.status === 'online' ? 'bg-emerald-500' : 'bg-slate-300')} />
                {a.name}
              </span>
            }
          />
        ))}
        <p className="pt-1 text-xs text-slate-500">בלי בחירה = כל הזרועות הפעילות. כל קבוצה נשלחת דרך זרוע שחברה בה.</p>
      </div>
    </Modal>
  );
}
