// Demo entry: the real BotiX pages from web/app, routed by the URL hash, over the in-browser demo database.
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from '@/lib/auth';
import { applyPersona, demoGo, currentPersona, setPersona, resetDemo } from '@/lib/demo/client';
import { sb } from '@/lib/supabase';
import routes from 'demo-routes';
import { useLoc, ParamsCtx, installDemoLocation, navigate } from './router';
import { DemoRibbon } from './Ribbon';

type Route = { pattern: string; re: RegExp; keys: string[]; Page: any; layouts: any[] };

installDemoLocation(demoGo);
// for tests / curious owners in the console
(window as any).__botixDemo = { sb, setPersona, resetDemo };

// first visit: start logged in as the system owner, on the home screen
try {
  if (!localStorage.getItem('botix-demo-started')) {
    localStorage.setItem('botix-demo-started', '1');
    applyPersona('owner');
  }
  // no lock screen in the demo
  localStorage.setItem('wa-remember-until', String(Date.now() + 30 * 86_400_000));
  localStorage.setItem('wa-lock-asked', '1');
} catch {}

// the app asks the server which version is live; in the demo it never changes
const realFetch = window.fetch.bind(window);
window.fetch = (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.startsWith('/api/version')) return Promise.resolve(new Response(JSON.stringify({ sha: 'demo' }), { headers: { 'content-type': 'application/json' } }));
  return realFetch(input, init);
};

// plain <a href="/x"> links inside pages → hash navigation
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const a = (e.target as HTMLElement)?.closest?.('a');
  if (!a || a.target === '_blank') return;
  const href = a.getAttribute('href') || '';
  if (href.startsWith('/') && !href.startsWith('//')) {
    e.preventDefault();
    navigate(href);
  }
});

class Boundary extends Component<{ children: ReactNode; k: string }, { err: any }> {
  state = { err: null as any };
  static getDerivedStateFromError(err: any) {
    return { err };
  }
  componentDidCatch(err: any) {
    console.error('[demo] screen crashed:', err?.message || err);
  }
  componentDidUpdate(prev: any) {
    if (prev.k !== this.props.k && this.state.err) this.setState({ err: null });
  }
  render() {
    if (this.state.err)
      return (
        <div data-demo-error className="mx-auto my-16 max-w-md rounded-2xl bg-rose-50 p-6 text-center text-rose-900 ring-1 ring-rose-200">
          <div className="text-lg font-bold">המסך נתקל בשגיאה</div>
          <div className="mt-2 break-words text-sm" dir="ltr">
            {String(this.state.err?.message || this.state.err)}
          </div>
        </div>
      );
    return this.props.children;
  }
}

function match(path: string): { r: Route; params: Record<string, string> } | null {
  for (const r of routes as Route[]) {
    const m = r.re.exec(path);
    if (m) return { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

function NotFound() {
  return (
    <div className="py-20 text-center text-slate-500">
      <div className="text-lg font-semibold text-slate-700">המסך הזה עוד לא קיים בהדגמה</div>
      <button className="mt-3 text-sm font-medium text-indigo-600" onClick={() => navigate('/')}>
        חזרה לבית
      </button>
    </div>
  );
}

function App() {
  const { path } = useLoc();
  const hit = match(path);
  // unknown screens are shown inside the app frame (like the real app's not-found)
  const appLayouts = (routes as Route[]).find((r) => r.pattern === '/')?.layouts || [];
  const layouts = hit ? hit.r.layouts : appLayouts;
  const key = hit ? hit.r.pattern + JSON.stringify(hit.params) : 'nf';
  let el: ReactNode = (
    <Boundary k={key}>{hit ? <hit.r.Page key={key} params={Promise.resolve(hit.params)} searchParams={Promise.resolve({})} /> : <NotFound />}</Boundary>
  );
  for (let i = layouts.length - 1; i >= 0; i--) {
    const L = layouts[i];
    el = <L>{el}</L>;
  }
  return <ParamsCtx.Provider value={hit?.params || {}}>{el}</ParamsCtx.Provider>;
}

// a station whose subscription ended lands on its subscription page
if (!window.location.hash && currentPersona() === 'expired') window.location.replace('#/subscription');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <Boundary k="root">
        <App />
      </Boundary>
    </AuthProvider>
    <DemoRibbon />
  </StrictMode>,
);
