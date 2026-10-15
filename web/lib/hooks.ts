'use client';
import { useEffect, useRef } from 'react';
import { markRefreshed } from './live';

/**
 * Re-run `onChange` every few seconds while the screen is visible.
 * (Supabase Realtime was replaced by light polling: decoding the database log for live
 * updates cost the small database about a third of its CPU, even when nobody looked.)
 *
 * Never two refreshes at once: the next one starts only after the previous one finished. Before, a slow
 * phone connection made refreshes (every 5s, each loading hundreds of rows) pile up and the screen froze.
 * A screen whose refresh is slow is refreshed less often (at least 3× the time the last refresh took).
 */
export function useRealtime(tables: string[], onChange: () => void | Promise<void>, filter?: string, everyMs = 5000) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = tables.join(',') + '|' + (filter ?? '') + '|' + everyMs;

  useEffect(() => {
    let busy = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastMs = 0;

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, Math.max(everyMs, lastMs * 3));
    };
    const run = async () => {
      if (busy) return;
      busy = true;
      const t0 = Date.now();
      try {
        await cb.current();
        // tell the header's live dot that this screen just refreshed
        markRefreshed();
      } catch {
        /* keep the screen as it is; the next refresh tries again */
      } finally {
        lastMs = Date.now() - t0;
        busy = false;
        schedule();
      }
    };
    function tick() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return schedule();
      run();
    }
    schedule();
    // coming back to the app: refresh right away
    const onVis = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
