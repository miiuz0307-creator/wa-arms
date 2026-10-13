'use client';
// Owner: the system's own mailbox. Password-reset codes are sent from it.
import { useEffect, useState } from 'react';
import { Mail, Send, ShieldCheck } from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Badge, Button, Card, Field, Input, Section, Skeleton, toast } from '@/components/ui';

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
      .then(({ data, error }) => (error ? toast(`ההגדרות לא נטענו: ${error.message}`, 'error') : setS(data)));
  }, [isSuper]);

  if (!isSuper)
    return (
      <Card className="flex max-w-lg items-start gap-3 p-5 text-sm leading-relaxed text-slate-600">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        ההגדרה הזו זמינה רק למנהל הראשי.
      </Card>
    );
  if (!s)
    return (
      <div className="max-w-xl space-y-3" role="status" aria-label="טוען">
        <Skeleton className="h-12" />
        <Skeleton className="h-72" />
      </div>
    );

  async function save() {
    setBusy(true);
    const { error } = await sb().rpc('owner_mail_settings_save', { p: { ...s, smtp_pass: pass } });
    setBusy(false);
    if (error) return toast(`ההגדרות לא נשמרו: ${error.message}`, 'error');
    setPass('');
    setS({ ...s, has_pass: s.has_pass || !!pass });
    toast('ההגדרות נשמרו');
  }

  async function test() {
    setTesting(true);
    const { data, error } = await sb().functions.invoke('account-mail', { body: { action: 'test' } });
    setTesting(false);
    if (error || data?.error) return toast((data as any)?.error || 'מייל הבדיקה לא נשלח. בדוק את הכתובת ואת סיסמת האפליקציה.', 'error');
    toast(`נשלח מייל בדיקה אל ${(data as any).to}`);
  }

  return (
    <Section
      title="מייל המערכת"
      icon={<Mail className="h-4 w-4" />}
      className="max-w-xl"
      bodyClass="space-y-4 p-5"
      action={
        <Badge tone={s.address && s.has_pass ? 'green' : 'amber'} dot>
          {s.address && s.has_pass ? 'מוגדר' : 'לא הושלם'}
        </Badge>
      }
    >
      <p className="text-sm leading-relaxed text-slate-500">מהכתובת הזו נשלחים קודי איפוס סיסמה למשתמשים.</p>
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
      <details className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-600">
        <summary className="cursor-pointer py-1 font-medium">מתקדם (לא Gmail)</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 pb-1">
          <Field label="שרת SMTP">
            <Input dir="ltr" value={s.smtp_host || ''} onChange={(e) => setS({ ...s, smtp_host: e.target.value })} />
          </Field>
          <Field label="פורט">
            <Input dir="ltr" type="number" className="tabular-nums" value={s.smtp_port || 465} onChange={(e) => setS({ ...s, smtp_port: Number(e.target.value) })} />
          </Field>
        </div>
      </details>
      <div className="flex flex-col-reverse gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={test} loading={testing} disabled={!s.address || !s.has_pass}>
          <Send className="h-4 w-4" />
          שליחת מייל בדיקה אליי
        </Button>
        <Button onClick={save} loading={busy}>
          שמירה
        </Button>
      </div>
    </Section>
  );
}
