'use client';
import { useCallback, useEffect, useState } from 'react';
import { Copy, Crown, ShieldCheck, UsersRound } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useAuth, ROLE_LABEL, Role } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Empty, PageHeader, Section, Select, Skeleton, Toggle, ask, toast } from '@/components/ui';

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
  const { profile, isSuper } = useAuth();
  const [rows, setRows] = useState<any[] | null>(null);

  const load = useCallback(async () => {
    const { data } = await sb().from('profiles').select('*').order('created_at'); // rows: bounded – the system's staff accounts
    setRows(data || []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function update(u: any, patch: any) {
    const { error } = await sb().from('profiles').update(patch).eq('id', u.id);
    if (error) return toast(`השינוי לא נשמר: ${error.message}`, 'error');
    await logAct('user_updated', 'user', u.id, { email: u.email, ...patch });
    toast('ההרשאות עודכנו');
    load();
  }

  const header = <PageHeader title="משתמשים והרשאות" subtitle="מי נכנס למערכת ומה כל אחד רשאי לעשות. משתמש חדש נרשם במסך הכניסה ומופיע כאן לאישור." />;

  if (!rows)
    return (
      <>
        {header}
        <div className="space-y-4" role="status" aria-label="טוען">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      </>
    );

  const waiting = rows.filter((u) => !u.is_active).length;

  return (
    <>
      {header}
      {isSuper && (
        <Card className="mb-4 flex flex-col gap-3 p-4 md:flex-row md:items-center md:p-5">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600">
            <Crown className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-semibold text-slate-900">הוספת מנכ״ל</div>
            <div className="mt-0.5 leading-relaxed text-slate-600">
              שלח לו את הקישור. הוא נרשם עם מייל וסיסמה, מופיע כאן ברשימה, ואתה לוחץ אצלו ״מנכ״ל״. מנכ״ל רואה ועושה הכול כמוך – כל התחנות, מרכז הבקרה והתשלומים – חוץ
              משינוי ההרשאות שלך.
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              navigator.clipboard?.writeText(`הצטרפות למערכת: ${window.location.origin}/login\nנרשמים עם מייל וסיסמה, ואני מאשר.`);
              toast('הקישור הועתק');
            }}
          >
            <Copy className="h-4 w-4" />
            העתקת קישור הרשמה
          </Button>
        </Card>
      )}

      <dl className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
          <Card key={r} className="p-3.5">
            <dt className="text-sm font-semibold text-slate-900">{ROLE_LABEL[r]}</dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-slate-500">{ROLE_HELP[r]}</dd>
          </Card>
        ))}
      </dl>

      <Section
        title="משתמשים"
        icon={<UsersRound className="h-4 w-4" />}
        action={
          waiting > 0 ? (
            <Badge tone="amber" dot>
              <span className="tabular-nums">{waiting}</span> ממתינים לאישור
            </Badge>
          ) : (
            <span className="text-xs tabular-nums text-slate-500">{rows.length}</span>
          )
        }
      >
        {rows.length === 0 ? (
          <Empty icon={<UsersRound className="h-7 w-7" />} title="עדיין אין משתמשים" text="שלח את קישור ההרשמה – מי שנרשם יופיע כאן לאישור." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((u) => {
              const me = u.id === profile?.id;
              const locked = me || u.is_primary;
              return (
                <li key={u.id} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-100 font-semibold text-slate-700">
                      {(u.full_name || u.email || '?').slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 font-medium text-slate-900">
                        <span className="truncate">{u.full_name || '—'}</span>
                        {me && <Badge tone="sky">אתה</Badge>}
                        {u.is_primary && <Badge tone="slate">בעלים ראשי</Badge>}
                        {u.title && !u.is_primary && <Badge tone="slate">{u.title}</Badge>}
                        {!u.is_active && (
                          <Badge tone="amber" dot>
                            ממתין לאישור
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-sm text-slate-500" dir="ltr" style={{ textAlign: 'right' }}>
                        {u.email}
                      </div>
                      <div className="text-xs text-slate-400">נרשם {timeAgo(u.created_at)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 ps-[52px] md:ps-0">
                    {isSuper && !me && !u.is_primary && u.title !== 'מנכ"ל' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={async () => {
                          if (
                            await ask({
                              title: `להגדיר את ${u.full_name || u.email} כמנכ״ל?`,
                              text: 'הוא יקבל גישה מלאה לכל המערכת – כל התחנות, מרכז הבקרה והתשלומים.',
                              ok: 'הגדרה כמנכ״ל',
                            })
                          )
                            update(u, { role: 'owner', is_active: true, title: 'מנכ"ל' });
                        }}
                      >
                        <Crown className="h-4 w-4" />
                        מנכ״ל
                      </Button>
                    )}
                    <Select
                      value={u.role}
                      disabled={locked}
                      aria-label={`ההרשאה של ${u.full_name || u.email}`}
                      onChange={(e) => update(u, { role: e.target.value, ...(e.target.value !== 'owner' ? { title: null } : {}) })}
                      className="w-40"
                    >
                      {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                    <div className="flex items-center gap-2">
                      <Toggle checked={u.is_active} disabled={locked} onChange={(v) => update(u, { is_active: v })} label={`גישה פעילה ל${u.full_name || u.email}`} />
                      <span className={u.is_active ? 'w-10 text-xs text-emerald-700' : 'w-10 text-xs text-slate-500'}>{u.is_active ? 'פעיל' : 'חסום'}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
        <ShieldCheck className="h-3.5 w-3.5" />
        כל שינוי בהרשאות נרשם ביומן הפעילות.
      </p>
    </>
  );
}
