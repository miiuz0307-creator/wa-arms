'use client';
// Forgot password: a 6-digit code is e-mailed from the system's mailbox; the user types it here with a new password.
import { useState } from 'react';
import { sb } from '@/lib/supabase';
import { markUnlocked } from '@/components/AppLock';
import { Button, Field, Input } from '@/components/ui';

export function ForgotPassword({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);

  const call = async (body: Record<string, unknown>) => {
    const { data, error } = await sb().functions.invoke('account-mail', { body });
    if (error) return { error: 'אין חיבור לשרת. נסה שוב.' } as any;
    return data as any;
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      if (!sent) {
        const r = await call({ action: 'reset_request', email });
        if (r?.error) return setMsg({ text: r.error });
        setSent(true);
        setMsg({ ok: true, text: 'אם המייל רשום במערכת, נשלח אליו קוד בן 6 ספרות (תקף ל-10 דקות). בדוק גם בספאם.' });
      } else {
        if (pw.length < 8) return setMsg({ text: 'הסיסמה חייבת להיות לפחות 8 תווים' });
        if (pw !== pw2) return setMsg({ text: 'הסיסמאות לא זהות' });
        const r = await call({ action: 'reset_confirm', email, code, password: pw });
        if (r?.error) return setMsg({ text: r.error });
        const { error } = await sb().auth.signInWithPassword({ email, password: pw });
        if (error) return setMsg({ ok: true, text: 'הסיסמה הוחלפה. היכנס עם הסיסמה החדשה.' });
        markUnlocked();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold">שכחתי סיסמה</h2>
        <p className="mt-1 text-sm text-slate-500">{sent ? 'הזן את הקוד שקיבלת במייל ובחר סיסמה חדשה.' : 'נשלח אליך קוד אימות למייל.'}</p>
      </div>
      <Field label="אימייל">
        <Input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={sent} autoComplete="email" />
      </Field>
      {sent && (
        <>
          <Field label="קוד מהמייל">
            <Input
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="text-center font-mono text-lg tracking-widest"
              required
              autoFocus
            />
          </Field>
          <Field label="סיסמה חדשה" hint="לפחות 8 תווים">
            <Input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
          </Field>
          <Field label="סיסמה חדשה שוב">
            <Input type="password" dir="ltr" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
          </Field>
        </>
      )}
      {msg && <div className={msg.ok ? 'rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800' : 'rounded-xl bg-rose-50 p-3 text-sm text-rose-700'}>{msg.text}</div>}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        {sent ? 'שמירת סיסמה וכניסה' : 'שליחת קוד'}
      </Button>
      <div className="flex justify-between text-sm font-medium">
        <button type="button" onClick={onBack} className="text-slate-500 hover:text-indigo-600">
          חזרה לכניסה
        </button>
        {sent && (
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setCode('');
              setMsg(null);
            }}
            className="text-indigo-600"
          >
            שליחת קוד חדש
          </button>
        )}
      </div>
    </form>
  );
}
