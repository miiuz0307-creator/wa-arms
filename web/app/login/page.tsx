'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, MessageCircle, ShieldCheck } from 'lucide-react';
import { FormNote, markUnlocked, RememberMe } from '@/components/AppLock';
import { ForgotPassword } from '@/components/ForgotPassword';
import { BrandMark, BrandWord } from '@/components/Brand';
import { sb, enterStationMode } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Field, Input, Segmented } from '@/components/ui';

type View = 'code' | 'phone' | 'owner';

/** `?next=/pay/…` – where to go after a successful login (same-site paths only). */
function nextPath(): string | null {
  try {
    const n = new URLSearchParams(window.location.search).get('next');
    return n && n.startsWith('/') && !n.startsWith('//') ? n : null;
  } catch {
    return null;
  }
}

/** Station login: store the token (enterStationMode goes to '/'), then continue to `next` when there is one. */
function enterStation(token: string) {
  enterStationMode(token);
  const n = nextPath();
  if (n) window.location.href = n;
}

export default function LoginPage() {
  const { session } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<View>('code');

  useEffect(() => {
    if (session) router.replace(nextPath() || '/');
  }, [session, router]);

  return (
    <div className="grid min-h-dvh bg-[var(--bg)] md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      {/* form – first in the DOM, so in RTL it sits on the right */}
      <div className="flex min-w-0 items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 md:hidden">
            <BrandMark size={44} />
            <div className="leading-tight">
              <BrandWord className="block text-xl text-slate-900" />
              <span className="text-xs text-slate-500">הפצת נסיעות לתחנות מוניות</span>
            </div>
          </div>

          <Segmented<View>
            value={view}
            onChange={setView}
            className="mb-7 flex w-full [&>button]:flex-1 [&>button]:justify-center [&>button]:py-2"
            options={[
              { value: 'code', label: <><KeyRound className="h-4 w-4" />קוד תחנה</> },
              { value: 'phone', label: <><MessageCircle className="h-4 w-4" />וואטסאפ</> },
              { value: 'owner', label: <><ShieldCheck className="h-4 w-4" />מנהל ראשי</> },
            ]}
          />

          {view === 'code' ? <CodeLogin /> : view === 'phone' ? <PhoneLogin /> : <OwnerLogin />}
        </div>
      </div>

      {/* desktop brand panel – always asphalt */}
      <aside className="relative hidden overflow-hidden bg-[#151920] p-12 text-white md:flex md:flex-col md:justify-between">
        <RouteLines />
        <div className="relative flex items-center gap-3">
          <BrandMark size={44} className="ring-1 ring-white/10 rounded-[11px]" />
          <BrandWord className="text-2xl text-white" />
        </div>
        <div className="relative max-w-md">
          <h1 className="text-[34px] font-bold leading-[1.2] tracking-tight lg:text-[40px]">
            נסיעה שנכנסת לתחנה יוצאת לכל הקבוצות שלך – תוך דקות.
          </h1>
          <p className="mt-5 text-[16px] leading-relaxed text-[#aeb6c1]">
            הסדרן כותב &quot;עזרה&quot; בוואטסאפ, ו-BotiX מפיץ את הנסיעה מכל מספרי התחנה לקבוצות הנכונות, בקצב שלא נחסם, ומראה לך מי קיבל ומי לא.
          </p>
        </div>
        <div className="relative text-sm text-white/40">
          © <BrandWord className="font-semibold" />
        </div>
      </aside>
    </div>
  );
}

/** The one decorative element: a route drawn in faint taxi amber. */
function RouteLines() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 600 800"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
    >
      <path d="M-40 640 C 120 600, 160 470, 300 455 S 520 380, 640 250" stroke="#FFC21A" strokeOpacity="0.16" strokeWidth="2" />
      <path d="M-40 640 C 120 600, 160 470, 300 455 S 520 380, 640 250" stroke="#FFC21A" strokeOpacity="0.28" strokeWidth="2" strokeDasharray="2 14" strokeLinecap="round" transform="translate(0 26)" />
      <circle cx="300" cy="455" r="5" fill="#FFC21A" fillOpacity="0.45" />
      <circle cx="300" cy="455" r="14" stroke="#FFC21A" strokeOpacity="0.18" />
    </svg>
  );
}

function FormTitle({ title, text }: { title: string; text: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[22px] font-bold tracking-tight text-slate-900">{title}</h2>
      <p className="mt-1 text-sm leading-relaxed text-slate-500">{text}</p>
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
    if (error) return setErr('אין חיבור לשרת כרגע. בדוק את האינטרנט ונסה שוב.');
    if (data?.error) return setErr(data.error);
    if (data?.token) {
      markUnlocked();
      enterStation(data.token);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <FormTitle title="כניסה לתחנה" text="הקלד את קוד הגישה של התחנה. את הקוד מקבלים ממנהל המערכת." />
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
          className="h-14 text-center font-mono text-xl tracking-[0.3em]"
          required
        />
      </Field>
      {err && <FormNote>{err}</FormNote>}
      <RememberMe />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        כניסה לתחנה
      </Button>
      <p className="text-center text-xs leading-relaxed text-slate-500">בכל פתיחה של האפליקציה תאשר שזה אתה – בטביעת אצבע, בזיהוי פנים או בקוד.</p>
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
      if (error || data?.error) return setErr(data?.error || 'לא הצלחנו לשלוח קוד. בדוק את המספר ונסה שוב.');
      setSent(true);
      return;
    }
    const { data, error } = await sb().rpc('otp_verify', { p_phone: phone, p_code: code });
    setBusy(false);
    if (error || data?.error) return setErr(data?.error || 'הקוד שגוי. בדוק את ההודעה בוואטסאפ ונסה שוב.');
    markUnlocked();
    enterStation(data.token);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <FormTitle
        title="כניסה עם הטלפון"
        text={sent ? 'אם המספר רשום כמנהל תחנה, נשלח אליו עכשיו קוד בוואטסאפ.' : 'הקלד את הטלפון של מנהל התחנה. נשלח אליו קוד בן 6 ספרות בוואטסאפ.'}
      />
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
            className="h-14 text-center font-mono text-xl tabular-nums tracking-[0.4em]"
            autoFocus
            required
          />
        </Field>
      )}
      {err && <FormNote>{err}</FormNote>}
      <RememberMe />
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
          className="h-10 w-full rounded-lg text-center text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        >
          מספר אחר או שליחה מחדש
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
  const [forgot, setForgot] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    if (mode === 'in') {
      const { error } = await sb().auth.signInWithPassword({ email, password });
      if (!error) markUnlocked();
      if (error) setMsg({ text: error.message.includes('Email not confirmed') ? 'צריך לאשר קודם את המייל. חפש את הודעת האימות בתיבת הדואר.' : 'האימייל או הסיסמה שגויים.' });
    } else {
      const { data, error } = await sb().auth.signUp({
        email,
        password,
        options: { data: { full_name: name }, emailRedirectTo: window.location.origin + '/login' },
      });
      if (error) setMsg({ text: error.message });
      else if (!data.session) setMsg({ ok: true, text: 'שלחנו לך מייל אימות. אשר אותו ואז היכנס.' });
    }
    setBusy(false);
  }

  if (forgot) return <ForgotPassword initialEmail={email} onBack={() => setForgot(false)} />;

  return (
    <form onSubmit={submit} className="space-y-5">
      <FormTitle
        title={mode === 'in' ? 'כניסת מנהל ראשי' : 'הרשמת צוות'}
        text={mode === 'in' ? 'כניסה עם אימייל וסיסמה.' : 'חשבון צוות של מנהל המערכת. החשבון ייפתח אחרי שהבעלים יאשר אותו.'}
      />
      {mode === 'up' && (
        <Field label="שם מלא">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
        </Field>
      )}
      <Field label="אימייל">
        <Input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      </Field>
      <div>
        <Field label="סיסמה" hint={mode === 'up' ? 'לפחות 8 תווים' : undefined}>
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
        {mode === 'in' && (
          <button type="button" onClick={() => setForgot(true)} className="mt-1.5 text-sm font-medium text-indigo-600 hover:underline">
            שכחתי סיסמה
          </button>
        )}
      </div>
      {msg && <FormNote ok={msg.ok}>{msg.text}</FormNote>}
      <RememberMe />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        {mode === 'in' ? 'כניסה' : 'יצירת חשבון'}
      </Button>
      <div className="border-t border-slate-200 pt-4 text-center text-sm text-slate-500">
        {mode === 'in' ? 'חבר צוות חדש? ' : 'כבר יש לך חשבון? '}
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'in' ? 'up' : 'in');
            setMsg(null);
          }}
          className="font-medium text-indigo-600 hover:underline"
        >
          {mode === 'in' ? 'הרשמה' : 'חזרה לכניסה'}
        </button>
      </div>
    </form>
  );
}
