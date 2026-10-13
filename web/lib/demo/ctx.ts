// Who is calling: the demo version of auth.uid(), my_station(), my_rank(), is_super() and the request headers.
import { table, type Row } from './store';
import { localDate } from './util';

export const AUTH_KEY = 'botix-demo-auth';
const TOKEN_KEY = 'wa-station-token';
const ACT_KEY = 'wa-act-station';
const RANK: Record<string, number> = { owner: 4, admin: 3, operator: 2, viewer: 1 };

function get(k: string) {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(k);
  } catch {
    return null;
  }
}

export type Ctx = {
  uid: string | null;
  profile: Row | null;
  /** x-station-token header */
  token: string | null;
  /** x-act-station header (the owner managing a station) */
  act: string | null;
  station: string | null;
  rank: number;
  isSuper: boolean;
  /** display name for activity / support messages */
  actorName: string | null;
};

export const homeStation = () => table('stations').find((s) => s.is_home)?.id ?? null;
export const stationById = (id: string | null | undefined) => (id ? table('stations').find((s) => s.id === id) ?? null : null);

/** station of a valid station-code session (station_from_token) */
export function stationFromToken(tok: string | null): string | null {
  if (!tok) return null;
  const s = table('station_sessions').find((x) => x.token_hash === tok && !x.revoked_at);
  if (!s) return null;
  const st = stationById(s.station_id);
  if (!st || st.status !== 'active' || st.is_home || (st.sub_end && st.sub_end < localDate())) return null;
  return st.id;
}

export function ctx(): Ctx {
  const token = get(TOKEN_KEY);
  const actRaw = token ? null : get(ACT_KEY);
  const uid = token ? null : get(AUTH_KEY);
  const profile = uid ? table('profiles').find((p) => p.id === uid) ?? null : null;
  let station: string | null = null;
  let rank = 0;
  if (token) {
    station = stationFromToken(token);
    rank = station ? 3 : 0;
  } else if (profile && profile.is_active) {
    rank = RANK[profile.role] || 0;
    if (profile.role === 'owner' && actRaw) station = stationById(actRaw)?.id ?? homeStation();
    // demo: team accounts (דנה / יוסי) work inside the station their profile belongs to
    else station = profile.role === 'owner' ? homeStation() : profile.station_id || homeStation();
  }
  const isSuper = !token && !!profile && profile.is_active && profile.role === 'owner';
  return {
    uid,
    profile,
    token,
    act: actRaw,
    station,
    rank,
    isSuper,
    actorName: token ? 'מנהל התחנה' : profile ? profile.full_name || profile.email : null,
  };
}
