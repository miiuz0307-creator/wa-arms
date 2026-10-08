'use client';
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useAuth, ROLE_LABEL, Role } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { Badge, Card, PageHeader, Select, Spinner, Toggle, toast } from '@/components/ui';

export default function UsersPage() {
  return (
    <RequireRole min="owner">
      <Users />
    </RequireRole>
  );
}

const ROLE_HELP: Record<Role, string> = {
  owner: 'שליטה מלאה, כולל משתמשים',
  admin: 'הכול חוץ מניהול משתמשים',
  operator: 'שליחה, קבוצות, רשימות וסדרנים',
  viewer: 'סטטיסטיקות והיסטוריה בלבד',
};

function Users() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<any[] | null>(null);

  const load = useCallback(async () => {
    const { data } = await sb().from('profiles').select('*').order('created_at');
    setRows(data || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function update(u: any, patch: any) {
    const { error } = await sb().from('profiles').update(patch).eq('id', u.id);
    if (error) return toast(error.message, 'error');
    await logAct('user_updated', 'user', u.id, { email: u.email, ...patch });
    toast('עודכן');
    load();
  }

  if (!rows) return <Spinner />;

  return (
    <>
      <PageHeader title="משתמשים והרשאות" subtitle="משתמש חדש נרשם במסך ההתחברות, ומופיע כאן לאישור" />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
          <Card key={r} className="p-3">
            <div className="text-sm font-semibold">{ROLE_LABEL[r]}</div>
            <div className="text-xs text-slate-500">{ROLE_HELP[r]}</div>
          </Card>
        ))}
      </div>
      <Card>
        <ul className="divide-y divide-slate-100">
          {rows.map((u) => {
            const me = u.id === profile?.id;
            return (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="grid h-10 w-10 place-items-center rounded-full bg-indigo-50 font-semibold text-indigo-700">
                  {(u.full_name || u.email || '?').slice(0, 1)}
                </div>
                <div className="min-w-48 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {u.full_name || '—'}
                    {me && <Badge tone="violet">אתה</Badge>}
                    {!u.is_active && <Badge tone="amber">ממתין לאישור</Badge>}
                  </div>
                  <div className="text-sm text-slate-500" dir="ltr" style={{ textAlign: 'right' }}>
                    {u.email}
                  </div>
                  <div className="text-xs text-slate-400">נרשם {timeAgo(u.created_at)}</div>
                </div>
                <Select value={u.role} disabled={me} onChange={(e) => update(u, { role: e.target.value })} className="w-40">
                  {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">{u.is_active ? 'פעיל' : 'חסום'}</span>
                  <Toggle checked={u.is_active} disabled={me} onChange={(v) => update(u, { is_active: v })} />
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
        <ShieldCheck className="h-3.5 w-3.5" />
        כל פעולה משמעותית נרשמת ביומן הפעילות.
      </p>
    </>
  );
}
