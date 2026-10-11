'use client';
// Owner: the system's own mailbox. Password-reset codes are sent from it.
import { useEffect, useState } from 'react';
import { Mail, Send } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Button, Card, Field, Input, Spinner, toast } from '@/components/ui';

export function MailSettings() {
  const { isSuper } = useAuth();
  const [s, setS] = useState<any>(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!isSuper) return;
    sb()
      .rpc('owner_mail_settings')
      .then(({ data, error }) => (error ? toast(error.message, 'error') : setS(data)));
  }, [isSuper]);

  if (!isSuper) return <Card className="p-5 text-sm text-slate-600">ההגדרה הזו זמינה רק למנהל הראשי.</Card>;
  if (!s) return <Spinner />;

  async function save() {
    setBusy(true);
    const { error } = await sb().rpc('owner_mail_settings_save', { p: { ...s, smtp_pass: pass } });
    setBusy(false);
    if (error) return toast(error.message, 'error');
    setPass('');
    setS({ ...s, has_pass: s.has_pass || !!pass });
    toast('נשמר');
  }

  async function test() {
    setTesting(true);
    const { data, error } = await sb().functions.invoke('account-mail', { body: { action: 'test' } });
    setTesting(false);
    if (error || data?.error) return toast((data as any)?.error || 'השליחה נכשלה', 'error');
    toast(`נשלח מייל בדיקה אל ${(data as any).to}`);
  }

  return (
    <Card className="max-w-lg p-5">
      <div className="mb-1 flex items-center gap-2 font-semibold">
        <Mail className="h-5 w-5 text-indigo-600" />
        מייל המערכת
      </div>
      <p className="mb-4 text-sm text-slate-500">ממנו נשלחים קודי איפוס סיסמה למשתמשים.</p>
      <div className="space-y-4">
        <Field label="כתובת המייל של המערכת">
          <Input type="email" dir="ltr" value={s.address || ''} onChange={(e) => setS({ ...s, address: e.target.value })} placeholder="botix.system@gmail.com" />
        </Field>
        <Field
          label="סיסמת אפליקציה"
          hint={s.has_pass ? 'שמורה. השאר ריק כדי לא לשנות.' : 'ב-Gmail: חשבון Google ← אבטחה ← אימות דו-שלבי (להפעיל) ← סיסמאות לאפליקציות ← ליצור. 16 תווים.'}
        >
          <Input type="password" dir="ltr" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={s.has_pass ? '••••••••••••••••' : 'abcd efgh ijkl mnop'} autoComplete="new-password" />
        </Field>
        <Field label="שם השולח">
          <Input value={s.from_name || ''} onChange={(e) => setS({ ...s, from_name: e.target.value })} />
        </Field>
        <details className="text-sm text-slate-500">
          <summary className="cursor-pointer">מתקדם (לא Gmail)</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="שרת SMTP">
              <Input dir="ltr" value={s.smtp_host || ''} onChange={(e) => setS({ ...s, smtp_host: e.target.value })} />
            </Field>
            <Field label="פורט">
              <Input dir="ltr" type="number" value={s.smtp_port || 465} onChange={(e) => setS({ ...s, smtp_port: Number(e.target.value) })} />
            </Field>
          </div>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} loading={busy}>
            שמירה
          </Button>
          <Button variant="secondary" onClick={test} loading={testing} disabled={!s.address || !s.has_pass}>
            <Send className="h-4 w-4" />
            שליחת מייל בדיקה אליי
          </Button>
        </div>
      </div>
    </Card>
  );
}
