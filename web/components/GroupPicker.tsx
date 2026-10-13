'use client';
import { useMemo, useState } from 'react';
import { Search, SearchX, Users } from 'lucide-react';
import { cx, Input } from './ui';

export type PickGroup = { wa_group_id: string; name: string | null; participants?: number | null; armNames?: string[] };

export function GroupPicker({
  groups,
  selected,
  onChange,
  maxHeight = 'max-h-[420px]',
}: {
  groups: PickGroup[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  maxHeight?: string;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = t ? groups.filter((g) => (g.name || '').toLowerCase().includes(t)) : groups;
    return [...list].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));
  }, [groups, q]);

  const toggle = (id: string) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    onChange(s);
  };
  const selectAll = () => {
    const s = new Set(selected);
    filtered.forEach((g) => s.add(g.wa_group_id));
    onChange(s);
  };
  const clearAll = () => {
    const s = new Set(selected);
    filtered.forEach((g) => s.delete(g.wa_group_id));
    onChange(s);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="space-y-2.5 border-b border-slate-100 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input placeholder="חיפוש קבוצה לפי שם" aria-label="חיפוש קבוצה" value={q} onChange={(e) => setQ(e.target.value)} className="pr-9" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-slate-500">
            נבחרו <b className="font-semibold tabular-nums text-slate-900">{selected.size}</b> מתוך <span className="tabular-nums">{groups.length}</span>
          </span>
          <div className="flex gap-1">
            <button type="button" onClick={selectAll} className="h-8 rounded-lg px-2.5 text-[13px] font-medium text-indigo-600 hover:bg-indigo-50">
              {q.trim() ? 'בחירת כל התוצאות' : 'בחירת הכול'}
            </button>
            <button type="button" onClick={clearAll} className="h-8 rounded-lg px-2.5 text-[13px] font-medium text-slate-500 hover:bg-slate-100">
              ניקוי הבחירה
            </button>
          </div>
        </div>
      </div>
      <ul className={cx('scroll-thin divide-y divide-slate-100 overflow-y-auto', maxHeight)}>
        {filtered.length === 0 && (
          <li className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-slate-500">
            <SearchX className="h-6 w-6 text-slate-400" />
            {groups.length === 0 ? 'אין קבוצות בזרועות שנבחרו. בחר זרוע אחרת או רענן את הקבוצות במסך הזרועות.' : 'אין קבוצה בשם הזה. נסה מילה אחרת.'}
          </li>
        )}
        {filtered.map((g) => {
          const on = selected.has(g.wa_group_id);
          return (
            <li key={g.wa_group_id}>
              <label className={cx('flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2.5 transition', on ? 'bg-indigo-50/60' : 'hover:bg-slate-50')}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(g.wa_group_id)}
                  className="h-[18px] w-[18px] shrink-0 rounded border-slate-300 accent-indigo-600"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">{g.name || g.wa_group_id}</div>
                  {g.armNames && g.armNames.length > 0 && <div className="truncate text-xs text-slate-500">{g.armNames.join(' · ')}</div>}
                </div>
                {g.participants != null && (
                  <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-slate-500" title="משתתפים בקבוצה">
                    <Users className="h-3.5 w-3.5" aria-hidden />
                    <span className="sr-only">משתתפים:</span>
                    {g.participants}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Merge per-arm group rows into one entry per WhatsApp group. */
export function mergeGroups(rows: any[], armNames: Record<string, string>, armFilter?: Set<string>): PickGroup[] {
  const map = new Map<string, PickGroup>();
  for (const r of rows) {
    if (armFilter && !armFilter.has(r.arm_id)) continue;
    const g = map.get(r.wa_group_id) || { wa_group_id: r.wa_group_id, name: r.name, participants: r.participants, armNames: [] };
    if (armNames[r.arm_id]) g.armNames!.push(armNames[r.arm_id]);
    map.set(r.wa_group_id, g);
  }
  return [...map.values()];
}
