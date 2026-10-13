'use client';
// Owner / staff: change the login password (checks the current one first).
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Card, Field, Input, Section, toast } from '@/components/ui';

export function ChangePassword() {
  const { profile, isStation } = useAuth();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);

  if (isStation)
    return (
      <Card className="flex max-w-lg items-start gap-3 p-5 text-sm leading-relaxed text-slate-600">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        כניסת תחנה היא עם קוד התחנה, בלי סיסמה. את הקוד מחליף מנהל המערכת.
      </Card>
    );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return toast('הסיסמה החדשה צריכה להיות לפחות 8 תווים', 'error');
    if (pw !== pw2) return toast('שתי הסיסמאות החדשות לא זהות. הקלד אותן שוב.', 'error');
    setBusy(true);
    const { error: e1 } = await sb().auth.signInWithPassword({ email: profile?.email || '', password: cur });
    if (e1) {
      setBusy(false);
      return toast('הסיסמה הנוכחית שגויה', 'error');
    }
    const { error } = await sb().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return toast(`הסיסמה לא הוחלפה: ${error.message}`, 'error');
    await logAct('password_changed', 'user', profile?.id);
    setCur('');
    setPw('');
    setPw2('');
    toast('הסיסמה הוחלפה');
  }

  return (
    <Section title="החלפת סיסמה" icon={<KeyRound className="h-4 w-4" />} className="max-w-lg" bodyClass="p-5">
      <form onSubmit={save} className="space-y-4">
        <Field label="סיסמה נוכחית">
          <Input type="password" dir="ltr" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="סיסמה חדשה" hint="לפחות 8 תווים">
          <Input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="הסיסמה החדשה שוב">
          <Input type="password" dir="ltr" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
        </Field>
        <div className="flex justify-end border-t border-slate-100 pt-4">
          <Button type="submit" loading={busy} className="w-full sm:w-auto">
            החלפת הסיסמה
          </Button>
        </div>
      </form>
    </Section>
  );
}
