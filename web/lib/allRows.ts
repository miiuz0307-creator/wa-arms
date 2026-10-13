import { sb } from './supabase';

// The database API returns at most 1,000 rows per request (also with .limit(5000)).
// A station can have more groups than that, so read in pages until everything is here.
export async function allGroups(columns: string): Promise<{ data: any[] }> {
  const page = 1000;
  const out: any[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await sb().from('groups').select(columns).order('id').range(from, from + page - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return { data: out };
}
