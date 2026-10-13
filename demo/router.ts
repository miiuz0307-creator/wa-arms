// Hash routing for the demo (the built file is opened from disk / any static host): "#/groups?tab=x".
import { useSyncExternalStore, createContext, useContext } from 'react';

export type Loc = { path: string; search: string };

function read(): Loc {
  const h = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '');
  const raw = h.startsWith('/') ? h : '/' + h;
  const i = raw.indexOf('?');
  const path = (i < 0 ? raw : raw.slice(0, i)).replace(/\/+$/, '') || '/';
  return { path: decodeURI(path), search: i < 0 ? '' : raw.slice(i + 1) };
}
let cur = read();
const subs = new Set<() => void>();
if (typeof window !== 'undefined')
  window.addEventListener('hashchange', () => {
    const n = read();
    if (n.path === cur.path && n.search === cur.search) return;
    cur = n;
    subs.forEach((f) => f());
  });

export const getLoc = () => cur;
export function useLoc(): Loc {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => cur,
    () => cur,
  );
}

/** "/x?y" → hash navigation; full URLs → leave the demo */
export function navigate(url: string, replace = false) {
  if (/^[a-z]+:/i.test(url) && !url.startsWith(window.location.href.split('#')[0])) {
    window.location.href = url;
    return;
  }
  let u = url.includes('#') ? url.slice(url.indexOf('#') + 1) : url;
  if (u.startsWith('?')) u = cur.path + u;
  if (!u.startsWith('/')) u = '/' + u;
  if (replace) window.location.replace('#' + u);
  else window.location.hash = u;
  window.scrollTo?.(0, 0);
}

export const ParamsCtx = createContext<Record<string, string | string[]>>({});
export const useRouteParams = () => useContext(ParamsCtx);

/** stand-in for the parts of window.location the pages read / assign (the build rewrites them to this) */
export function installDemoLocation(go: (path: string) => void) {
  const loc = {
    get href() {
      return window.location.href;
    },
    set href(v: string) {
      if (v.startsWith('/')) go(v);
      else if (v.startsWith('#')) window.location.hash = v;
      else window.location.href = v;
    },
    get pathname() {
      return cur.path;
    },
    get search() {
      return cur.search ? '?' + cur.search : '';
    },
    get origin() {
      // links built as origin + "/login" open the same demo file on that screen
      return window.location.href.split('#')[0] + '#';
    },
    get hostname() {
      return window.location.hostname || 'localhost';
    },
  };
  (window as any).__demoLoc = loc;
}
