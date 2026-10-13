// The demo stand-in for the supabase-js client: same API surface the app uses, no network.
import { Query } from './query';
import { callRpc } from './rpc';
import { startSim } from './sim';
import { table, nextId, touch, resetDemoDB, getDB, saveNow } from './store';
import { AUTH_KEY } from './ctx';
import { homeStation } from './ctx';
import { iso, newUuid } from './util';
import { ID, SHARON_TOKEN, SOUTH_TOKEN } from './seed';

const TOKEN_KEY = 'wa-station-token';
const ACT_KEY = 'wa-act-station';

function ls(k: string, v?: string | null) {
  try {
    if (v === undefined) return window.localStorage.getItem(k);
    if (v === null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, v);
  } catch {}
  return null;
}

// ---------------------------------------------------------------- navigation (hash routing)
/** go to an app path (e.g. "/stations") with a fresh start, like a full page load in the real app */
export function demoGo(path: string) {
  const p = path.startsWith('/') ? path : '/' + path;
  saveNow();
  try {
    window.location.hash = '#' + p;
  } catch {}
  window.location.reload();
}

// ---------------------------------------------------------------- auth
type Listener = (event: string, session: any) => void;
const listeners = new Set<Listener>();
function session() {
  const uid = ls(AUTH_KEY);
  if (!uid || ls(TOKEN_KEY)) return null;
  const p = table('profiles').find((x) => x.id === uid);
  if (!p) return null;
  return {
    access_token: 'demo-access-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'demo',
    user: { id: p.id, email: p.email, aud: 'authenticated', role: 'authenticated', user_metadata: { full_name: p.full_name }, app_metadata: {}, created_at: p.created_at },
  };
}
const emit = (e: string) => {
  const s = session();
  setTimeout(() => listeners.forEach((f) => f(e, s)), 0);
};
const ok = (data: any) => ({ data, error: null });
const authErr = (message: string, status = 400) => ({ data: { user: null, session: null }, error: { message, status, name: 'AuthApiError', code: 'invalid_credentials' } });
const wait = () => new Promise((r) => setTimeout(r, 120));

const auth = {
  async getSession() {
    return ok({ session: session() });
  },
  async getUser() {
    const s = session();
    return ok({ user: s?.user ?? null });
  },
  onAuthStateChange(cb: Listener) {
    listeners.add(cb);
    setTimeout(() => cb('INITIAL_SESSION', session()), 0);
    return { data: { subscription: { id: 'demo', unsubscribe: () => listeners.delete(cb) } } };
  },
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    await wait();
    const p = table('profiles').find((x) => String(x.email).toLowerCase() === String(email || '').trim().toLowerCase());
    if (!p || !password) return authErr('Invalid login credentials');
    ls(TOKEN_KEY, null);
    ls(AUTH_KEY, p.id);
    emit('SIGNED_IN');
    return ok({ user: session()!.user, session: session() });
  },
  async signUp({ email, options }: { email: string; password: string; options?: any }) {
    await wait();
    const e = String(email || '').trim().toLowerCase();
    if (!e.includes('@')) return authErr('Unable to validate email address: invalid format');
    if (table('profiles').some((x) => String(x.email).toLowerCase() === e)) return authErr('User already registered', 422);
    const id = newUuid();
    table('profiles').push({
      id, email: e, full_name: options?.data?.full_name || e.split('@')[0], role: 'viewer', is_active: false, is_primary: false, title: null, created_at: iso(), station_id: homeStation(),
    });
    touch();
    ls(TOKEN_KEY, null);
    ls(AUTH_KEY, id);
    emit('SIGNED_IN');
    return ok({ user: session()!.user, session: session() });
  },
  async signOut() {
    ls(AUTH_KEY, null);
    ls(ACT_KEY, null);
    emit('SIGNED_OUT');
    return { error: null };
  },
  async updateUser(_attrs: any) {
    await wait();
    const s = session();
    if (!s) return authErr('Auth session missing!');
    emit('USER_UPDATED');
    return ok({ user: s.user });
  },
  async resetPasswordForEmail() {
    return ok({});
  },
  async refreshSession() {
    return ok({ session: session(), user: session()?.user ?? null });
  },
  async setSession() {
    return ok({ session: session(), user: session()?.user ?? null });
  },
  async verifyOtp() {
    return ok({ session: session(), user: session()?.user ?? null });
  },
  async exchangeCodeForSession() {
    return ok({ session: session(), user: session()?.user ?? null });
  },
  startAutoRefresh() {},
  stopAutoRefresh() {},
};

// ---------------------------------------------------------------- client
const channel = () => {
  const ch: any = { on: () => ch, subscribe: (cb?: any) => (cb && setTimeout(() => cb('SUBSCRIBED'), 0), ch), unsubscribe: async () => 'ok', send: async () => 'ok' };
  return ch;
};

let made: any = null;
export function createDemoClient() {
  if (made) return made;
  getDB();
  startSim();
  made = {
    from: (t: string) => new Query(t),
    schema: () => made,
    rpc: (fn: string, args?: any, opts?: { head?: boolean; count?: string }) => Query.rpc(() => callRpc(fn, args), opts),
    auth,
    functions: {
      async invoke(_name: string, _o?: any) {
        await wait();
        return { data: { ok: true, demo: true }, error: null };
      },
    },
    channel,
    removeChannel: async () => 'ok',
    removeAllChannels: async () => [],
    getChannels: () => [],
    storage: {
      from: () => ({
        upload: async () => ok({ path: 'demo' }),
        getPublicUrl: () => ({ data: { publicUrl: '' } }),
        remove: async () => ok([]),
        list: async () => ok([]),
      }),
    },
  };
  return made;
}

// ---------------------------------------------------------------- personas (the demo ribbon)
export type PersonaKey = 'owner' | 'station' | 'expired' | 'operator' | 'viewer';
export const PERSONAS: { key: PersonaKey; label: string; sub: string }[] = [
  { key: 'owner', label: 'בעל המערכת', sub: 'מאיר' },
  { key: 'station', label: 'מנהל תחנה', sub: 'מוניות השרון' },
  { key: 'expired', label: 'תחנה שהמנוי שלה הסתיים', sub: 'אורות הדרום' },
  { key: 'operator', label: 'סדרן', sub: 'דנה' },
  { key: 'viewer', label: 'צופה', sub: 'יוסי' },
];
export function currentPersona(): PersonaKey | null {
  const tok = ls(TOKEN_KEY);
  if (tok === SHARON_TOKEN) return 'station';
  if (tok === SOUTH_TOKEN) return 'expired';
  if (tok) return null;
  const uid = ls(AUTH_KEY);
  if (uid === ID.meir) return 'owner';
  if (uid === ID.dana) return 'operator';
  if (uid === ID.yossi) return 'viewer';
  return null;
}
/** switch who is logged in (no reload) */
export function applyPersona(k: PersonaKey) {
  ls(ACT_KEY, null);
  ls(TOKEN_KEY, null);
  ls(AUTH_KEY, null);
  if (k === 'owner') ls(AUTH_KEY, ID.meir);
  if (k === 'operator') ls(AUTH_KEY, ID.dana);
  if (k === 'viewer') ls(AUTH_KEY, ID.yossi);
  if (k === 'station' || k === 'expired') {
    const tok = k === 'station' ? SHARON_TOKEN : SOUTH_TOKEN;
    const sid = k === 'station' ? ID.sharon : ID.south;
    // the persona's session may have been logged out while playing: bring it back
    const s = table('station_sessions').find((x) => x.token_hash === tok);
    if (s) s.revoked_at = null;
    else table('station_sessions').push({ token_hash: tok, station_id: sid, created_at: iso(), last_seen: iso(), revoked_at: null });
    touch();
    ls(TOKEN_KEY, tok);
  }
  // no lock screen in the demo
  ls('wa-remember-until', String(Date.now() + 30 * 86_400_000));
  ls('wa-lock-asked', '1');
}
export function setPersona(k: PersonaKey, path = '/') {
  applyPersona(k);
  demoGo(k === 'expired' ? '/subscription' : path);
}

export function resetDemo() {
  const p = currentPersona() || 'owner';
  resetDemoDB();
  applyPersona(p);
  demoGo('/');
}

export function waOutbox(limit = 40) {
  return table('wa_outbox')
    .slice()
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}
export { lastRideTexts } from './sim';
export { onChange, demoDBSize } from './store';
void nextId;
