'use client';
import { useEffect, useRef } from 'react';
import { sb, needsPolling } from './supabase';

/** Re-run `onChange` whenever any of the given tables change (Supabase Realtime). */
export function useRealtime(tables: string[], onChange: () => void, filter?: string) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = tables.join(',') + '|' + (filter ?? '');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        cb.current();
      }, 400);
    };
    // station / acting mode: realtime can't see our station headers, so refresh every few seconds instead
    if (needsPolling()) {
      const iv = setInterval(() => cb.current(), 4000);
      return () => clearInterval(iv);
    }
    const ch = sb().channel('rt-' + key + '-' + Math.random().toString(36).slice(2));
    for (const t of tables) {
      ch.on('postgres_changes' as any, { event: '*', schema: 'public', table: t, ...(filter ? { filter } : {}) }, fire);
    }
    ch.subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      sb().removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
