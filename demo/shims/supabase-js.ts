// The demo never talks to Supabase: web/lib/supabase.ts returns the in-browser client instead.
export type SupabaseClient = any;
export function createClient(): never {
  throw new Error('Supabase is not available in the demo');
}
