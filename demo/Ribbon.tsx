// The demo's own small control: who am I (persona), reset the demo data, and the simulated WhatsApp.
import { useEffect, useState } from 'react';
import { FlaskConical, X, RotateCcw, MessageCircle, ChevronDown, Check } from 'lucide-react';
import { PERSONAS, currentPersona, setPersona, resetDemo, waOutbox, lastRideTexts, onChange, type PersonaKey } from '@/lib/demo/client';
import { STATION_CODES, ID } from '@/lib/demo/seed';
import { navigate } from './router';

const KEY = 'botix-demo-ribbon';
const APP = 'https://web-production-e5de3.up.railway.app';

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const off = onChange(() => set((n) => n + 1));
    const iv = setInterval(() => set((n) => n + 1), ms);
    return () => {
      off();
      clearInterval(iv);
    };
  }, [ms]);
}

const time = (s: string | null) => (s ? new Date(s).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '');
const phone = (p: string) => (p?.startsWith('972') ? '0' + p.slice(3, 5) + '-' + p.slice(5) : p);

/** message text with app links turned into links inside the demo */
function Body({ text }: { text: string }) {
  const parts = String(text || '').split(/(https?:\/\/\S+)/g);
  return (
    <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[#111b21]">
      {parts.map((p, i) => {
        if (!/^https?:\/\//.test(p)) return <span key={i}>{p.split(/\*([^*]+)\*/g).map((x, j) => (j % 2 ? <b key={j}>{x}</b> : x))}</span>;
        const inApp = p.startsWith(APP);
        const path = inApp ? p.slice(APP.length) || '/' : null;
        return (
          <a
            key={i}
            href={inApp ? '#' + path : p}
            target={inApp ? undefined : '_blank'}
            rel="noreferrer"
            className="break-all text-[#027eb5] underline"
            onClick={(e) => {
              if (!inApp) return;
              e.preventDefault();
              (window as any).__demoCloseWa?.();
              navigate(path!);
            }}
          >
            {p}
          </a>
        );
      })}
    </div>
  );
}

function WhatsApp({ onClose }: { onClose: () => void }) {
  useTick(1500);
  const [tab, setTab] = useState<'out' | 'rides'>('out');
  const out = waOutbox(40);
  const rides = lastRideTexts(12);
  useEffect(() => {
    (window as any).__demoCloseWa = onClose;
    return () => {
      delete (window as any).__demoCloseWa;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] bg-black/40" onClick={onClose} dir="rtl">
      <div
        className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[88dvh] max-w-lg flex-col overflow-hidden rounded-t-3xl bg-[#efeae2] shadow-2xl md:inset-y-6 md:bottom-auto md:max-h-none md:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 bg-[#075e54] px-4 py-3 text-white">
          <MessageCircle className="h-5 w-5" />
          <div className="flex-1">
            <div className="text-[15px] font-semibold">וואטסאפ (הדמיה)</div>
            <div className="text-[11px] text-white/75">מה שהמערכת הייתה שולחת. בהדגמה שום הודעה לא יוצאת באמת.</div>
          </div>
          <button onClick={onClose} aria-label="סגירה" className="rounded-full p-1.5 hover:bg-white/15">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex gap-1 bg-[#075e54] px-3 pb-2 text-[13px]">
          {(
            [
              ['out', `הודעות מערכת (${out.length})`],
              ['rides', 'נסיעות שהופצו לקבוצות'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={'rounded-full px-3 py-1 font-medium ' + (tab === k ? 'bg-white text-[#075e54]' : 'text-white/80 hover:bg-white/10')}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {tab === 'out' &&
            (out.length ? (
              out.map((m) => (
                <div key={m.id} className="rounded-xl rounded-tr-sm bg-white p-2.5 shadow-sm">
                  <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[#667781]">
                    <span dir="ltr" className="font-medium text-[#075e54]">
                      אל {phone(m.to_phone)}
                    </span>
                    <span className="flex items-center gap-1">
                      {time(m.sent_at || m.created_at)}
                      {m.status === 'sent' ? (
                        <span className="text-[#53bdeb]">✓✓</span>
                      ) : m.status === 'failed' ? (
                        <span className="text-rose-600">נכשלה</span>
                      ) : (
                        <span>🕓</span>
                      )}
                    </span>
                  </div>
                  <Body text={m.body} />
                </div>
              ))
            ) : (
              <div className="py-10 text-center text-sm text-[#667781]">עוד לא נשלחו הודעות</div>
            ))}
          {tab === 'rides' &&
            rides.map((r) => (
              <div key={r.id} className="rounded-xl rounded-tr-sm bg-[#d9fdd3] p-2.5 shadow-sm">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[#667781]">
                  <span className="font-medium text-[#075e54]">{r.station}</span>
                  <span>
                    {time(r.at)} · נשלחה ל-{r.sent} קבוצות {r.status === 'running' ? '(בתהליך)' : ''}
                  </span>
                </div>
                <Body text={r.text} />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

export function DemoRibbon() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) === 'open';
    } catch {
      return false;
    }
  });
  const [wa, setWa] = useState(false);
  const cur = currentPersona();
  useTick(4000);
  const pending = waOutbox(40).filter((m) => Date.now() - Date.parse(m.created_at) < 60_000).length;

  const toggle = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(KEY, v ? 'open' : 'closed');
    } catch {}
  };
  const go = (k: PersonaKey) => setPersona(k);

  return (
    <>
      <div dir="rtl" className="fixed bottom-[calc(env(safe-area-inset-bottom)+76px)] left-2 z-[45] md:bottom-3 md:left-3" data-demo-ribbon>
        {!open ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => toggle(true)}
              className="flex items-center gap-1.5 rounded-full bg-amber-400 px-3 py-1.5 text-[12px] font-semibold text-amber-950 shadow-lg ring-1 ring-amber-600/30"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              הדגמה
              <ChevronDown className="h-3 w-3 rotate-180" />
            </button>
            <button
              onClick={() => setWa(true)}
              aria-label="וואטסאפ (הדמיה)"
              className="relative grid h-8 w-8 place-items-center rounded-full bg-[#25d366] text-white shadow-lg ring-1 ring-black/10"
            >
              <MessageCircle className="h-4 w-4" />
              {pending > 0 && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white" />}
            </button>
          </div>
        ) : (
          <div className="w-[min(300px,calc(100vw-16px))] rounded-2xl bg-amber-50 p-3 text-amber-950 shadow-2xl ring-1 ring-amber-300">
            <div className="mb-2 flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-amber-600" />
              <div className="flex-1 text-[13px] font-bold">הדגמה – נתונים לדוגמה בלבד</div>
              <button onClick={() => toggle(false)} aria-label="מזעור" className="rounded-full p-1 hover:bg-amber-200/60">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mb-1 text-[11px] font-medium text-amber-800">להיכנס בתור:</div>
            <div className="space-y-1">
              {PERSONAS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => go(p.key)}
                  className={
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-[12.5px] ' +
                    (cur === p.key ? 'bg-amber-400/90 font-semibold' : 'bg-white/70 hover:bg-white')
                  }
                >
                  <span className="flex-1">
                    {p.label} <span className="text-amber-800/80">· {p.sub}</span>
                  </span>
                  {cur === p.key && <Check className="h-3.5 w-3.5" />}
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button
                onClick={() => setWa(true)}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-[#25d366] px-2 py-1.5 text-[12px] font-semibold text-white"
              >
                <MessageCircle className="h-3.5 w-3.5" />
                וואטסאפ (הדמיה)
              </button>
              <button
                onClick={() => {
                  if (confirm('לאפס את כל נתוני ההדגמה למצב ההתחלתי?')) resetDemo();
                }}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-white px-2 py-1.5 text-[12px] font-semibold ring-1 ring-amber-300"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                איפוס נתוני ההדגמה
              </button>
            </div>
            <div className="mt-2 text-[10.5px] leading-snug text-amber-800/90">
              כניסה עם קוד תחנה: {STATION_CODES[ID.sharon]} (השרון), {STATION_CODES[ID.castel]} (קסטל), {STATION_CODES[ID.south]} (אורות הדרום). מייל בעל המערכת: meir@botix.co.il עם כל סיסמה.
            </div>
          </div>
        )}
      </div>
      {wa && <WhatsApp onClose={() => setWa(false)} />}
    </>
  );
}
