'use client';
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { sb, stationToken, leaveStationMode, actAsStation, actingStation } from './supabase';

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';
export type Profile = { id: string; email: string; full_name: string | null; role: Role; is_active: boolean };
export type Station = {
  id: string;
  name: string;
  is_home: boolean;
  status: string;
  sub_end: string | null;
  max_arms: number | null;
  via_code: boolean;
  acting: boolean;
};

const RANK: Record<Role, number> = { owner: 4, admin: 3, operator: 2, viewer: 1 };

type AuthCtx = {
  loading: boolean;
  /** truthy when someone is logged in (owner/team account or station code) */
  session: unknown;
  profile: Profile | null;
  station: Station | null;
  /** logged in with a station code */
  isStation: boolean;
  /** the owner (not a station, possibly managing a station right now) */
  isSuper: boolean;
  rank: number;
  can: (min: Role) => boolean;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
};

const Ctx = createContext<AuthCtx>({
  loading: true,
  session: null,
  profile: null,
  station: null,
  isStation: false,
  isSuper: false,
  rank: 0,
  can: () => false,
  signOut: async () => {},
  reload: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<unknown>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [station, setStation] = useState<Station | null>(null);
  const isStation = !!stationToken();

  const loadStation = useCallback(async () => {
    const { data } = await sb().rpc('station_me');
    setStation((data as Station) ?? null);
    return (data as Station) ?? null;
  }, []);

  const loadProfile = useCallback(
    async (s: any) => {
      if (!s) {
        setProfile(null);
        setStation(null);
        return;
      }
      const { data } = await sb().from('profiles').select('*').eq('id', s.user.id).maybeSingle();
      setProfile((data as Profile) ?? null);
      const st = await loadStation();
      // the station being managed was deleted
      if (actingStation() && !st) actAsStation(null);
    },
    [loadStation],
  );

  useEffect(() => {
    if (isStation) {
      // station code login: the token is checked by the database on every request
      loadStation().then((st) => {
        if (!st) {
          leaveStationMode();
          return;
        }
        setSession({ station: st.id });
        setProfile({ id: 'station', email: '', full_name: st.name, role: 'admin', is_active: true });
        setLoading(false);
      });
      const ping = setInterval(() => {
        sb().rpc('station_ping');
        // suspended / code changed / subscription ended → out
        loadStation().then((st) => {
          if (!st) leaveStationMode();
        });
      }, 120_000);
      sb().rpc('station_ping');
      return () => clearInterval(ping);
    }
    sb()
      .auth.getSession()
      .then(async ({ data }) => {
        setSession(data.session);
        await loadProfile(data.session);
        setLoading(false);
      });
    const { data: sub } = sb().auth.onAuthStateChange((_e, s) => {
      setSession(s);
      loadProfile(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [isStation, loadProfile, loadStation]);

  const rank = profile?.is_active ? RANK[profile.role] : 0;
  const isSuper = !isStation && profile?.role === 'owner' && !!profile?.is_active;

  return (
    <Ctx.Provider
      value={{
        loading,
        session,
        profile,
        station,
        isStation,
        isSuper,
        rank,
        can: (min) => rank >= RANK[min],
        signOut: async () => {
          if (isStation) {
            await sb().rpc('station_logout');
            leaveStationMode();
            return;
          }
          await sb().auth.signOut();
        },
        reload: () => (isStation ? loadStation().then(() => {}) : sb().auth.getSession().then(({ data }) => loadProfile(data.session))),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
export const ROLE_LABEL: Record<Role, string> = {
  owner: 'בעלים',
  admin: 'מנהל',
  operator: 'מפעיל',
  viewer: 'צפייה בלבד',
};

/** user id for created_by columns (station-code logins have no user account) */
export const myUid = (p: Profile | null) => (p && p.id !== 'station' ? p.id : null);
