'use client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function sb(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}

export async function logAct(action: string, entity?: string, entityId?: string, details?: Record<string, unknown>) {
  await sb().rpc('log_activity', {
    p_action: action,
    p_entity: entity ?? null,
    p_entity_id: entityId ?? null,
    p_details: details ?? null,
  });
}
