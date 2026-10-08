'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);

  useEffect(() => {
    if (session) router.replace('/');
  }, [session, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    if (mode === 'in') {
      const { error } = await sb().auth.signInWithPassword({ email, password });
      if (error) setMsg({ text: error.message.includes('Email not confirmed') ? 'יש לאשר קודם את המייל (בדוק את תיבת הדואר).' : 'אימייל או סיסמה שגויים.' });
    } else {
      const { data, error } = await sb().auth.signUp({
        email,
        password,
        options: { data: { full_name: name }, emailRedirectTo: window.location.origin + '/login' },
      });
      if (error) setMsg({ text: error.message });
      else if (!data.session) setMsg({ ok: true, text: 'נשלח אליך מייל אימות. אשר אותו ואז התחבר.' });
    }
    setBusy(false);
  }

  return (
    <div className="grid min-h-dvh md:grid-cols-2">
      <div className="brand-gradient relative hidden overflow-hidden p-12 text-white md:flex md:flex-col md:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-white/20 text-xl font-bold backdrop-blur">ז</div>
          <span className="text-xl font-bold">זרועות</span>
        </div>
        <div>
          <h1 className="text-4xl font-bold leading-tight">כל הזרועות שלך.
            <br />
            מסך אחד.
          </h1>
          <p className="mt-4 max-w-md text-white/80">חיבור מספרי WhatsApp, ניהול קבוצות, הפצה ידנית ואוטומטית – הכול בזמן אמת.</p>
        </div>
        <div className="text-sm text-white/60">© זרועות</div>
        <div className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="md:hidden">
            <div className="brand-gradient mb-6 grid h-12 w-12 place-items-center rounded-xl text-xl font-bold text-white">ז</div>
          </div>
          <div>
            <h2 className="text-2xl font-bold">{mode === 'in' ? 'התחברות' : 'הרשמה'}</h2>
            <p className="mt-1 text-sm text-slate-500">
              {mode === 'in' ? 'ברוך שובך. הזן את פרטי ההתחברות.' : 'המשתמש הראשון במערכת הופך לבעלים. משתמשים נוספים ממתינים לאישור.'}
            </p>
          </div>
          {mode === 'up' && (
            <Field label="שם מלא">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
          )}
          <Field label="אימייל">
            <Input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </Field>
          <Field label="סיסמה">
            <Input
              type="password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            />
          </Field>
          {msg && (
            <div className={msg.ok ? 'rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800' : 'rounded-xl bg-rose-50 p-3 text-sm text-rose-700'}>
              {msg.text}
            </div>
          )}
          <Button type="submit" size="lg" className="w-full" loading={busy}>
            {mode === 'in' ? 'כניסה' : 'יצירת חשבון'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'in' ? 'up' : 'in');
              setMsg(null);
            }}
            className="w-full text-center text-sm font-medium text-indigo-600"
          >
            {mode === 'in' ? 'אין לך חשבון? להרשמה' : 'כבר רשום? להתחברות'}
          </button>
        </form>
      </div>
    </div>
  );
}
