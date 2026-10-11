'use client';
// Owner / staff: change the login password (checks the current one first).
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { sb, logAct } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Card, Field, Input, toast } from '@/components/ui';

export function ChangePassword() {
  const { profile, isStation } = useAuth();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);

  if (isStation) return <Card className="p-5 text-sm text-slate-600">כניסת תחנה היא עם קוד התחנה. את הקוד מחליף מנהל המערכת.</Card>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return toast('הסיסמה החדשה חייבת להיות לפחות 8 תווים', 'error');
    if (pw !== pw2) return toast('הסיסמאות החדשות לא זהות', 'error');
    setBusy(true);
    const { error: e1 } = await sb().auth.signInWithPassword({ email: profile?.email || '', password: cur });
    if (e1) {
      setBusy(false);
      return toast('הסיסמה הנוכחית שגויה', 'error');
    }
    const { error } = await sb().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    await logAct('password_changed', 'user', profile?.id);
    setCur('');
    setPw('');
    setPw2('');
    toast('הסיסמה הוחלפה');
  }

  return (
    <Card className="max-w-md p-5">
      <div className="mb-4 flex items-center gap-2 font-semibold">
        <KeyRound className="h-5 w-5 text-indigo-600" />
        החלפת סיסמה
      </div>
      <form onSubmit={save} className="space-y-4">
        <Field label="סיסמה נוכחית">
          <Input type="password" dir="ltr" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="סיסמה חדשה" hint="לפחות 8 תווים">
          <Input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="סיסמה חדשה שוב">
          <Input type="password" dir="ltr" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Button type="submit" loading={busy}>
          שמירה
        </Button>
      </form>
    </Card>
  );
}
