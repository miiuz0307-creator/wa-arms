'use client';
import { useEffect, useState } from 'react';
import { sb } from './supabase';

// Shared "is the screen live?" state: every screen refresh (useRealtime) reports here, and a tiny check every
// 15s confirms the server answers. The header shows it as a green / amber / red dot.
let lastRefresh = 0;
let lastCheckOk = true;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export function markRefreshed() {
  lastRefresh = Date.now();
  notify();
}

let checking = false;
async function check() {
  if (checking || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
  checking = true;
  try {
    const online = typeof navigator === 'undefined' || navigator.onLine;
    const { error } = online ? await sb().from('arms').select('id', { count: 'exact', head: true }) : { error: true };
    lastCheckOk = !error;
    if (!error) lastRefresh = Date.now(); // the server answered: data on this screen is current
  } catch {
    lastCheckOk = false;
  } finally {
    checking = false;
    notify();
  }
}

export type LiveState = { level: 'live' | 'late' | 'down'; seconds: number | null };

export function useLive(): LiveState {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    listeners.add(f);
    const tick = setInterval(f, 1000);
    const iv = setInterval(check, 15000);
    check();
    const on = () => check();
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      listeners.delete(f);
      clearInterval(tick);
      clearInterval(iv);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  const seconds = lastRefresh ? Math.max(0, Math.round((Date.now() - lastRefresh) / 1000)) : null;
  const level = !lastCheckOk ? 'down' : seconds !== null && seconds > 25 ? 'late' : 'live';
  return { level, seconds };
}
