'use client';
// Password reset: the link from the "forgot password" email lands here and signs the user in for this one
// purpose. The user picks a new password and continues into the app.
import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { markUnlocked } from '@/components/AppLock';
import { Button, Field, Input, Spinner } from '@/components/ui';

export default function ResetPage() {
  const [ready, setReady] = useState<'wait' | 'ok' | 'none'>('wait');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const client = sb();
    const { data: sub } = client.auth.onAuthStateChange((ev, s) => {
      if (s && (ev === 'PASSWORD_RECOVERY' || ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION')) setReady('ok');
    });
    // the link's token is read from the address by the client; give it a moment
    const t = setTimeout(async () => {
      const { data } = await client.auth.getSession();
      setReady(data.session ? 'ok' : 'none');
    }, 1500);
    return () => {
      clearTimeout(t);
      sub.subscription.unsubscribe();
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (pw.length < 8) return setErr('הסיסמה חייבת להיות לפחות 8 תווים');
    if (pw !== pw2) return setErr('הסיסמאות לא זהות');
    setBusy(true);
    const { error } = await sb().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr('לא הצלחנו לשמור. בקש קישור חדש ונסה שוב.');
    markUnlocked();
    window.location.href = '/';
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 p-6">
      <div className="w-full max-w-sm">
        <div className="brand-gradient mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl text-white shadow-lg">
          <KeyRound className="h-7 w-7" />
        </div>
        <h1 className="text-center text-xl font-bold">בחירת סיסמה חדשה</h1>
        {ready === 'wait' && <Spinner />}
        {ready === 'none' && (
          <div className="mt-6 space-y-3 text-center text-sm text-slate-600">
            <p>הקישור פג תוקף או כבר נוצל.</p>
            <a href="/login" className="font-medium text-indigo-600">
              חזרה למסך הכניסה ובקשת קישור חדש
            </a>
          </div>
        )}
        {ready === 'ok' && (
          <form onSubmit={save} className="mt-6 space-y-4">
            <Field label="סיסמה חדשה" hint="לפחות 8 תווים">
              <Input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus required />
            </Field>
            <Field label="שוב, לאימות">
              <Input type="password" dir="ltr" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
            </Field>
            {err && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{err}</div>}
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              שמירה וכניסה
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
