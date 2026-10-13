'use client';
// Forgot password: a 6-digit code is e-mailed from the system's mailbox; the user types it here with a new password.
import { useState } from 'react';
import { sb } from '@/lib/supabase';
import { ArrowRight } from 'lucide-react';
import { FormNote, markUnlocked } from '@/components/AppLock';
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
        <button
          type="button"
          onClick={onBack}
          className="-ms-1 mb-3 inline-flex h-8 items-center gap-1 rounded-lg px-1 text-sm font-medium text-slate-500 hover:text-slate-900"
        >
          <ArrowRight className="h-4 w-4" />
          חזרה לכניסה
        </button>
        <h2 className="text-[22px] font-bold tracking-tight text-slate-900">איפוס סיסמה</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">
          {sent ? 'הקלד את הקוד שקיבלת במייל ובחר סיסמה חדשה.' : 'נשלח קוד אימות בן 6 ספרות למייל שלך.'}
        </p>
      </div>
      <Field label="אימייל">
        <Input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={sent} autoComplete="email" />
      </Field>
      {sent && (
        <>
          <Field label="הקוד מהמייל">
            <Input
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              className="text-center font-mono text-lg tabular-nums tracking-[0.4em]"
              required
              autoFocus
            />
          </Field>
          <Field label="סיסמה חדשה" hint="לפחות 8 תווים">
            <Input type="password" dir="ltr" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
          </Field>
          <Field label="הסיסמה החדשה שוב">
            <Input type="password" dir="ltr" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
          </Field>
        </>
      )}
      {msg && <FormNote ok={msg.ok}>{msg.text}</FormNote>}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        {sent ? 'שמירת הסיסמה וכניסה' : 'שליחת קוד למייל'}
      </Button>
      {sent && (
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setCode('');
            setMsg(null);
          }}
          className="h-10 w-full rounded-lg text-center text-sm font-medium text-indigo-600 hover:bg-indigo-50"
        >
          לא הגיע? שליחת קוד חדש
        </button>
      )}
    </form>
  );
}
