'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  ListPlus,
  ListMinus,
  UsersRound,
  Plus,
  Pencil,
  Trash2,
  Smartphone,
  Search,
  Users,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
  AlertTriangle,
  X,
} from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useAuth, myUid } from '@/lib/auth';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Lamp, Modal, PageHeader, Segmented, Select, Skeleton, ask, cx, toast } from '@/components/ui';
import { allGroups, allRows } from '@/lib/allRows';
import { GROUP_REASON, groupReason, indexProblems, type GroupReason, type ProblemIndex } from '@/lib/armHealth';

// "ניהול קבוצות והפצה": one screen for groups and distribution lists.
// One source of truth: list_groups (list ↔ WhatsApp group) and list_arms (list ↔ sending arms) – the same
// tables the engine reads. A group is shown once even when several arms are in it.
// Availability: arm status + group_problems (what really happened when sending, last 48h) + group_flags
// (disabled by hand / "include anyway").

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
  reason: GroupReason | null;
  disabled: boolean;
  include: boolean;
};
type Flag = { include_anyway: boolean; disabled: boolean; note: string | null };
type StatusF = 'all' | 'ok' | 'bad' | 'off';

const ALL = '';
const PAGE = 300;
const armTone = (a: any) => (!a ? 'slate' : a.is_active && a.status === 'online' ? 'green' : a.status === 'qr' || a.status === 'connecting' ? 'amber' : 'red');

function GroupsAndLists() {
  const { can, profile } = useAuth();
  const [arms, setArms] = useState<any[] | null>(null);
  const [groups, setGroups] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [listGroups, setListGroups] = useState<any[]>([]);
  const [listArms, setListArms] = useState<any[]>([]);
  const [flags, setFlags] = useState<Map<string, Flag>>(new Map());
  const [problems, setProblems] = useState<ProblemIndex>(new Map());

  const [q, setQ] = useState('');
  const [armF, setArmF] = useState(ALL);
  const [listF, setListF] = useState(ALL);
  const [statusF, setStatusF] = useState<StatusF>('all');
  // inside a list: 'in' = groups already in it, 'add' = groups worth adding (one of its active sending arms is in them)
  const [listMode, setListMode] = useState<'in' | 'add'>('in');
  const [addOthers, setAddOthers] = useState(false);
  // outside a list: all groups / not in any list / already in lists
  const [assignF, setAssignF] = useState<'all' | 'none' | 'assigned'>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);

  const [addOpen, setAddOpen] = useState(false);
  const [removeRows, setRemoveRows] = useState<Row[] | null>(null);
  const [listEdit, setListEdit] = useState<any>(null);
  const [armsEdit, setArmsEdit] = useState<any>(null);
  const [actionsFor, setActionsFor] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [a, g, l, lg, la, fl] = await Promise.all([
      sb().from('arms').select('id,name,status,is_active').order('created_at'), // rows: bounded – the arms of one station
      allGroups('arm_id,wa_group_id,name,participants'),
      sb().from('distribution_lists').select('id,name,description').order('name'), // rows: bounded – the lists of one station
      allRows(() => sb().from('list_groups').select('list_id,wa_group_id,group_name').order('list_id').order('wa_group_id')),
      sb().from('list_arms').select('list_id,arm_id'), // rows: bounded – lists × arms of one station
      allRows(() => sb().from('group_flags').select('wa_group_id,include_anyway,disabled,note').order('wa_group_id')).catch(() => ({ data: [] as any[] })),
    ]);
    setArms(a.data || []);
    setGroups(g.data || []);
    setLists(l.data || []);
    setListGroups(lg.data || []);
    setListArms(la.data || []);
    setFlags(new Map((fl.data || []).map((f: any) => [f.wa_group_id, f])));
  }, []);
  // what really happened when sending (last 48h) – once a minute, not on every live refresh
  const loadProblems = useCallback(async () => {
    const { data, error } = await sb().rpc('group_problems', { p_hours: 48 });
    if (!error) setProblems(indexProblems((data as any[]) || []));
  }, []);
  useEffect(() => {
    load();
    loadProblems();
    const iv = setInterval(loadProblems, 60_000);
    // deep link from home: /groups?show=bad
    try {
      const s = new URLSearchParams(window.location.search).get('show');
      if (s === 'bad' || s === 'off' || s === 'ok') setStatusF(s);
    } catch {}
    return () => clearInterval(iv);
  }, [load, loadProblems]);
  useRealtime(['groups', 'arms', 'list_groups', 'list_arms', 'distribution_lists', 'group_flags'], load);

  const armById = useMemo(() => Object.fromEntries((arms || []).map((a) => [a.id, a])), [arms]);
  const listById = useMemo(() => Object.fromEntries(lists.map((l) => [l.id, l])), [lists]);
  const armsOfList = useCallback((listId: string) => listArms.filter((x) => x.list_id === listId).map((x) => x.arm_id as string), [listArms]);

  // one row per WhatsApp group, with its arms, its lists and its real availability
  const rows: Row[] = useMemo(() => {
    const m = new Map<string, Row>();
    const blank = (id: string, name: string, participants: number | null): Row => ({
      id,
      name,
      participants,
      armIds: [],
      lists: [],
      available: false,
      reason: null,
      disabled: false,
      include: false,
    });
    for (const g of groups) {
      const r = m.get(g.wa_group_id) || blank(g.wa_group_id, g.name || g.wa_group_id, g.participants);
      r.armIds.push(g.arm_id);
      if (!r.name || r.name === r.id) r.name = g.name || r.name;
      if (r.participants == null) r.participants = g.participants;
      m.set(g.wa_group_id, r);
    }
    // groups that are in a list but no arm is in them any more
    for (const lg of listGroups) {
      if (!m.has(lg.wa_group_id)) m.set(lg.wa_group_id, blank(lg.wa_group_id, lg.group_name || lg.wa_group_id, null));
      m.get(lg.wa_group_id)!.lists.push(lg.list_id);
    }
    for (const r of m.values()) {
      const f = flags.get(r.id);
      r.disabled = !!f?.disabled;
      r.include = !!f?.include_anyway;
      r.reason = groupReason(r, armById, problems, r.disabled, null);
      r.available = !r.reason;
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }, [groups, listGroups, armById, problems, flags]);

  // inside a list, a group is judged by that list's sending arms
  const viewRows: Row[] = useMemo(() => {
    if (!listF) return rows;
    const pool = armsOfList(listF);
    if (!pool.length) return rows;
    return rows.map((r) => {
      const reason = groupReason(r, armById, problems, r.disabled, pool);
      return { ...r, reason, available: !reason };
    });
  }, [rows, listF, armsOfList, armById, problems]);

  const activeArms = useMemo(() => new Set((arms || []).filter((a) => a.is_active).map((a) => a.id as string)), [arms]);
  // a group worth adding to the open list: not in it yet, and one of the list's ACTIVE sending arms is in it
  // (no sending arms chosen = every active arm). With "other arms" on: any active arm (that arm then joins the list).
  const addable = useCallback(
    (r: Row) => {
      if (!listF || r.lists.includes(listF)) return false;
      const chosen = armsOfList(listF);
      const pool = (chosen.length ? chosen : [...activeArms]).filter((id) => activeArms.has(id));
      return r.armIds.some((id) => (addOthers ? activeArms.has(id) : pool.includes(id)));
    },
    [listF, armsOfList, activeArms, addOthers],
  );
  const viaListArms = (r: Row) => {
    if (!listF) return true;
    const chosen = armsOfList(listF);
    return !chosen.length || r.armIds.some((id) => chosen.includes(id));
  };

  // search / arm / list filters (status is applied after, so the status tabs can show counts)
  const base = useMemo(() => {
    const t = q.trim().toLowerCase();
    return viewRows.filter(
      (r) =>
        (!t || r.name.toLowerCase().includes(t)) &&
        (!armF || r.armIds.includes(armF)) &&
        (listF
          ? listMode === 'in'
            ? r.lists.includes(listF)
            : addable(r)
          : assignF === 'all' || (assignF === 'none' ? r.lists.length === 0 : r.lists.length > 0)),
    );
  }, [viewRows, q, armF, listF, listMode, addable, assignF]);
  const counts = useMemo(
    () => ({
      all: base.length,
      ok: base.filter((r) => r.available).length,
      bad: base.filter((r) => !r.available && !r.disabled).length,
      off: base.filter((r) => r.disabled).length,
    }),
    [base],
  );
  const filtered = useMemo(
    () => base.filter((r) => statusF === 'all' || (statusF === 'ok' ? r.available : statusF === 'off' ? r.disabled : !r.available && !r.disabled)),
    [base, statusF],
  );

  useEffect(() => setSel(new Set()), [armF, listF, listMode, addOthers]);
  useEffect(() => setLimit(PAGE), [q, armF, listF, statusF, listMode, assignF, addOthers]);

  // per list: how many groups will get rides, how many will not, and those not marked "include anyway"
  const listStats = useMemo(() => {
    const out: Record<string, { total: number; ok: number; bad: number; off: number; warn: Row[] }> = {};
    for (const l of lists) {
      const pool = armsOfList(l.id);
      const s = { total: 0, ok: 0, bad: 0, off: 0, warn: [] as Row[] };
      for (const r of rows) {
        if (!r.lists.includes(l.id)) continue;
        s.total++;
        const reason = groupReason(r, armById, problems, r.disabled, pool);
        if (!reason) s.ok++;
        else if (r.disabled) s.off++;
        else {
          s.bad++;
          if (!r.include) s.warn.push({ ...r, reason, available: false });
        }
      }
      out[l.id] = s;
    }
    return out;
  }, [lists, rows, armsOfList, armById, problems]);

  async function refreshArm() {
    if (!armF) return;
    const { error } = await sb().from('arm_commands').insert({ arm_id: armF, command: 'refresh_groups', created_by: myUid(profile) });
    if (error) return toast(error.message, 'error');
    toast('מרענן קבוצות מ-WhatsApp…');
  }

  /** disabled / include-anyway for many groups at once (null keeps the current value) */
  async function setFlag(ids: string[], patch: { disabled?: boolean; include?: boolean }, done: string) {
    if (!ids.length) return;
    setBusy(true);
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const { error } = await sb().rpc('group_flag_set', {
          p_groups: ids.slice(i, i + 500),
          p_include_anyway: patch.include ?? null,
          p_disabled: patch.disabled ?? null,
        });
        if (error) throw error;
      }
      toast(done);
      setSel(new Set());
      await load();
    } catch (e: any) {
      toast(e.message || 'השמירה נכשלה – נסה שוב', 'error');
    }
    setBusy(false);
  }
  const disable = async (ids: string[]) => {
    if (
      ids.length > 1 &&
      !(await ask({
        title: `להשבית ${ids.length} קבוצות?`,
        text: 'הקבוצות יישארו ברשימות, אבל לא יקבלו נסיעות עד שתחזיר אותן לפעילות.',
        ok: 'השבתה זמנית',
      }))
    )
      return;
    setFlag(ids, { disabled: true }, ids.length === 1 ? 'הקבוצה הושבתה' : `${ids.length} קבוצות הושבתו`);
  };
  const enable = (ids: string[]) => setFlag(ids, { disabled: false }, ids.length === 1 ? 'הקבוצה חזרה לפעילות' : `${ids.length} קבוצות חזרו לפעילות`);
  const includeAnyway = (ids: string[], v = true) =>
    setFlag(ids, { include: v }, v ? (ids.length === 1 ? 'הקבוצה תיכלל בכל זאת' : `${ids.length} קבוצות ייכללו בכל זאת`) : 'ההכללה בוטלה');

  async function deleteList(l: any) {
    const { data: trig } = await sb().from('triggers').select('keyword').eq('list_id', l.id); // rows: bounded – help keywords of one list
    const used = (trig || []).map((t: any) => t.keyword).filter(Boolean);
    const warn = used.length ? `\n\nשים לב: הרשימה משמשת את מילות ההפעלה: ${used.join(', ')}. אחרי המחיקה הן לא יפיצו עד שתבחר להן רשימה אחרת.` : '';
    if (!(await ask({ title: `למחוק את הרשימה "${l.name}"?`, text: `הקבוצות עצמן לא יימחקו.${warn}`, ok: 'מחיקת הרשימה', danger: true }))) return;
    const { error } = await sb().from('distribution_lists').delete().eq('id', l.id);
    if (error) return toast(error.message, 'error');
    await logAct('list_deleted', 'list', l.id, { name: l.name });
    toast('הרשימה נמחקה');
    if (listF === l.id) setListF(ALL);
    load();
  }

  const header = (
    <PageHeader
      title="ניהול קבוצות והפצה"
      subtitle="כל הקבוצות של הזרועות, מה זמין לשליחה ולמה, ושיוך לרשימות הפצה – ממקום אחד"
      actions={
        <Button onClick={() => setListEdit({})}>
          <Plus className="h-4 w-4" /> רשימה חדשה
        </Button>
      }
    />
  );

  if (!arms)
    return (
      <>
        {header}
        <div className="space-y-3" role="status" aria-label="טוען">
          <div className="flex gap-2 overflow-hidden">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-56 shrink-0 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-14 rounded-2xl" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      </>
    );

  const selRows = rows.filter((r) => sel.has(r.id));
  const selView = viewRows.filter((r) => sel.has(r.id));
  const allShownSelected = filtered.length > 0 && filtered.every((r) => sel.has(r.id));
  const curList = listF ? listById[listF] : null;
  const curStats = listF ? listStats[listF] : null;
  const curListArms = listF ? armsOfList(listF).map((id) => armById[id]).filter(Boolean) : [];
  const shown = filtered.slice(0, limit);
  const selDisabled = selView.filter((r) => r.disabled).map((r) => r.id);
  const selActive = selView.filter((r) => !r.disabled).map((r) => r.id);
  const selIncludable = selView.filter((r) => !r.available && !r.disabled && !r.include).map((r) => r.id);

  return (
    <>
      {header}

      {/* lists */}
      <div className="scroll-thin -mx-4 mb-4 flex gap-2.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
        <ListCard active={!listF} onClick={() => setListF(ALL)} title="כל הקבוצות" total={rows.length} ok={rows.filter((r) => r.available).length} bad={rows.filter((r) => !r.available && !r.disabled).length} />
        {lists.map((l) => {
          const s = listStats[l.id] || { total: 0, ok: 0, bad: 0, off: 0, warn: [] };
          return (
            <ListCard
              key={l.id}
              active={listF === l.id}
              onClick={() => {
                setListF(l.id);
                setListMode('in');
              }}
              title={l.name}
              total={s.total}
              ok={s.ok}
              bad={s.bad}
              warn={s.warn.length}
              arms={armsOfList(l.id).map((id) => armById[id]).filter(Boolean)}
            />
          );
        })}
        {lists.length === 0 && (
          <button
            onClick={() => setListEdit({})}
            className="flex min-w-[200px] shrink-0 flex-col items-start justify-center rounded-2xl border border-dashed border-slate-300 px-4 py-3 text-start text-sm text-slate-500 hover:border-slate-400 hover:text-slate-700"
          >
            <span className="font-medium text-slate-700">עדיין אין רשימות הפצה</span>
            צור רשימה ושייך אליה קבוצות
          </button>
        )}
      </div>

      {curList && curStats && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold text-slate-900">{curList.name}</div>
              {curList.description && <div className="text-sm text-slate-500">{curList.description}</div>}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                <span className="tabular-nums">{curStats.total} קבוצות</span>
                <span className="flex items-center gap-1.5 text-emerald-700">
                  <Lamp tone="green" /> <b className="tabular-nums">{curStats.ok}</b> זמינות
                </span>
                <span className={cx('flex items-center gap-1.5', curStats.bad ? 'text-rose-700' : 'text-slate-500')}>
                  <Lamp tone={curStats.bad ? 'red' : 'slate'} /> <b className="tabular-nums">{curStats.bad}</b> לא זמינות
                </span>
                {curStats.off > 0 && <span className="tabular-nums text-slate-500">{curStats.off} מושבתות</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-slate-500">שולחות:</span>
                {curListArms.length ? curListArms.map((a: any) => <ArmChip key={a.id} arm={a} />) : <span className="text-xs text-slate-600">כל הזרועות הפעילות</span>}
              </div>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" onClick={() => setArmsEdit(curList)}>
                <Smartphone className="h-4 w-4" /> זרועות שולחות
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setListEdit(curList)} aria-label="שינוי שם הרשימה" title="שינוי שם">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => deleteList(curList)} aria-label="מחיקת הרשימה" title="מחיקה">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {curStats.warn.length > 0 && (
            <div className="mt-3 rounded-xl bg-amber-50 p-3 ring-1 ring-inset ring-amber-600/20">
              <div className="flex items-start gap-2 text-sm text-amber-900">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <b className="tabular-nums">{curStats.warn.length}</b> קבוצות ברשימה לא זמינות ולא יקבלו נסיעות. אפשר להסיר אותן, או לכלול אותן בכל זאת – הן יחזרו לקבל
                  נסיעות כשיהיו זמינות.
                </span>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setRemoveRows(curStats.warn)}>
                  <ListMinus className="h-4 w-4" /> הסרה מהרשימה ({curStats.warn.length})
                </Button>
                <Button size="sm" variant="ghost" loading={busy} onClick={() => includeAnyway(curStats.warn.map((r) => r.id))}>
                  <ShieldCheck className="h-4 w-4" /> כלול בכל זאת ({curStats.warn.length})
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* filters + bulk actions – stay on screen while scrolling */}
      <div className="sticky top-[55px] z-20 -mx-4 mb-3 border-b border-slate-200/70 bg-[var(--bg)]/95 px-4 pb-3 pt-2 backdrop-blur-md md:top-0 md:mx-0 md:rounded-b-2xl md:px-0">
        {curList ? (
          <Segmented<'in' | 'add'>
            full
            className="mb-2"
            value={listMode}
            onChange={setListMode}
            options={[
              { value: 'in', label: 'הקבוצות ברשימה', count: rows.filter((r) => r.lists.includes(listF)).length },
              { value: 'add', label: 'קבוצות זמינות לצירוף', count: rows.filter(addable).length },
            ]}
          />
        ) : (
          <Segmented<'all' | 'none' | 'assigned'>
            full
            className="mb-2"
            value={assignF}
            onChange={setAssignF}
            options={[
              { value: 'all', label: 'כל הקבוצות', count: rows.length },
              { value: 'none', label: 'לא באף רשימה', count: rows.filter((r) => r.lists.length === 0).length },
              { value: 'assigned', label: 'כבר ברשימות', count: rows.filter((r) => r.lists.length > 0).length },
            ]}
          />
        )}
        {curList && listMode === 'add' && armsOfList(listF).length > 0 && (
          <label className="mb-2 flex cursor-pointer items-start gap-2.5 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20">
            <input type="checkbox" checked={addOthers} onChange={(e) => setAddOthers(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600" />
            <span>
              <b>הצג גם קבוצות של זרועות אחרות</b> – קבוצה שאין בה זרוע של הרשימה תתווסף יחד עם הזרוע שנמצאת בה, והזרוע הזו תצטרף לזרועות השולחות של הרשימה.
            </span>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input placeholder="חיפוש קבוצה…" value={q} onChange={(e) => setQ(e.target.value)} className="pr-9" aria-label="חיפוש קבוצה" />
          </div>
          <Select value={armF} onChange={(e) => setArmF(e.target.value)} className="w-auto" aria-label="סינון לפי זרוע">
            <option value="">כל הזרועות</option>
            {arms.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          {armF && can('admin') && (
            <Button size="sm" variant="secondary" onClick={refreshArm} disabled={armById[armF]?.status !== 'online'}>
              <RefreshCw className="h-4 w-4" /> רענון מ-WhatsApp
            </Button>
          )}
        </div>
        <div className="scroll-thin -mx-4 mt-2 overflow-x-auto px-4 md:mx-0 md:px-0">
          <Segmented<StatusF>
            value={statusF}
            onChange={setStatusF}
            options={[
              { value: 'all', label: 'הכול', count: counts.all },
              { value: 'ok', label: 'זמינות', count: counts.ok },
              { value: 'bad', label: 'לא זמינות', count: counts.bad },
              { value: 'off', label: 'מושבתות', count: counts.off },
            ]}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Checkbox
            checked={allShownSelected}
            onChange={(v) => {
              const s = new Set(sel);
              filtered.forEach((r) => (v ? s.add(r.id) : s.delete(r.id)));
              setSel(s);
            }}
            label={<span className="text-sm text-slate-700">בחירת כל המוצגות ({filtered.length.toLocaleString('he-IL')})</span>}
          />
          {sel.size > 0 && (
            <button onClick={() => setSel(new Set())} className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100">
              <X className="h-3.5 w-3.5" /> נבחרו {sel.size}
            </button>
          )}
        </div>
        {sel.size > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(!listF || listMode === 'add') && (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <ListPlus className="h-4 w-4" /> {curList ? `הוספה ל"${curList.name}"` : 'הוספה לרשימה'}
              </Button>
            )}
            {listF && listMode === 'in' && (
              <Button size="sm" variant="secondary" onClick={() => setRemoveRows(selRows.filter((r) => r.lists.includes(listF)))}>
                <ListMinus className="h-4 w-4" /> הסרה מהרשימה
              </Button>
            )}
            {selActive.length > 0 && (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => disable(selActive)}>
                <PauseCircle className="h-4 w-4" /> השבתה זמנית ({selActive.length})
              </Button>
            )}
            {selDisabled.length > 0 && (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => enable(selDisabled)}>
                <PlayCircle className="h-4 w-4" /> החזרה לפעילות ({selDisabled.length})
              </Button>
            )}
            {selIncludable.length > 0 && (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => includeAnyway(selIncludable)}>
                <ShieldCheck className="h-4 w-4" /> כלול בכל זאת ({selIncludable.length})
              </Button>
            )}
          </div>
        )}
      </div>

      {/* groups */}
      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <Empty
            icon={<UsersRound className="h-7 w-7" />}
            title={rows.length === 0 ? 'עדיין אין קבוצות' : 'לא נמצאו קבוצות'}
            text={
              rows.length === 0
                ? 'חבר זרוע, והקבוצות שהמספר שלה חבר בהן יופיעו כאן תוך דקה.'
                : listF && listMode === 'in' && !q
                  ? 'הרשימה עדיין ריקה. עבור ל"קבוצות זמינות לצירוף" ובחר קבוצות.'
                  : listF && listMode === 'add' && !q
                    ? 'אין קבוצות נוספות שהזרועות של הרשימה נמצאות בהן. צרף את הזרוע לעוד קבוצות בוואטסאפ, או הוסף לרשימה עוד זרועות שולחות.'
                    : statusF === 'bad'
                      ? 'אין כאן קבוצות לא זמינות – כל הקבוצות יכולות לקבל נסיעות.'
                      : 'נסה לשנות את החיפוש או הסינון.'
            }
            action={
              rows.length === 0 ? (
                <a href="/arms">
                  <Button>
                    <Smartphone className="h-4 w-4" /> לחיבור זרוע
                  </Button>
                </a>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {shown.map((r) => (
              <GroupRow
                key={r.id}
                r={r}
                on={sel.has(r.id)}
                armById={armById}
                listById={listById}
                listId={listF}
                otherArm={!!listF && listMode === 'add' && !viaListArms(r)}
                onToggle={() => {
                  const s = new Set(sel);
                  s.has(r.id) ? s.delete(r.id) : s.add(r.id);
                  setSel(s);
                }}
                onMenu={() => setActionsFor(r)}
              />
            ))}
          </ul>
        )}
        {filtered.length > shown.length && (
          <div className="border-t border-slate-100 p-3 text-center">
            <Button variant="secondary" onClick={() => setLimit(limit + PAGE)}>
              הצג עוד ({(filtered.length - shown.length).toLocaleString('he-IL')} נותרו)
            </Button>
          </div>
        )}
      </Card>

      <GroupActions
        row={actionsFor}
        busy={busy}
        onClose={() => setActionsFor(null)}
        onDisable={(id) => disable([id]).then(() => setActionsFor(null))}
        onEnable={(id) => enable([id]).then(() => setActionsFor(null))}
        onInclude={(id, v) => includeAnyway([id], v).then(() => setActionsFor(null))}
        onAddToList={(r) => {
          setSel(new Set([r.id]));
          setActionsFor(null);
          setAddOpen(true);
        }}
        armById={armById}
        listById={listById}
      />
      <AddToList
        open={addOpen}
        onClose={() => setAddOpen(false)}
        lists={lists}
        listArms={listArms}
        armById={armById}
        groups={selView}
        defaultList={listF}
        onDone={() => {
          setSel(new Set());
          load();
        }}
      />
      <RemoveFromList
        open={!!removeRows}
        onClose={() => setRemoveRows(null)}
        list={curList}
        groups={removeRows || []}
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

function ArmChip({ arm }: { arm: any }) {
  return (
    <span className="inline-flex max-w-[10rem] items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
      <Lamp tone={armTone(arm) as any} />
      <span className="truncate">{arm?.name || 'זרוע שנמחקה'}</span>
    </span>
  );
}

function ListCard({
  active,
  onClick,
  title,
  total,
  ok,
  bad,
  warn = 0,
  arms,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  total: number;
  ok: number;
  bad: number;
  warn?: number;
  arms?: any[];
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'flex min-w-[200px] max-w-[260px] shrink-0 flex-col gap-1.5 rounded-2xl border px-4 py-3 text-start transition',
        active ? 'border-indigo-300 bg-indigo-50/70 ring-1 ring-indigo-500/20' : 'border-slate-200/80 bg-white hover:border-slate-300',
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {bad > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-label={`${bad} קבוצות לא יקבלו נסיעות`} />}
          <span className={cx('truncate text-sm font-semibold', active ? 'text-indigo-800' : 'text-slate-900')}>{title}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-slate-500">{total.toLocaleString('he-IL')}</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span className="flex items-center gap-1 text-emerald-700">
          <Lamp tone="green" /> <span className="tabular-nums">{ok}</span> זמינות
        </span>
        <span className={cx('flex items-center gap-1', bad ? 'text-rose-700' : 'text-slate-400')}>
          <Lamp tone={bad ? 'red' : 'slate'} /> <span className="tabular-nums">{bad}</span> לא זמינות
        </span>
      </div>
      {arms && (
        <div className="flex flex-wrap items-center gap-1">
          {arms.length ? arms.slice(0, 3).map((a) => <ArmChip key={a.id} arm={a} />) : <span className="text-[11px] text-slate-500">כל הזרועות</span>}
          {arms.length > 3 && <span className="text-[11px] text-slate-500">+{arms.length - 3}</span>}
        </div>
      )}
      {warn > 0 && <span className="text-[11px] font-medium text-amber-700">{warn} לא זמינות שלא סומנו – לבדיקה</span>}
    </button>
  );
}

function GroupRow({
  r,
  on,
  armById,
  listById,
  listId,
  otherArm,
  onToggle,
  onMenu,
}: {
  r: Row;
  on: boolean;
  armById: Record<string, any>;
  listById: Record<string, any>;
  listId?: string;
  otherArm?: boolean;
  onToggle: () => void;
  onMenu: () => void;
}) {
  const tone = r.disabled ? 'slate' : r.available ? 'green' : 'red';
  return (
    <li className={cx('flex items-start gap-3 px-4 py-3 transition md:px-5', on ? 'bg-indigo-50/60' : 'hover:bg-slate-50/70')}>
      <input type="checkbox" checked={on} onChange={onToggle} aria-label={`בחירת ${r.name}`} className="mt-1 h-[18px] w-[18px] shrink-0 accent-indigo-600" />
      <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-start">
        <div className="flex items-center gap-2">
          <Lamp tone={tone} />
          <span className="truncate text-[15px] font-medium text-slate-900">{r.name}</span>
          {r.include && !r.available && (
            <Badge tone="slate" className="shrink-0">
              נכלל בכל זאת
            </Badge>
          )}
          {!listId && r.lists.length === 0 && (
            <Badge tone="amber" className="shrink-0">
              לא באף רשימה
            </Badge>
          )}
          {otherArm && (
            <Badge tone="amber" className="shrink-0">
              דרך זרוע אחרת
            </Badge>
          )}
        </div>
        <div className={cx('mt-0.5 text-xs', r.disabled ? 'text-slate-500' : r.available ? 'text-emerald-700' : 'text-rose-700')}>
          {r.available ? 'זמינה – מקבלת נסיעות' : GROUP_REASON[r.reason || 'unknown']}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-slate-400">זרועות בקבוצה:</span>
          {r.armIds.length ? r.armIds.map((id) => <ArmChip key={id} arm={armById[id]} />) : <span className="text-[11px] text-slate-400">אין</span>}
        </div>
        {r.lists.filter((id) => id !== listId).length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-[11px] font-medium text-indigo-700">{listId ? 'נמצאת גם ברשימות:' : 'ברשימות:'}</span>
            {r.lists
              .filter((id) => id !== listId)
              .map((id) => (
                <span key={id} className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
                  {listById[id]?.name || '—'}
                </span>
              ))}
          </div>
        )}
      </button>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <button type="button" onClick={onMenu} aria-label={`פעולות עבור ${r.name}`} className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800">
          <MoreHorizontal className="h-5 w-5" />
        </button>
        {r.participants != null && (
          <span className="flex items-center gap-1 text-xs tabular-nums text-slate-400" title="משתתפים">
            <Users className="h-3.5 w-3.5" />
            {r.participants}
          </span>
        )}
      </div>
    </li>
  );
}

function GroupActions({
  row,
  busy,
  onClose,
  onDisable,
  onEnable,
  onInclude,
  onAddToList,
  armById,
  listById,
}: {
  row: Row | null;
  busy: boolean;
  onClose: () => void;
  onDisable: (id: string) => void;
  onEnable: (id: string) => void;
  onInclude: (id: string, v: boolean) => void;
  onAddToList: (r: Row) => void;
  armById: Record<string, any>;
  listById: Record<string, any>;
}) {
  const r = row;
  const Item = ({ icon, title, text, onClick, danger }: { icon: React.ReactNode; title: string; text: string; onClick: () => void; danger?: boolean }) => (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-start transition hover:bg-slate-50 disabled:opacity-50"
    >
      <span className={cx('mt-0.5 shrink-0', danger ? 'text-rose-600' : 'text-slate-500')}>{icon}</span>
      <span>
        <span className="block text-[15px] font-medium text-slate-900">{title}</span>
        <span className="block text-sm leading-relaxed text-slate-500">{text}</span>
      </span>
    </button>
  );
  return (
    <Modal open={!!r} onClose={onClose} title={r?.name || ''}>
      {r && (
        <div className="space-y-3">
          <div className="rounded-xl bg-slate-50 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-slate-900">
              <Lamp tone={r.disabled ? 'slate' : r.available ? 'green' : 'red'} />
              {r.available ? 'זמינה – מקבלת נסיעות' : GROUP_REASON[r.reason || 'unknown']}
            </div>
            <div className="mt-1.5 text-slate-600">
              {r.armIds.length ? `זרועות בקבוצה: ${r.armIds.map((id) => armById[id]?.name || 'זרוע שנמחקה').join(', ')}` : 'אף זרוע אינה חברה בקבוצה'}
            </div>
            <div className="text-slate-600">{r.lists.length ? `ברשימות: ${r.lists.map((id) => listById[id]?.name || '—').join(', ')}` : 'לא משויכת לרשימה'}</div>
          </div>
          <div className="-mx-2">
            <Item icon={<ListPlus className="h-5 w-5" />} title="הוספה לרשימה" text="שיוך הקבוצה לרשימת הפצה" onClick={() => onAddToList(r)} />
            {r.disabled ? (
              <Item icon={<PlayCircle className="h-5 w-5" />} title="החזרה לפעילות" text="הקבוצה תחזור לקבל נסיעות מהרשימות שלה" onClick={() => onEnable(r.id)} />
            ) : (
              <Item
                icon={<PauseCircle className="h-5 w-5" />}
                title="השבתה זמנית"
                text="הקבוצה נשארת ברשימות אבל לא מקבלת נסיעות עד שתחזיר אותה"
                onClick={() => onDisable(r.id)}
              />
            )}
            {!r.available && !r.disabled && !r.include && (
              <Item
                icon={<ShieldCheck className="h-5 w-5" />}
                title="כלול בכל זאת"
                text="להשאיר ברשימות – הקבוצה תחזור לקבל נסיעות ברגע שתהיה זמינה. כל עוד היא לא זמינה, לא תהיה אליה שליחה."
                onClick={() => onInclude(r.id, true)}
              />
            )}
            {r.include && (
              <Item icon={<X className="h-5 w-5" />} title="ביטול 'כלול בכל זאת'" text="הקבוצה תיספר שוב באזהרות של הרשימה כשהיא לא זמינה" onClick={() => onInclude(r.id, false)} />
            )}
          </div>
        </div>
      )}
    </Modal>
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
    setShare(false);
    // only when the window opens – the screen refreshes every few seconds and must not reset the choice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const already = groups.filter((g) => listId !== 'new' && g.lists.includes(listId)).length;
  const unavailable = groups.filter((g) => !g.available).length;
  // a list with chosen sending arms can only reach groups one of those arms is in
  const chosenArms = listId === 'new' ? [] : listArms.filter((x) => x.list_id === listId).map((x) => x.arm_id);
  const unreachable = chosenArms.length ? groups.filter((g) => g.armIds.length && !g.armIds.some((a) => chosenArms.includes(a))) : [];
  const missingArms = [...new Set(unreachable.map((g) => g.armIds.find((a) => armById[a]?.is_active) || g.armIds[0]).filter(Boolean))] as string[];
  // other active arms that are in the chosen groups but don't send for this list: adding them shares the rides between all arms
  const otherArms = chosenArms.length
    ? ([...new Set(groups.flatMap((g) => g.armIds))].filter((a) => armById[a]?.is_active && !chosenArms.includes(a) && !missingArms.includes(a)) as string[])
    : [];
  const [share, setShare] = useState(false); // opt-in: adding arms changes who sends the whole list

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
      const armsToAdd = [...(addArms ? missingArms : []), ...(share ? otherArms : [])];
      if (armsToAdd.length) {
        const { error } = await sb()
          .from('list_arms')
          .upsert(armsToAdd.map((arm_id) => ({ list_id: id, arm_id })), { onConflict: 'list_id,arm_id' });
        if (error) throw error;
      }
      await logAct('list_saved', 'list', id, { added: groups.length, arms_added: armsToAdd.length });
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
        {otherArms.length > 0 && (
          <Checkbox
            checked={share}
            onChange={setShare}
            label={
              <span className="text-sm leading-relaxed">
                <b>חלוקת עבודה בין הזרועות:</b> בקבוצות שבחרת נמצאות גם {otherArms.map((a) => armById[a]?.name).join(', ')}. סמן רק אם אתה רוצה שגם הן ישלחו לרשימה הזו – הן
                יצטרפו לזרועות השולחות שלה, ובלשונית "לצירוף" יופיעו גם הקבוצות שלהן.
              </span>
            }
          />
        )}
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
                <Lamp tone={armTone(a) as any} />
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
