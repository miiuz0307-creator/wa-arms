'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, MessageCircle, ShieldCheck } from 'lucide-react';
import { markUnlocked } from '@/components/AppLock';
import { sb, enterStationMode } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<'code' | 'phone' | 'owner'>('code');

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
          {view === 'code' ? <CodeLogin /> : view === 'phone' ? <PhoneLogin /> : <OwnerLogin />}
          <div className="mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm font-medium text-slate-500">
            {view !== 'code' && (
              <button type="button" onClick={() => setView('code')} className="flex items-center gap-1.5 hover:text-indigo-600">
                <KeyRound className="h-4 w-4" />
                קוד תחנה
              </button>
            )}
            {view !== 'phone' && (
              <button type="button" onClick={() => setView('phone')} className="flex items-center gap-1.5 hover:text-indigo-600">
                <MessageCircle className="h-4 w-4" />
                כניסה עם הטלפון
              </button>
            )}
            {view !== 'owner' && (
              <button type="button" onClick={() => setView('owner')} className="flex items-center gap-1.5 hover:text-indigo-600">
                <ShieldCheck className="h-4 w-4" />
                מנהל ראשי
              </button>
            )}
          </div>
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
    if (data?.token) {
      markUnlocked();
      enterStationMode(data.token);
    }
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
      <p className="text-center text-xs text-slate-400">בכל פתיחה של האפליקציה תתבקש לאשר שזה אתה – בטביעת אצבע / זיהוי פנים, או בקוד.</p>
    </form>
  );
}

// manager's phone → a 6-digit code on WhatsApp → in
function PhoneLogin() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    if (!sent) {
      const { data, error } = await sb().rpc('otp_request', { p_phone: phone });
      setBusy(false);
      if (error || data?.error) return setErr(data?.error || 'לא הצלחנו לשלוח קוד. נסה שוב.');
      setSent(true);
      return;
    }
    const { data, error } = await sb().rpc('otp_verify', { p_phone: phone, p_code: code });
    setBusy(false);
    if (error || data?.error) return setErr(data?.error || 'קוד שגוי');
    markUnlocked();
    enterStationMode(data.token);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold">כניסה עם הטלפון</h2>
        <p className="mt-1 text-sm text-slate-500">
          {sent ? 'אם המספר רשום כמנהל תחנה, נשלח אליו קוד בוואטסאפ.' : 'הזן את מספר הטלפון של מנהל התחנה. נשלח אליו קוד בוואטסאפ.'}
        </p>
      </div>
      <Field label="מספר טלפון">
        <Input dir="ltr" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" disabled={sent} required autoComplete="tel" />
      </Field>
      {sent && (
        <Field label="הקוד מוואטסאפ">
          <Input
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            className="text-center font-mono text-xl tracking-[0.4em]"
            autoFocus
            required
          />
        </Field>
      )}
      {err && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{err}</div>}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        {sent ? 'כניסה' : 'שליחת קוד בוואטסאפ'}
      </Button>
      {sent && (
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setCode('');
            setErr(null);
          }}
          className="w-full text-center text-xs font-medium text-slate-400 hover:text-indigo-600"
        >
          מספר אחר / שליחה מחדש
        </button>
      )}
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
      if (!error) markUnlocked();
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
