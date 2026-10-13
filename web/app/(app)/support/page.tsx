'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  Building2,
  ChevronLeft,
  ImagePlus,
  LifeBuoy,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  X,
} from 'lucide-react';
import { sb } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/hooks';
import { fmtTime, timeAgo, type Tone } from '@/lib/format';
import { prepareProof } from '@/lib/image';
import { RequireRole } from '@/components/Shell';
import { Badge, Button, Card, Empty, Field, Input, Lamp, Modal, PageHeader, Segmented, Select, Skeleton, Textarea, ask, cx, toast } from '@/components/ui';

// "תמיכה טכנית" – one screen, two modes:
//  • a station: its own tickets, a new ticket, and a chat-like thread with the BotiX team;
//  • the system owner (own account, not inside a station): every station's tickets, reply and status.
// Data: support_tickets(), support_ticket_get(id), support_ticket_create(...), support_reply(...),
// support_ticket_status(id, status) – see supabase/pending/20261013_v2.sql.

type Status = 'open' | 'in_progress' | 'waiting' | 'closed';
type Ticket = {
  id: number;
  station_id: string;
  station_name: string;
  arm_id: string | null;
  arm_name: string | null;
  category: string;
  subject: string;
  status: Status;
  created_at: string;
  updated_at: string;
  last_reply_by: 'station' | 'owner' | null;
  messages: number;
};
type Msg = { id: number; author: 'station' | 'owner'; author_name: string | null; body: string | null; image_data: string | null; created_at: string };
type Full = Omit<Ticket, 'messages'> & { station_phone?: string | null; created_by_name: string | null; messages: Msg[] };

const CATEGORIES: { value: string; label: string; hint: string }[] = [
  { value: 'arm', label: 'זרוע', hint: 'חיבור, QR, ניתוקים' },
  { value: 'distribution', label: 'הפצה', hint: 'נסיעות לא יצאו או יצאו לא נכון' },
  { value: 'groups', label: 'קבוצות', hint: 'קבוצות חסרות, הרשאות, רשימות' },
  { value: 'billing', label: 'מנוי ותשלום', hint: 'חידוש, תשלום, חשבונית' },
  { value: 'account', label: 'חשבון', hint: 'כניסה, משתמשים, הגדרות' },
  { value: 'other', label: 'אחר', hint: 'כל דבר אחר' },
];
const CAT_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

function statusInfo(s: Status, ownerView: boolean): { label: string; tone: Tone } {
  switch (s) {
    case 'open':
      return { label: 'פתוחה', tone: 'sky' };
    case 'in_progress':
      return { label: 'בטיפול', tone: 'violet' };
    case 'waiting':
      return ownerView ? { label: 'ממתינה לתשובת התחנה', tone: 'slate' } : { label: 'ממתינה לתשובתך', tone: 'amber' };
    case 'closed':
      return { label: 'סגורה', tone: 'slate' };
    default:
      return { label: s, tone: 'slate' };
  }
}

export default function SupportPage() {
  return (
    <RequireRole min="viewer">
      <Suspense fallback={<ListSkeleton />}>
        <Support />
      </Suspense>
    </RequireRole>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="טוען">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[72px] rounded-2xl" />
      ))}
    </div>
  );
}

function Support() {
  const { isSuper, station, can } = useAuth();
  const ownerView = isSuper && !station?.acting;
  const params = useSearchParams();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusF, setStatusF] = useState<'active' | Status | 'all'>('active');
  const [q, setQ] = useState('');

  // deep link: /support?t=<id> (from the WhatsApp notice)
  useEffect(() => {
    const t = Number(params.get('t'));
    if (t > 0) setOpenId(t);
  }, [params]);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('support_tickets');
    if (error) {
      setLoadError(error.message);
      setTickets((t) => t ?? []);
      return;
    }
    setLoadError(null);
    setTickets(((data as Ticket[]) || []).map((t) => ({ ...t, id: Number(t.id) })));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['support_tickets', 'support_messages'], load);

  function open(id: number | null) {
    setOpenId(id);
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set('t', String(id));
      else url.searchParams.delete('t');
      window.history.replaceState(null, '', url.pathname + url.search);
    } catch {}
  }

  // the main account (not inside a station) of a team member: support is between stations and the owner
  const homeOnly = !ownerView && (!station || station.is_home);
  const canCreate = !ownerView && !homeOnly && can('operator');

  const counts = useMemo(() => {
    const c = { active: 0, open: 0, in_progress: 0, waiting: 0, closed: 0, all: 0 };
    for (const t of tickets || []) {
      c.all++;
      c[t.status]++;
      if (t.status !== 'closed') c.active++;
    }
    return c;
  }, [tickets]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (tickets || []).filter((t) => {
      if (ownerView) {
        if (statusF === 'active' ? t.status === 'closed' : statusF !== 'all' && t.status !== statusF) return false;
      }
      if (!s) return true;
      return (
        t.subject.toLowerCase().includes(s) ||
        String(t.id) === s.replace('#', '') ||
        (t.station_name || '').toLowerCase().includes(s) ||
        (t.arm_name || '').toLowerCase().includes(s)
      );
    });
  }, [tickets, q, statusF, ownerView]);

  const header = (
    <PageHeader
      title={ownerView ? 'פניות תמיכה' : 'תמיכה טכנית'}
      subtitle={
        ownerView
          ? 'כל הפניות מכל התחנות. תשובה כאן נשלחת לתחנה גם בהודעת WhatsApp.'
          : 'נתקלתם בבעיה? פתחו פנייה ונחזור אליכם כאן ובהודעת WhatsApp.'
      }
      actions={
        canCreate && (
          <Button onClick={() => setCreating(true)}>
            <MessageSquarePlus className="h-4 w-4" />
            פנייה חדשה
          </Button>
        )
      }
    />
  );

  if (homeOnly)
    return (
      <>
        {header}
        <Card>
          <Empty
            icon={<LifeBuoy className="h-7 w-7" />}
            title="התמיכה זמינה לתחנות"
            text="פניות תמיכה נפתחות מתוך חשבון של תחנה. בחשבון הראשי אין צורך בהן."
            action={
              <Link href="/">
                <Button variant="secondary">חזרה לדף הבית</Button>
              </Link>
            }
          />
        </Card>
      </>
    );

  if (!tickets)
    return (
      <>
        {header}
        <ListSkeleton />
      </>
    );

  const list = (
    <div className={cx('min-w-0', openId && 'hidden md:block')}>
      {ownerView && (
        <div className="mb-3 space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="חיפוש לפי נושא, תחנה, זרוע או מספר פנייה" className="pr-9" aria-label="חיפוש פנייה" />
          </div>
          <div className="scroll-thin -mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
            <Segmented<'active' | Status | 'all'>
              value={statusF}
              onChange={setStatusF}
              options={[
                { value: 'active', label: 'פעילות', count: counts.active },
                { value: 'open', label: 'פתוחות', count: counts.open },
                { value: 'in_progress', label: 'בטיפול', count: counts.in_progress },
                { value: 'waiting', label: 'ממתינות לתחנה', count: counts.waiting },
                { value: 'closed', label: 'סגורות', count: counts.closed },
                { value: 'all', label: 'הכול', count: counts.all },
              ]}
            />
          </div>
        </div>
      )}

      {loadError && (
        <Card className="mb-3 flex items-center justify-between gap-3 px-5 py-3.5">
          <span className="text-sm text-rose-700">לא הצלחנו לטעון את הפניות. בדקו את החיבור ונסו שוב.</span>
          <Button size="sm" variant="secondary" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            ניסיון נוסף
          </Button>
        </Card>
      )}

      <Card className="overflow-hidden">
        {shown.length === 0 ? (
          tickets.length === 0 ? (
            <Empty
              icon={<LifeBuoy className="h-7 w-7" />}
              title={ownerView ? 'אין פניות עדיין' : 'אין לכם פניות פתוחות'}
              text={
                ownerView
                  ? 'כשתחנה תפתח פנייה היא תופיע כאן, ותקבל גם הודעת WhatsApp.'
                  : 'משהו לא עובד כמו שצריך? ספרו לנו מה קרה, ואפשר לצרף צילום מסך.'
              }
              action={
                canCreate && (
                  <Button onClick={() => setCreating(true)}>
                    <MessageSquarePlus className="h-4 w-4" />
                    פתיחת פנייה
                  </Button>
                )
              }
            />
          ) : (
            <Empty icon={<Search className="h-7 w-7" />} title="לא נמצאו פניות" text="נסו לשנות את החיפוש או את הסינון." />
          )
        ) : (
          <ul className="divide-y divide-slate-100">
            {shown.map((t) => (
              <TicketRow key={t.id} t={t} active={openId === t.id} ownerView={ownerView} onClick={() => open(t.id)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );

  return (
    <>
      {header}
      <div className="grid gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:items-start">
        {list}
        {openId ? (
          <TicketView key={openId} id={openId} ownerView={ownerView} onBack={() => open(null)} onChanged={load} />
        ) : (
          <Card className="hidden md:block">
            <Empty
              icon={<ChevronLeft className="h-7 w-7" />}
              title="בחרו פנייה"
              text={tickets.length ? 'השיחה המלאה תופיע כאן.' : ownerView ? 'אין פניות להצגה.' : 'פנייה שתפתחו תופיע כאן עם כל התשובות.'}
            />
          </Card>
        )}
      </div>
      {canCreate && (
        <NewTicket
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            load();
            open(id);
          }}
        />
      )}
    </>
  );
}

function TicketRow({ t, active, ownerView, onClick }: { t: Ticket; active: boolean; ownerView: boolean; onClick: () => void }) {
  const st = statusInfo(t.status, ownerView);
  // whose turn it is: the owner should answer a station's message; a station should answer the owner's
  const yourTurn = t.status !== 'closed' && (ownerView ? t.last_reply_by === 'station' : t.status === 'waiting');
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active || undefined}
        className={cx('flex w-full items-start gap-3 px-5 py-3.5 text-start transition', active ? 'bg-indigo-50/70' : 'hover:bg-slate-50')}
      >
        <span className="mt-1.5">
          <Lamp tone={yourTurn ? (ownerView ? 'red' : 'amber') : t.status === 'closed' ? 'slate' : 'green'} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className={cx('truncate text-[15px] text-slate-900', yourTurn ? 'font-semibold' : 'font-medium')}>{t.subject}</span>
            <span className="shrink-0 text-xs text-slate-500">{timeAgo(t.updated_at)}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <span className="tabular-nums">#{t.id}</span>
            <span>·</span>
            <span>{CAT_LABEL[t.category] || t.category}</span>
            {ownerView && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1 text-slate-700">
                  <Building2 className="h-3.5 w-3.5" />
                  {t.station_name}
                </span>
              </>
            )}
            {t.arm_name && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <Smartphone className="h-3.5 w-3.5" />
                  {t.arm_name}
                </span>
              </>
            )}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={st.tone} dot>
              {st.label}
            </Badge>
            {ownerView && yourTurn && <span className="text-xs font-medium text-rose-700">ממתינה לתשובה שלך</span>}
            <span className="text-xs tabular-nums text-slate-400">{t.messages} הודעות</span>
          </span>
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// one ticket: header, thread, reply
// ---------------------------------------------------------------------------------------------
function TicketView({ id, ownerView, onBack, onChanged }: { id: number; ownerView: boolean; onBack: () => void; onChanged: () => void }) {
  const [t, setT] = useState<Full | null | undefined>(undefined);
  const [body, setBody] = useState('');
  const [img, setImg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('support_ticket_get', { p_id: id });
    if (error) {
      setT((cur) => (cur === undefined ? null : cur));
      return;
    }
    setT((data as Full) || null);
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(['support_messages', 'support_tickets'], load, String(id));

  // scroll to the newest message when one arrives
  useEffect(() => {
    const n = t?.messages?.length || 0;
    if (n && n !== lastCount.current) {
      lastCount.current = n;
      end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }
  }, [t]);

  async function send() {
    if (!body.trim() && !img) return;
    setSending(true);
    const { error } = await sb().rpc('support_reply', { p_ticket: id, p_body: body.trim() || null, p_image: img });
    setSending(false);
    if (error) return toast(error.message || 'ההודעה לא נשלחה. נסו שוב.', 'error');
    setBody('');
    setImg(null);
    toast('ההודעה נשלחה');
    await load();
    onChanged();
  }

  async function setStatus(s: Status) {
    if (!t || s === t.status) return;
    if (s === 'closed' && !(await ask({ title: 'לסגור את הפנייה?', text: 'התחנה תוכל לפתוח אותה מחדש בתשובה.', ok: 'סגירת הפנייה' }))) return;
    setStatusBusy(true);
    const { error } = await sb().rpc('support_ticket_status', { p_id: id, p_status: s });
    setStatusBusy(false);
    if (error) return toast(error.message || 'הסטטוס לא עודכן', 'error');
    toast(s === 'closed' ? 'הפנייה נסגרה' : 'הסטטוס עודכן');
    await load();
    onChanged();
  }

  if (t === undefined)
    return (
      <Card className="p-5">
        <div className="space-y-3" role="status" aria-label="טוען">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-20 w-4/5" />
          <Skeleton className="ms-auto h-16 w-3/5" />
        </div>
      </Card>
    );

  if (t === null)
    return (
      <Card>
        <Empty
          icon={<LifeBuoy className="h-7 w-7" />}
          title="הפנייה לא נמצאה"
          text="ייתכן שהקישור שגוי או שהפנייה שייכת לתחנה אחרת."
          action={
            <Button variant="secondary" onClick={onBack}>
              חזרה לרשימה
            </Button>
          }
        />
      </Card>
    );

  const st = statusInfo(t.status, ownerView);
  const mine = ownerView ? 'owner' : 'station';

  return (
    <Card className="flex min-w-0 flex-col overflow-hidden md:sticky md:top-6 md:max-h-[calc(100dvh-3rem)]">
      {/* header */}
      <div className="border-b border-slate-100 px-4 py-3.5 md:px-5">
        <div className="flex items-start gap-2">
          <button type="button" onClick={onBack} aria-label="חזרה לרשימת הפניות" className="-ms-1 mt-0.5 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 md:hidden">
            <ArrowRight className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-snug text-slate-900">{t.subject}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span className="tabular-nums">#{t.id}</span>
              <span>·</span>
              <span>{CAT_LABEL[t.category] || t.category}</span>
              <span>·</span>
              <span>נפתחה {fmtTime(t.created_at)}</span>
              {t.arm_name && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Smartphone className="h-3.5 w-3.5" />
                    {t.arm_name}
                  </span>
                </>
              )}
            </div>
            {ownerView && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-700">
                <span className="flex items-center gap-1.5 font-medium">
                  <Building2 className="h-4 w-4 text-slate-400" />
                  {t.station_name}
                </span>
                {t.station_phone && (
                  <a href={`https://wa.me/${String(t.station_phone).replace(/\D/g, '').replace(/^0/, '972')}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline" dir="ltr">
                    {t.station_phone}
                  </a>
                )}
                {t.created_by_name && <span className="text-slate-500">נפתחה ע״י {t.created_by_name}</span>}
              </div>
            )}
          </div>
          <Badge tone={st.tone} dot className="mt-0.5 shrink-0">
            {st.label}
          </Badge>
        </div>
        {ownerView && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">סטטוס:</span>
            <Select
              value={t.status}
              disabled={statusBusy}
              onChange={(e) => setStatus(e.target.value as Status)}
              className="h-9 w-auto py-1 text-sm"
              aria-label="שינוי סטטוס הפנייה"
            >
              <option value="open">פתוחה</option>
              <option value="in_progress">בטיפול</option>
              <option value="waiting">ממתינה לתשובת התחנה</option>
              <option value="closed">סגורה</option>
            </Select>
            {statusBusy && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
          </div>
        )}
      </div>

      {/* thread */}
      <div className="scroll-thin min-h-[240px] flex-1 space-y-3 overflow-y-auto bg-slate-50/70 px-3 py-4 md:px-5" aria-live="polite">
        {t.messages.map((m) => {
          const me = m.author === mine;
          const who =
            m.author === 'owner' ? (ownerView ? m.author_name || 'אתה' : 'צוות התמיכה של BotiX') : ownerView ? `${m.author_name || 'התחנה'} · ${t.station_name}` : m.author_name || 'התחנה';
          return (
            <div key={m.id} className={cx('flex', me ? 'justify-end' : 'justify-start')}>
              <div
                className={cx(
                  'max-w-[85%] rounded-2xl px-3.5 py-2.5 ring-1 ring-inset md:max-w-[75%]',
                  me ? 'rounded-es-md bg-indigo-50 ring-indigo-600/10' : 'rounded-ee-md bg-white ring-slate-200',
                )}
              >
                <div className={cx('mb-0.5 text-xs font-medium', m.author === 'owner' ? 'text-indigo-700' : 'text-slate-600')}>{who}</div>
                {m.body && <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-slate-900">{m.body}</div>}
                {m.image_data && (
                  <button type="button" onClick={() => setView(m.image_data)} className="mt-2 block overflow-hidden rounded-xl ring-1 ring-slate-200" aria-label="הגדלת התמונה">
                    <img src={m.image_data} alt="צילום מסך שצורף" className="max-h-60 w-auto max-w-full object-contain" />
                  </button>
                )}
                <div className="mt-1 text-[11px] tabular-nums text-slate-400">{fmtTime(m.created_at)}</div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>

      {/* reply */}
      <div className="safe-bottom border-t border-slate-100 bg-white px-3 py-3 md:px-5">
        {t.status === 'closed' && (
          <p className="mb-2 text-xs text-slate-500">{ownerView ? 'הפנייה סגורה. תשובה שלך לא תפתח אותה מחדש.' : 'הפנייה סגורה. הודעה חדשה תפתח אותה מחדש.'}</p>
        )}
        {!ownerView && t.status === 'waiting' && <p className="mb-2 text-xs font-medium text-amber-800">צוות התמיכה ענה וממתין לתשובתך.</p>}
        <Composer
          body={body}
          setBody={setBody}
          img={img}
          setImg={setImg}
          sending={sending}
          onSend={send}
          placeholder={ownerView ? 'תשובה לתחנה…' : 'כתבו הודעה…'}
        />
      </div>

      <Modal open={!!view} onClose={() => setView(null)} title="תמונה מצורפת" wide>
        {view && <img src={view} alt="תמונה מצורפת בגודל מלא" className="mx-auto max-h-[75dvh] w-auto max-w-full rounded-xl object-contain" />}
      </Modal>
    </Card>
  );
}

/** Pick an image and shrink it to a ≤1600px JPEG data URL (same helper as payment proofs). */
function useImagePicker(setImg: (v: string | null) => void) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  async function pick(f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name)) {
      toast('אפשר לצרף תמונה בלבד (צילום מסך, JPG או PNG)', 'error');
      return;
    }
    setReading(true);
    try {
      const p = await prepareProof(f);
      if (p.kind !== 'image') throw new Error('אפשר לצרף תמונה בלבד');
      setImg(p.data);
    } catch (e: any) {
      toast(e?.message || 'לא הצלחנו לקרוא את התמונה', 'error');
    } finally {
      setReading(false);
      if (input.current) input.current.value = '';
    }
  }
  const el = <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} aria-label="בחירת תמונה לצירוף" />;
  return { el, reading, choose: () => input.current?.click() };
}

function ImagePreview({ src, onRemove }: { src: string; onRemove: () => void }) {
  return (
    <div className="relative inline-block">
      <img src={src} alt="התמונה שתצורף" className="h-20 w-auto rounded-xl object-cover ring-1 ring-slate-200" />
      <button
        type="button"
        onClick={onRemove}
        aria-label="הסרת התמונה"
        className="absolute -top-2 -start-2 grid h-6 w-6 place-items-center rounded-full bg-white text-slate-600 shadow ring-1 ring-slate-200 hover:text-rose-600"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Composer({
  body,
  setBody,
  img,
  setImg,
  sending,
  onSend,
  placeholder,
}: {
  body: string;
  setBody: (v: string) => void;
  img: string | null;
  setImg: (v: string | null) => void;
  sending: boolean;
  onSend: () => void;
  placeholder: string;
}) {
  const pic = useImagePicker(setImg);
  return (
    <div>
      {img && (
        <div className="mb-2">
          <ImagePreview src={img} onRemove={() => setImg(null)} />
        </div>
      )}
      <div className="flex items-end gap-2">
        <Button variant="secondary" className="h-11 w-11 shrink-0 px-0" onClick={pic.choose} loading={pic.reading} aria-label="צירוף צילום מסך" title="צירוף צילום מסך">
          {!pic.reading && <ImagePlus className="h-5 w-5" />}
        </Button>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          placeholder={placeholder}
          aria-label="תוכן ההודעה"
          className="max-h-40 min-h-11 flex-1 resize-y py-2.5"
        />
        <Button className="h-11 shrink-0" onClick={onSend} loading={sending} disabled={!body.trim() && !img} aria-label="שליחת ההודעה">
          {!sending && <Send className="h-4 w-4" />}
          <span className="hidden sm:inline">שליחה</span>
        </Button>
      </div>
      {pic.el}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// new ticket (station)
// ---------------------------------------------------------------------------------------------
function NewTicket({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const [category, setCategory] = useState('');
  const [subject, setSubject] = useState('');
  const [desc, setDesc] = useState('');
  const [arm, setArm] = useState('');
  const [img, setImg] = useState<string | null>(null);
  const [arms, setArms] = useState<{ id: string; name: string; status: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const pic = useImagePicker(setImg);

  useEffect(() => {
    if (!open) return;
    setCategory('');
    setSubject('');
    setDesc('');
    setArm('');
    setImg(null);
    sb()
      .from('arms')
      .select('id,name,status')
      .order('created_at') // rows: bounded – the arms of one station
      .then(({ data }: any) => setArms(data || []));
  }, [open]);

  const ready = !!category && !!subject.trim() && (!!desc.trim() || !!img);

  async function submit() {
    if (!category) return toast('בחרו נושא לפנייה', 'error');
    if (!subject.trim()) return toast('כתבו כותרת קצרה לפנייה', 'error');
    if (!desc.trim() && !img) return toast('תארו מה קרה או צרפו צילום מסך', 'error');
    setBusy(true);
    const { data, error } = await sb().rpc('support_ticket_create', {
      p_category: category,
      p_subject: subject.trim(),
      p_body: desc.trim() || null,
      p_arm: arm || null,
      p_image: img,
    });
    setBusy(false);
    if (error) return toast(error.message || 'הפנייה לא נשלחה. נסו שוב.', 'error');
    toast('הפנייה נשלחה');
    onCreated(Number(data));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="פנייה חדשה לתמיכה"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button onClick={submit} loading={busy} disabled={!ready}>
            <Send className="h-4 w-4" />
            שליחת הפנייה
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700" id="cat-label">
            במה צריך עזרה?
          </span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-labelledby="cat-label">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={category === c.value}
                onClick={() => setCategory(c.value)}
                className={cx(
                  'rounded-xl border px-3 py-2.5 text-start transition',
                  category === c.value ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-500/15' : 'border-slate-200 bg-white hover:border-slate-300',
                )}
              >
                <span className={cx('block text-sm font-semibold', category === c.value ? 'text-indigo-800' : 'text-slate-900')}>{c.label}</span>
                <span className="block text-xs leading-snug text-slate-500">{c.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <Field label="כותרת">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="לדוגמה: זרוע 2 מתנתקת כל כמה שעות" />
        </Field>
        <Field label="מה קרה?" hint="מתי זה התחיל, מה ניסיתם, ומה הופיע על המסך. כמה שיותר פרטים – כך נעזור מהר יותר.">
          <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} />
        </Field>
        {arms.length > 0 && (
          <Field label="זרוע קשורה (לא חובה)">
            <Select value={arm} onChange={(e) => setArm(e.target.value)}>
              <option value="">לא קשור לזרוע מסוימת</option>
              {arms.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">צילום מסך (לא חובה)</span>
          {img ? (
            <ImagePreview src={img} onRemove={() => setImg(null)} />
          ) : (
            <Button variant="secondary" onClick={pic.choose} loading={pic.reading}>
              {!pic.reading && <ImagePlus className="h-4 w-4" />}
              צירוף צילום מסך
            </Button>
          )}
          {pic.el}
        </div>
      </div>
    </Modal>
  );
}
