'use client';
// Every time the app is opened (and after 5 minutes in the background) the user has to prove it is them:
// fingerprint / face (this device's own biometric unlock, via WebAuthn), or – without it – the station code,
// a WhatsApp code to the manager's phone, or (main admin) the password.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Fingerprint, KeyRound, LogOut, MessageCircle, ShieldCheck } from 'lucide-react';
import { sb, enterStationMode } from '@/lib/supabase';
import { Button, Field, Input } from './ui';

const KEY = 'wa-lock-cred';
const LAST = 'wa-last-active';
const IDLE_MS = 5 * 60_000;
const ASKED = 'wa-lock-asked';

/** Call right after a successful login, so the app doesn't ask again a second later. */
export function markUnlocked() {
  try {
    localStorage.setItem(LAST, String(Date.now()));
    sessionStorage.setItem('wa-unlocked', '1');
  } catch {}
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
      rp: { name: 'זרועות', id: window.location.hostname },
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
  const [locked, setLocked] = useState(true); // locked on every app start
  const [hasBio, setHasBio] = useState(false);
  const [offerBio, setOfferBio] = useState(false);
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    setHasBio(!!get(KEY));
    const last = Number(get(LAST) || 0);
    // a reload a moment ago (e.g. switching station) does not ask again
    if (last && Date.now() - last < 15_000 && sessionStorage.getItem('wa-unlocked') === '1') setLocked(false);
  }, []);

  // lock again after 5 minutes in the background
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') hiddenAt.current = Date.now();
      else if (hiddenAt.current && Date.now() - hiddenAt.current > IDLE_MS) setLocked(true);
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
    set(LAST, String(Date.now()));
    try {
      sessionStorage.setItem('wa-unlocked', '1');
    } catch {}
  }, []);

  // after unlocking without biometrics: offer to turn them on (once per device)
  useEffect(() => {
    if (locked || hasBio || get(ASKED)) return;
    biometricAvailable().then((ok) => ok && setOfferBio(true));
  }, [locked, hasBio]);

  if (locked) return <LockScreen isStation={isStation} ownerEmail={ownerEmail} hasBio={hasBio} onUnlock={unlock} onSignOut={onSignOut} />;

  return (
    <>
      {offerBio && (
        <div className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-md rounded-2xl bg-slate-900 p-4 text-white shadow-2xl md:bottom-6">
          <div className="flex items-start gap-3">
            <Fingerprint className="mt-0.5 h-6 w-6 shrink-0 text-emerald-400" />
            <div className="flex-1 text-sm">
              <div className="font-semibold">כניסה בטביעת אצבע / זיהוי פנים</div>
              <div className="mt-0.5 text-white/70">בכל פתיחה של האפליקציה תתבקש לאשר. בלי זה תצטרך להזין קוד בכל פעם.</div>
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
                  הפעלה
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-white/70 hover:bg-white/10"
                  onClick={() => {
                    set(ASKED, '1');
                    setOfferBio(false);
                  }}
                >
                  לא עכשיו
                </Button>
              </div>
            </div>
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

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 p-6">
      <div className="w-full max-w-sm text-center">
        <div className="brand-gradient mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl text-white shadow-lg">
          <ShieldCheck className="h-7 w-7" />
        </div>
        <h1 className="text-xl font-bold">האפליקציה נעולה</h1>
        <p className="mt-1 text-sm text-slate-500">אשר שזה אתה כדי להמשיך</p>

        {mode === 'bio' ? (
          <Button size="lg" className="mt-6 w-full" onClick={bio}>
            <Fingerprint className="h-5 w-5" />
            טביעת אצבע / זיהוי פנים
          </Button>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3 text-right">
            {mode === 'phone' && (
              <Field label="מספר הטלפון של מנהל התחנה">
                <Input dir="ltr" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" disabled={sent} required />
              </Field>
            )}
            {(mode !== 'phone' || sent) && (
              <Field label={mode === 'password' ? 'סיסמה' : mode === 'code' ? 'קוד התחנה' : 'הקוד שקיבלת בוואטסאפ'}>
                <Input
                  dir="ltr"
                  type={mode === 'password' ? 'password' : 'text'}
                  inputMode={mode === 'phone' ? 'numeric' : undefined}
                  autoComplete={mode === 'password' ? 'current-password' : 'one-time-code'}
                  value={value}
                  onChange={(e) => setValue(mode === 'code' ? e.target.value.toUpperCase() : e.target.value)}
                  className="text-center font-mono text-lg tracking-widest"
                  autoFocus
                  required
                />
              </Field>
            )}
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {mode === 'phone' && !sent ? 'שליחת קוד בוואטסאפ' : 'כניסה'}
            </Button>
          </form>
        )}
        {err && <div className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{err}</div>}

        <div className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-2 text-sm font-medium text-slate-500">
          {hasBio && mode !== 'bio' && (
            <button onClick={() => setMode('bio')} className="flex items-center gap-1 hover:text-indigo-600">
              <Fingerprint className="h-4 w-4" />
              טביעת אצבע
            </button>
          )}
          {isStation && mode !== 'code' && (
            <button onClick={() => (setMode('code'), setValue(''), setErr(null))} className="flex items-center gap-1 hover:text-indigo-600">
              <KeyRound className="h-4 w-4" />
              קוד תחנה
            </button>
          )}
          {isStation && mode !== 'phone' && (
            <button onClick={() => (setMode('phone'), setValue(''), setSent(false), setErr(null))} className="flex items-center gap-1 hover:text-indigo-600">
              <MessageCircle className="h-4 w-4" />
              קוד בוואטסאפ
            </button>
          )}
          {!isStation && mode !== 'password' && (
            <button onClick={() => (setMode('password'), setValue(''), setErr(null))} className="flex items-center gap-1 hover:text-indigo-600">
              <KeyRound className="h-4 w-4" />
              סיסמה
            </button>
          )}
          <button onClick={onSignOut} className="flex items-center gap-1 hover:text-rose-600">
            <LogOut className="h-4 w-4" />
            יציאה
          </button>
        </div>
      </div>
    </div>
  );
}
