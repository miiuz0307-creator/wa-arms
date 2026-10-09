'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { sb, enterStationMode } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<'code' | 'owner'>('code');

  useEffect(() => {
    if (session) router.replace('/');
  }, [session, router]);

  return (
    <div className="grid min-h-dvh md:grid-cols-2">
      <div className="brand-gradient relative hidden overflow-hidden p-12 text-white md:flex md:flex-col md:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-white/20 text-xl font-bold backdrop-blur">ז</div>
          <span className="text-xl font-bold">זרועות</span>
        </div>
        <div>
          <h1 className="text-4xl font-bold leading-tight">
            הפצת נסיעות לתחנה שלך.
            <br />
            בלחיצה אחת.
          </h1>
          <p className="mt-4 max-w-md text-white/80">חיבור מספרי WhatsApp, קבוצות ורשימות הפצה, והפצה אוטומטית של "עזרה" – הכול בזמן אמת.</p>
        </div>
        <div className="text-sm text-white/60">© זרועות</div>
        <div className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="md:hidden">
            <div className="brand-gradient mb-6 grid h-12 w-12 place-items-center rounded-xl text-xl font-bold text-white">ז</div>
          </div>
          {view === 'code' ? <CodeLogin /> : <OwnerLogin />}
          <button
            type="button"
            onClick={() => setView(view === 'code' ? 'owner' : 'code')}
            className="mt-6 flex w-full items-center justify-center gap-1.5 text-center text-sm font-medium text-slate-500 hover:text-indigo-600"
          >
            {view === 'code' ? (
              <>
                <ShieldCheck className="h-4 w-4" />
                כניסת מנהל ראשי
              </>
            ) : (
              <>
                <KeyRound className="h-4 w-4" />
                כניסה עם קוד תחנה
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function CodeLogin() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setErr(null);
    const { data, error } = await sb().rpc('station_login', { p_code: code });
    setBusy(false);
    if (error) return setErr('לא הצלחנו להתחבר. נסה שוב.');
    if (data?.error) return setErr(data.error);
    if (data?.token) enterStationMode(data.token);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold">כניסה לתחנה</h2>
        <p className="mt-1 text-sm text-slate-500">הזן את קוד הגישה שקיבלת ממנהל המערכת.</p>
      </div>
      <Field label="קוד גישה">
        <Input
          ref={ref as any}
          dir="ltr"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="XXXXXXXX"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          className="text-center font-mono text-xl tracking-[0.3em]"
          required
        />
      </Field>
      {err && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{err}</div>}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        כניסה
      </Button>
      <p className="text-center text-xs text-slate-400">החיבור נשמר במכשיר הזה – לא צריך להקליד את הקוד בכל כניסה.</p>
    </form>
  );
}

function OwnerLogin() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);

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
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold">{mode === 'in' ? 'כניסת מנהל ראשי' : 'הרשמת צוות'}</h2>
        <p className="mt-1 text-sm text-slate-500">
          {mode === 'in' ? 'כניסה עם אימייל וסיסמה.' : 'חשבון צוות של מנהל המערכת. ממתין לאישור הבעלים.'}
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
        <div className={msg.ok ? 'rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800' : 'rounded-xl bg-rose-50 p-3 text-sm text-rose-700'}>{msg.text}</div>
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
        className="w-full text-center text-xs font-medium text-slate-400 hover:text-indigo-600"
      >
        {mode === 'in' ? 'חשבון צוות חדש' : 'חזרה לכניסה'}
      </button>
    </form>
  );
}
