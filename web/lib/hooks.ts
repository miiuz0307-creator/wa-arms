'use client';
import { useEffect, useRef } from 'react';
import { markRefreshed } from './live';

/**
 * Re-run `onChange` every few seconds while the screen is visible.
 * (Supabase Realtime was replaced by light polling: decoding the database log for live
 * updates cost the small database about a third of its CPU, even when nobody looked.)
 */
export function useRealtime(tables: string[], onChange: () => void | Promise<void>, filter?: string) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = tables.join(',') + '|' + (filter ?? '');

  useEffect(() => {
    const run = () => {
      // tell the header's live dot that this screen just refreshed
      Promise.resolve(cb.current()).then(markRefreshed, () => {});
    };
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      run();
    };
    const iv = setInterval(tick, 5000);
    // coming back to the app: refresh right away
    const onVis = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
