'use client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Station mode: a station logs in with its code and gets a session token. Every request carries it
// in the x-station-token header, and the database only shows that station's rows.
// Owner "enter station": the owner's own login plus x-act-station = the station being managed.
const TOKEN_KEY = 'wa-station-token';
const ACT_KEY = 'wa-act-station';

function read(key: string) {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string | null) {
  try {
    if (v) window.localStorage.setItem(key, v);
    else window.localStorage.removeItem(key);
  } catch {}
}

export const stationToken = () => read(TOKEN_KEY);
export const actingStation = () => (stationToken() ? null : read(ACT_KEY));
/** No realtime events in station / acting mode (the realtime server doesn't see our headers) – poll instead. */
export const needsPolling = () => !!(stationToken() || actingStation());

let client: SupabaseClient | null = null;

export function sb(): SupabaseClient {
  if (!client) {
    const token = stationToken();
    const acting = actingStation();
    const headers: Record<string, string> = {};
    if (token) headers['x-station-token'] = token;
    else if (acting) headers['x-act-station'] = acting;
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: token
        ? { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'wa-station-nosession' }
        : { persistSession: true, autoRefreshToken: true },
      global: { headers },
    });
  }
  return client;
}

/** Switch mode and reload so every request uses the new headers. */
export function enterStationMode(token: string) {
  write(TOKEN_KEY, token);
  write(ACT_KEY, null);
  window.location.href = '/';
}
export function leaveStationMode() {
  write(TOKEN_KEY, null);
  window.location.href = '/login';
}
export function actAsStation(id: string | null) {
  write(ACT_KEY, id);
  window.location.href = id ? '/' : '/stations';
}

export async function logAct(action: string, entity?: string, entityId?: string, details?: Record<string, unknown>) {
  await sb().rpc('log_activity', {
    p_action: action,
    p_entity: entity ?? null,
    p_entity_id: entityId ?? null,
    p_details: details ?? null,
  });
}
