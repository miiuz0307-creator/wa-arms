'use client';
// Password reset: the link from the "forgot password" email lands here and signs the user in for this one
// purpose. The user picks a new password and continues into the app.
import { useEffect, useState } from 'react';
import { Link2Off } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { FormNote, markUnlocked } from '@/components/AppLock';
import { BrandMark } from '@/components/Brand';
import { Button, Card, Field, Input, Skeleton } from '@/components/ui';

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
    if (pw.length < 8) return setErr('הסיסמה צריכה להיות לפחות 8 תווים.');
    if (pw !== pw2) return setErr('שתי הסיסמאות לא זהות. הקלד אותן שוב.');
    setBusy(true);
    const { error } = await sb().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr('הסיסמה לא נשמרה. בקש קישור חדש ממסך הכניסה ונסה שוב.');
    markUnlocked();
    window.location.href = '/';
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-[var(--bg)] p-4 sm:p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandMark size={52} />
          <h1 className="mt-4 text-[22px] font-bold tracking-tight text-slate-900">בחירת סיסמה חדשה</h1>
          <p className="mt-1 text-sm text-slate-500">אחרי השמירה תיכנס ישר לאפליקציה.</p>
        </div>
        <Card className="p-5">
          {ready === 'wait' && (
            <div className="space-y-4" role="status" aria-label="בודק את הקישור">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-11" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-11" />
              <Skeleton className="h-12" />
            </div>
          )}
          {ready === 'none' && (
            <div className="py-4 text-center">
              <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-amber-50 text-amber-700">
                <Link2Off className="h-6 w-6" />
              </div>
              <div className="font-semibold text-slate-900">הקישור פג תוקף או שכבר השתמשו בו</div>
              <p className="mt-1 text-sm text-slate-500">אפשר לבקש קוד חדש במסך הכניסה, תחת &quot;שכחתי סיסמה&quot;.</p>
              <a
                href="/login"
                className="mt-5 inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                למסך הכניסה
              </a>
            </div>
          )}
          {ready === 'ok' && (
            <form onSubmit={save} className="space-y-4">
              <Field label="סיסמה חדשה" hint="לפחות 8 תווים">
                <Input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus required />
              </Field>
              <Field label="הסיסמה החדשה שוב">
                <Input type="password" dir="ltr" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
              </Field>
              {err && <FormNote>{err}</FormNote>}
              <Button type="submit" size="lg" className="w-full" loading={busy}>
                שמירה וכניסה
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
