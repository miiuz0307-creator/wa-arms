'use client';
// Every time the app is opened (and after 5 minutes in the background) the user has to prove it is them:
// fingerprint / face (this device's own biometric unlock, via WebAuthn), or – without it – the station code,
// a WhatsApp code to the manager's phone, or (main admin) the password.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Fingerprint, KeyRound, LogOut, MessageCircle, X } from 'lucide-react';
import { sb, enterStationMode } from '@/lib/supabase';
import { BrandMark } from './Brand';
import { Button, Card, Field, Input, cx } from './ui';

const KEY = 'wa-lock-cred';
const LAST = 'wa-last-active';
const IDLE_MS = 5 * 60_000;
const ASKED = 'wa-lock-asked';

const REMEMBER = 'wa-remember-until';
const REMEMBER_CHOICE = 'wa-remember-choice';
const REMEMBER_DAYS = 30;

/** "Remember me" on this device: no lock screen for 30 days (until sign-out). */
export function rememberValid() {
  try {
    return Number(localStorage.getItem(REMEMBER) || 0) > Date.now();
  } catch {
    return false;
  }
}
export function forgetDevice() {
  try {
    localStorage.removeItem(REMEMBER);
  } catch {}
}

/** Call right after a successful login, so the app doesn't ask again a second later. */
export function markUnlocked() {
  try {
    localStorage.setItem(LAST, String(Date.now()));
    sessionStorage.setItem('wa-unlocked', '1');
    if (localStorage.getItem(REMEMBER_CHOICE) === '1') localStorage.setItem(REMEMBER, String(Date.now() + REMEMBER_DAYS * 86_400_000));
  } catch {}
}

/** Checkbox shown on the login and lock screens. */
export function RememberMe() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(localStorage.getItem(REMEMBER_CHOICE) === '1');
    } catch {}
  }, []);
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-snug text-slate-600">
      <input
        type="checkbox"
        className="mt-0.5 h-[18px] w-[18px] shrink-0 rounded border-slate-300 accent-indigo-600"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          try {
            localStorage.setItem(REMEMBER_CHOICE, e.target.checked ? '1' : '0');
            if (!e.target.checked) localStorage.removeItem(REMEMBER);
          } catch {}
        }}
      />
      <span>
        לזכור אותי במכשיר הזה
        <span className="block text-xs text-slate-500">
          <span className="tabular-nums">{REMEMBER_DAYS}</span> יום בלי לבקש קוד בכל פתיחה
        </span>
      </span>
    </label>
  );
}

/** Inline message under a login / lock form (the toast host is not mounted on these screens). */
export function FormNote({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <div
      role={ok ? 'status' : 'alert'}
      className={cx(
        'flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm leading-relaxed ring-1 ring-inset',
        ok ? 'bg-emerald-50 text-emerald-800 ring-emerald-600/20' : 'bg-rose-50 text-rose-700 ring-rose-600/20',
      )}
    >
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n)) as unknown as BufferSource;

export async function biometricAvailable() {
  try {
    return typeof window !== 'undefined' && !!window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

async function registerBiometric(name: string) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: rand(32),
      rp: { name: 'BotiX', id: window.location.hostname },
      user: { id: rand(16), name, displayName: name },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('לא הופעל');
  set(KEY, b64(cred.rawId));
}

async function checkBiometric() {
  const id = get(KEY);
  if (!id) return false;
  const res = await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: unb64(id) as unknown as BufferSource }],
      userVerification: 'required',
      timeout: 60_000,
      rpId: window.location.hostname,
    },
  });
  return !!res;
}

export function AppLock({
  isStation,
  ownerEmail,
  name,
  onSignOut,
  children,
}: {
  isStation: boolean;
  ownerEmail: string | null;
  name: string;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  const [locked, setLocked] = useState(true); // locked on every app start (unless "remember me")
  const [hasBio, setHasBio] = useState(false);
  const [offerBio, setOfferBio] = useState(false);
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    setHasBio(!!get(KEY));
    if (rememberValid()) return setLocked(false);
    const last = Number(get(LAST) || 0);
    // a reload a moment ago (e.g. switching station) does not ask again
    if (last && Date.now() - last < 15_000 && sessionStorage.getItem('wa-unlocked') === '1') setLocked(false);
  }, []);

  // lock again after 5 minutes in the background
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > IDLE_MS && !rememberValid()) setLocked(true);
    };
    const beat = setInterval(() => !locked && set(LAST, String(Date.now())), 5_000);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(beat);
    };
  }, [locked]);

  const unlock = useCallback(() => {
    setLocked(false);
    markUnlocked();
  }, []);

  // after unlocking without biometrics: offer to turn them on (once per device)
  useEffect(() => {
    if (locked || hasBio || get(ASKED)) return;
    biometricAvailable().then((ok) => ok && setOfferBio(true));
  }, [locked, hasBio]);

  if (locked)
    return (
      <LockScreen
        isStation={isStation}
        ownerEmail={ownerEmail}
        hasBio={hasBio}
        onUnlock={unlock}
        onSignOut={() => {
          forgetDevice();
          onSignOut();
        }}
      />
    );

  return (
    <>
      {offerBio && (
        <div
          role="dialog"
          aria-label="כניסה בטביעת אצבע"
          className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-md animate-rise rounded-2xl bg-[#151920] p-4 text-white shadow-[var(--shadow-pop)] ring-1 ring-white/10 md:bottom-6"
        >
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10">
              <Fingerprint className="h-5 w-5 text-[#7ee2b8]" />
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold">כניסה בטביעת אצבע או בזיהוי פנים</div>
              <div className="mt-0.5 leading-relaxed text-white/70">בכל פתיחה של האפליקציה תאשר בנגיעה אחת. בלי זה תצטרך להקליד קוד בכל פעם.</div>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="success"
                  onClick={async () => {
                    try {
                      await registerBiometric(name);
                      setHasBio(true);
                    } catch {}
                    set(ASKED, '1');
                    setOfferBio(false);
                  }}
                >
                  <Fingerprint className="h-4 w-4" />
                  הפעלה
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="!text-white/70 hover:!bg-white/10 hover:!text-white"
                  onClick={() => {
                    set(ASKED, '1');
                    setOfferBio(false);
                  }}
                >
                  לא עכשיו
                </Button>
              </div>
            </div>
            <button
              type="button"
              aria-label="סגירה"
              onClick={() => {
                set(ASKED, '1');
                setOfferBio(false);
              }}
              className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      {children}
    </>
  );
}

function LockScreen({
  isStation,
  ownerEmail,
  hasBio,
  onUnlock,
  onSignOut,
}: {
  isStation: boolean;
  ownerEmail: string | null;
  hasBio: boolean;
  onUnlock: () => void;
  onSignOut: () => void;
}) {
  const [mode, setMode] = useState<'bio' | 'code' | 'phone' | 'password'>(hasBio ? 'bio' : isStation ? 'code' : 'password');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState(false);
  const tried = useRef(false);

  const bio = useCallback(async () => {
    setErr(null);
    try {
      if (await checkBiometric()) onUnlock();
    } catch {
      setErr('הזיהוי לא הצליח. נסה שוב או היכנס בדרך אחרת.');
    }
  }, [onUnlock]);
  useEffect(() => {
    if (mode === 'bio' && !tried.current) {
      tried.current = true;
      bio();
    }
  }, [mode, bio]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'password') {
        const { error } = await sb().auth.signInWithPassword({ email: ownerEmail || '', password: value });
        if (error) return setErr('סיסמה שגויה');
        onUnlock();
      } else if (mode === 'code') {
        const { data, error } = await sb().rpc('station_login', { p_code: value });
        if (error || data?.error) return setErr(data?.error || 'קוד שגוי');
        markUnlocked();
        enterStationMode(data.token);
      } else if (mode === 'phone') {
        if (!sent) {
          const { data, error } = await sb().rpc('otp_request', { p_phone: phone });
          if (error || data?.error) return setErr(data?.error || 'לא הצלחנו לשלוח קוד');
          setSent(true);
        } else {
          const { data, error } = await sb().rpc('otp_verify', { p_phone: phone, p_code: value });
          if (error || data?.error) return setErr(data?.error || 'קוד שגוי');
          markUnlocked();
          enterStationMode(data.token);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (m: typeof mode) => {
    setMode(m);
    setValue('');
    setErr(null);
    if (m === 'phone') setSent(false);
  };
  const others: { m: typeof mode; label: string; icon: any }[] = [
    ...(hasBio && mode !== 'bio' ? [{ m: 'bio' as const, label: 'טביעת אצבע', icon: Fingerprint }] : []),
    ...(isStation && mode !== 'code' ? [{ m: 'code' as const, label: 'קוד תחנה', icon: KeyRound }] : []),
    ...(isStation && mode !== 'phone' ? [{ m: 'phone' as const, label: 'קוד בוואטסאפ', icon: MessageCircle }] : []),
    ...(!isStation && mode !== 'password' ? [{ m: 'password' as const, label: 'סיסמה', icon: KeyRound }] : []),
  ];

  return (
    <div className="grid min-h-dvh place-items-center bg-[var(--bg)] p-4 sm:p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandMark size={52} />
          <h1 className="mt-4 text-[22px] font-bold tracking-tight text-slate-900">האפליקציה נעולה</h1>
          <p className="mt-1 text-sm text-slate-500">כדי להמשיך, אשר שזה אתה.</p>
        </div>

        <Card className="p-5">
          {mode === 'bio' ? (
            <div className="text-center">
              <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-indigo-50 text-indigo-600">
                <Fingerprint className="h-8 w-8" />
              </div>
              <Button size="lg" className="w-full" onClick={bio}>
                <Fingerprint className="h-5 w-5" />
                פתיחה בטביעת אצבע / זיהוי פנים
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {mode === 'phone' && (
                <Field label="מספר הטלפון של מנהל התחנה">
                  <Input dir="ltr" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" disabled={sent} required autoComplete="tel" />
                </Field>
              )}
              {(mode !== 'phone' || sent) && (
                <Field label={mode === 'password' ? 'הסיסמה שלך' : mode === 'code' ? 'קוד התחנה' : 'הקוד שקיבלת בוואטסאפ'}>
                  <Input
                    dir="ltr"
                    type={mode === 'password' ? 'password' : 'text'}
                    inputMode={mode === 'phone' ? 'numeric' : undefined}
                    autoComplete={mode === 'password' ? 'current-password' : 'one-time-code'}
                    value={value}
                    onChange={(e) => setValue(mode === 'code' ? e.target.value.toUpperCase() : e.target.value)}
                    className={cx('text-center tabular-nums', mode !== 'password' && 'font-mono text-lg tracking-widest')}
                    autoFocus
                    required
                  />
                </Field>
              )}
              <Button type="submit" size="lg" className="w-full" loading={busy}>
                {mode === 'phone' && !sent ? 'שליחת קוד בוואטסאפ' : 'פתיחה'}
              </Button>
            </form>
          )}
          {err && (
            <div className="mt-4">
              <FormNote>{err}</FormNote>
            </div>
          )}
          <div className="mt-4 border-t border-slate-100 pt-4">
            <RememberMe />
          </div>
        </Card>

        <div className="mt-5 flex flex-wrap justify-center gap-1">
          {others.map((o) => (
            <button
              key={o.m}
              type="button"
              onClick={() => switchTo(o.m)}
              className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              <o.icon className="h-4 w-4" />
              {o.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onSignOut}
            className="flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-500 hover:bg-rose-50 hover:text-rose-700"
          >
            <LogOut className="h-4 w-4" />
            יציאה מהחשבון
          </button>
        </div>
      </div>
    </div>
  );
}
