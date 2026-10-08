'use client';
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { sb } from './supabase';

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';
export type Profile = { id: string; email: string; full_name: string | null; role: Role; is_active: boolean };

const RANK: Record<Role, number> = { owner: 4, admin: 3, operator: 2, viewer: 1 };

type AuthCtx = {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  rank: number;
  can: (min: Role) => boolean;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
};

const Ctx = createContext<AuthCtx>({
  loading: true,
  session: null,
  profile: null,
  rank: 0,
  can: () => false,
  signOut: async () => {},
  reload: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null);
      return;
    }
    const { data } = await sb().from('profiles').select('*').eq('id', s.user.id).maybeSingle();
    setProfile((data as Profile) ?? null);
  }, []);

  useEffect(() => {
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
  }, [loadProfile]);

  const rank = profile?.is_active ? RANK[profile.role] : 0;

  return (
    <Ctx.Provider
      value={{
        loading,
        session,
        profile,
        rank,
        can: (min) => rank >= RANK[min],
        signOut: async () => {
          await sb().auth.signOut();
        },
        reload: () => loadProfile(session),
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
