import { sb } from './supabase';

// The database API returns at most 1,000 rows per request – also with .limit(5000) – and cuts the rest silently.
// Anything that can be bigger (groups of a station, groups of a ride, lists) is read in pages until complete.
// build() must return a fresh query with a stable .order().
export async function allRows(build: () => any, page = 1000): Promise<{ data: any[] }> {
  const out: any[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build().range(from, from + page - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return { data: out };
}

export function allGroups(columns: string): Promise<{ data: any[] }> {
  return allRows(() => sb().from('groups').select(columns).order('id'));
}
