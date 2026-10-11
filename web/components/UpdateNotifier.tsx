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
    <button
      onClick={() => window.location.reload()}
      className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-md items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white shadow-xl"
    >
      <RefreshCw className="h-4 w-4" />
      גרסה חדשה של האפליקציה מוכנה – לחץ לעדכון
    </button>
  );
}
