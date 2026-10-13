'use client';
// Everyone gets the new version automatically: the app checks every minute which version is live.
// When it changed, it reloads by itself the next time the app is in the background (or right away on tap).
// Nothing is lost: all data lives on the server; a reload only fetches the new screens.
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

async function liveSha(): Promise<string | null> {
  try {
    const r = await fetch('/api/version', { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()).sha || null;
  } catch {
    return null;
  }
}

export function UpdateNotifier() {
  const mine = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop = false;
    const check = async () => {
      const sha = await liveSha();
      if (!sha || stop) return;
      if (!mine.current) mine.current = sha;
      else if (sha !== mine.current) setReady(true);
    };
    check();
    const t = setInterval(check, 60_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // reload quietly when the user is not looking at the app
  useEffect(() => {
    if (!ready) return;
    const onVis = () => {
      if (document.visibilityState === 'hidden') window.location.reload();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [ready]);

  if (!ready) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-md animate-rise items-center gap-3 rounded-2xl bg-[#151920] py-2.5 pe-2.5 ps-4 text-sm text-white shadow-[var(--shadow-pop)] ring-1 ring-white/10"
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-white/60" />
      <span className="min-w-0 flex-1 leading-snug">
        <span className="font-medium">יש גרסה חדשה של האפליקציה.</span>
        <span className="block text-xs text-white/60">היא תיטען לבד כשתצא מהאפליקציה, בלי לאבד נתונים.</span>
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="h-9 shrink-0 rounded-xl bg-[#f6f7f8] px-3.5 text-[13px] font-semibold text-[#151920] hover:bg-[#e3e6ea]"
      >
        עדכון עכשיו
      </button>
    </div>
  );
}
