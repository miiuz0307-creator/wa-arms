// A small PostgREST / supabase-js query builder over the in-browser demo database.
// Supports what the app uses: select (columns, embedded resources, count/head), filters, order, range/limit,
// single/maybeSingle, insert / upsert / update / delete (+ .select()), row level security like the real DB.
import { META, FKS, table, setTable, nextId, touch, type Row } from './store';
import { ctx, homeStation, type Ctx } from './ctx';
import { iso, newUuid, DemoError } from './util';

export type PgError = { message: string; code: string; details: string | null; hint: string | null };
export type Result = { data: any; error: PgError | null; count: number | null; status: number; statusText: string };

const MAX_ROWS = 1000;
const latency = () => new Promise((r) => setTimeout(r, 8 + Math.random() * 25));

export const pgError = (message: string, code = 'P0001'): PgError => ({ message, code, details: null, hint: null });
const fail = (message: string, code: string): never => {
  throw new DemoError(message, code);
};

// ---------------------------------------------------------------- value helpers
const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
function coerce(rowVal: any, v: any) {
  if (v === null || v === undefined) return v;
  if (typeof rowVal === 'number') return typeof v === 'number' ? v : Number(v);
  if (typeof rowVal === 'boolean') return v === true || v === 'true';
  return v;
}
function compare(a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  const sa = String(a);
  const sb2 = String(b);
  if (DATE_RE.test(sa) && DATE_RE.test(sb2) && (sa.length > 10 || sb2.length > 10)) {
    const d = Date.parse(sa.length === 10 ? sa + 'T00:00:00' : sa) - Date.parse(sb2.length === 10 ? sb2 + 'T00:00:00' : sb2);
    if (!Number.isNaN(d)) return d;
  }
  return sa < sb2 ? -1 : sa > sb2 ? 1 : 0;
}
const eqVal = (a: any, b: any) => {
  const v = coerce(a, b);
  if (a === null || a === undefined) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(v);
  return compare(a, v) === 0;
};
function likeRe(pattern: string, ci: boolean) {
  const s = String(pattern)
    .split('')
    .map((ch) => (ch === '%' || ch === '*' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp('^' + s + '$', ci ? 'is' : 's');
}
function contains(a: any, v: any): boolean {
  if (a === null || a === undefined) return false;
  if (typeof v === 'string' && v.startsWith('{')) v = v.slice(1, -1).split(',').filter(Boolean);
  if (Array.isArray(a)) return (Array.isArray(v) ? v : [v]).every((x) => a.some((y) => eqVal(y, x)));
  if (typeof a === 'object' && typeof v === 'object') return Object.entries(v).every(([k, x]) => k in a && JSON.stringify(a[k]) === JSON.stringify(x));
  return false;
}
/** "(a,b,"c d")" → ['a','b','c d'] */
function parseList(v: any): any[] {
  if (Array.isArray(v)) return v;
  const s = String(v).trim().replace(/^\(|\)$/g, '');
  return splitTop(s).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
}
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = false;
  let cur = '';
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}
const getCol = (row: Row, col: string) => {
  if (col.includes('->')) {
    const parts = col.split(/->>?/);
    let v: any = row[parts[0].trim()];
    for (const p of parts.slice(1)) v = v == null ? null : v[p.trim().replace(/^'|'$/g, '')];
    return v;
  }
  return row[col];
};

type Pred = (row: Row) => boolean;
function opPred(col: string, op: string, val: any): Pred {
  switch (op) {
    case 'eq':
      return (r) => eqVal(getCol(r, col), val);
    case 'neq':
      return (r) => {
        const a = getCol(r, col);
        return a !== null && a !== undefined && !eqVal(a, val);
      };
    case 'gt':
      return (r) => getCol(r, col) != null && compare(getCol(r, col), coerce(getCol(r, col), val)) > 0;
    case 'gte':
      return (r) => getCol(r, col) != null && compare(getCol(r, col), coerce(getCol(r, col), val)) >= 0;
    case 'lt':
      return (r) => getCol(r, col) != null && compare(getCol(r, col), coerce(getCol(r, col), val)) < 0;
    case 'lte':
      return (r) => getCol(r, col) != null && compare(getCol(r, col), coerce(getCol(r, col), val)) <= 0;
    case 'like':
    case 'ilike': {
      const re = likeRe(String(val), op === 'ilike');
      return (r) => getCol(r, col) != null && re.test(String(getCol(r, col)));
    }
    case 'is': {
      const v = val === 'null' ? null : val === 'true' ? true : val === 'false' ? false : val;
      return (r) => (v === null ? getCol(r, col) == null : getCol(r, col) === v);
    }
    case 'in': {
      const list = parseList(val);
      return (r) => list.some((x) => eqVal(getCol(r, col), x));
    }
    case 'cs':
    case 'contains':
      return (r) => contains(getCol(r, col), typeof val === 'string' && val.startsWith('[') ? JSON.parse(val) : val);
    case 'cd':
    case 'containedBy':
      return (r) => {
        const a = getCol(r, col);
        const list = parseList(val);
        return Array.isArray(a) && a.every((x) => list.some((y) => eqVal(x, y)));
      };
    case 'ov':
    case 'overlaps':
      return (r) => {
        const a = getCol(r, col);
        const list = parseList(val);
        return Array.isArray(a) && a.some((x) => list.some((y) => eqVal(x, y)));
      };
    case 'fts':
    case 'plfts':
    case 'wfts':
    case 'phfts':
      return (r) => String(getCol(r, col) ?? '').includes(String(val));
    default:
      return fail(`unknown operator ${op}`, 'PGRST100');
  }
}
/** PostgREST logic tree string: "a.eq.1,b.ilike.*x*,and(c.gt.2,d.is.null)" */
function orPred(expr: string, and = false): Pred {
  const parts = splitTop(expr).map((p) => p.trim()).filter(Boolean);
  const preds = parts.map((p): Pred => {
    let neg = false;
    let s = p;
    if (s.startsWith('not.')) {
      neg = true;
      s = s.slice(4);
    }
    const m = /^(and|or)\((.*)\)$/s.exec(s);
    let pr: Pred;
    if (m) pr = orPred(m[2], m[1] === 'and');
    else {
      const i1 = s.indexOf('.');
      const col = s.slice(0, i1);
      let rest = s.slice(i1 + 1);
      let negOp = false;
      if (rest.startsWith('not.')) {
        negOp = true;
        rest = rest.slice(4);
      }
      const i2 = rest.indexOf('.');
      const op = rest.slice(0, i2);
      const val = rest.slice(i2 + 1);
      const base = opPred(col, op, val);
      pr = negOp ? (r) => !base(r) : base;
    }
    return neg ? (r) => !pr(r) : pr;
  });
  return and ? (r) => preds.every((f) => f(r)) : (r) => preds.some((f) => f(r));
}

// ---------------------------------------------------------------- row level security
function metaOf(t: string) {
  const m = META[t];
  if (!m) fail(`Could not find the table 'public.${t}' in the schema cache`, 'PGRST205');
  return m!;
}
export function canRead(t: string, row: Row, c: Ctx): boolean {
  const m = metaOf(t);
  if (t === 'stations') return c.isSuper;
  if (t === 'profiles') return (row.id === c.uid || (c.station != null && row.station_id === c.station)) && (row.id === c.uid || c.rank >= 3);
  if (m.closed) return fail(`permission denied for table ${t}`, '42501');
  if (m.station) return c.station != null && row.station_id === c.station && c.rank >= (m.read ?? 1);
  return true;
}
function canWrite(t: string, row: Row, c: Ctx, op: 'insert' | 'update' | 'delete'): boolean {
  const m = metaOf(t);
  if (t === 'stations') return op === 'delete' ? c.isSuper && !row.is_home : false;
  if (t === 'profiles') return op === 'update' && c.rank === 4 && canRead(t, row, c);
  if (m.closed) return fail(`permission denied for table ${t}`, '42501');
  if (m.station) return c.station != null && row.station_id === c.station && c.rank >= (m.write ?? 3);
  return false;
}
export const visibleRows = (t: string, c: Ctx = ctx()) => table(t).filter((r) => canRead(t, r, c));

// ---------------------------------------------------------------- select parsing / embedding
type Sel = { kind: 'star' } | { kind: 'col'; col: string; as: string } | { kind: 'embed'; rel: string; as: string; inner: boolean; cols: Sel[]; count: boolean };
function parseSelect(s: string | undefined): Sel[] {
  const str = (s ?? '*').replace(/\s+/g, ' ').trim() || '*';
  return splitTop(str)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((item): Sel => {
      if (item === '*') return { kind: 'star' };
      const m = /^(?:([\w]+):)?([\w]+)(?:!([\w]+))?\s*\((.*)\)$/s.exec(item);
      if (m) {
        const inner = (m[3] || '') === 'inner';
        const body = m[4].trim();
        const count = body === 'count' || body === 'count()';
        return { kind: 'embed', rel: m[2], as: m[1] || m[2], inner, cols: count ? [] : parseSelect(body), count };
      }
      const a = /^(?:([\w]+):)?(.+?)(?:::\w+)?$/.exec(item)!;
      const col = a[2].trim();
      const as = a[1] || (col.includes('->') ? col.split(/->>?/).pop()!.replace(/'/g, '').trim() : col);
      return { kind: 'col', col, as };
    });
}
function relation(from: string, rel: string): { kind: 'one' | 'many'; col: string } | null {
  const toOne = FKS.find(([child, , parent]) => child === from && parent === rel);
  if (toOne) return { kind: 'one', col: toOne[1] };
  const toMany = FKS.find(([child, , parent]) => child === rel && parent === from);
  if (toMany) return { kind: 'many', col: toMany[1] };
  return null;
}
function project(t: string, row: Row, sels: Sel[], c: Ctx): Row | null {
  const out: Row = {};
  for (const s of sels) {
    if (s.kind === 'star') Object.assign(out, row);
    else if (s.kind === 'col') out[s.as] = getCol(row, s.col) ?? null;
    else {
      const r = relation(t, s.rel);
      if (!r) fail(`Could not find a relationship between '${t}' and '${s.rel}' in the schema cache`, 'PGRST200');
      if (r!.kind === 'one') {
        const p = row[r!.col] == null ? null : table(s.rel).find((x) => x.id === row[r!.col] && safeRead(s.rel, x, c)) ?? null;
        if (!p && s.inner) return null;
        out[s.as] = p ? project(s.rel, p, s.cols.length ? s.cols : [{ kind: 'star' }], c) : null;
      } else {
        const kids = table(s.rel).filter((x) => x[r!.col] === row.id && safeRead(s.rel, x, c));
        if (s.inner && !kids.length) return null;
        out[s.as] = s.count ? [{ count: kids.length }] : kids.map((k) => project(s.rel, k, s.cols.length ? s.cols : [{ kind: 'star' }], c));
      }
    }
  }
  return out;
}
function safeRead(t: string, row: Row, c: Ctx) {
  try {
    return canRead(t, row, c);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- write helpers
function pkOf(t: string) {
  return metaOf(t).pk;
}
function keyMatch(cols: string[], a: Row, b: Row) {
  return cols.every((k) => a[k] !== undefined && a[k] !== null && String(a[k]) === String(b[k]));
}
function uniqueSets(t: string) {
  const m = metaOf(t);
  return [m.pk, ...(m.unique || [])];
}
function withDefaults(t: string, input: Row, c: Ctx): Row {
  const m = metaOf(t);
  const row: Row = { ...(m.defaults || {}) };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) row[k] = v;
  if (m.id === 'uuid' && row.id == null) row.id = newUuid();
  if (m.id === 'int' && row.id == null) row.id = nextId(t);
  if (!('created_at' in row) && t !== 'list_groups' && t !== 'list_arms' && t !== 'campaign_arms' && t !== 'group_flags') row.created_at = iso();
  if (t === 'groups' || t === 'group_flags' || t === 'app_settings' || t === 'arm_qr') row.updated_at ??= iso();
  if (t === 'group_flags') row.updated_by ??= c.uid;
  if (m.station) {
    if (m.inherit) {
      const [pt, col] = m.inherit;
      const parent = table(pt).find((x) => x.id === row[col]);
      if (parent) row.station_id = parent.station_id;
    }
    row.station_id ??= c.station ?? homeStation();
  }
  return row;
}
function checkRefs(t: string, row: Row) {
  for (const [child, col, parent] of FKS) {
    if (child !== t || row[col] == null) continue;
    if (parent === 'stations' && col === 'station_id') {
      if (!table('stations').some((s) => s.id === row[col])) fail(`insert or update on table "${t}" violates foreign key constraint "${t}_${col}_fkey"`, '23503');
      continue;
    }
    const p = table(parent).find((x) => x.id === row[col]);
    if (!p) fail(`insert or update on table "${t}" violates foreign key constraint "${t}_${col}_fkey"`, '23503');
    if (META[parent]?.station && META[t]?.station && p!.station_id !== row.station_id) fail(`שיוך לא חוקי בין תחנות (${col})`, 'P0001');
  }
}
function checkUnique(t: string, row: Row, except?: Row) {
  for (const cols of uniqueSets(t)) {
    if (cols.some((k) => row[k] == null)) continue;
    const dup = table(t).find((x) => x !== except && keyMatch(cols, row, x));
    if (dup) fail(`duplicate key value violates unique constraint "${t}_${cols.join('_')}_key"`, '23505');
  }
}
function beforeInsert(t: string, row: Row) {
  if (t === 'arms') {
    const st = table('stations').find((s) => s.id === row.station_id);
    const n = table('arms').filter((a) => a.station_id === row.station_id).length;
    if (st?.max_arms != null && n >= st.max_arms) fail(`הגעת למספר המכשירים המקסימלי לתחנה (${st.max_arms}). פנה למנהל המערכת.`, 'P0001');
  }
}
function beforeUpdate(t: string, old: Row, next: Row, c: Ctx) {
  if (t === 'profiles') {
    if (c.uid && next.is_primary !== old.is_primary) fail('אי אפשר לשנות מי הבעלים הראשי', 'P0001');
    if (old.is_primary && c.uid !== old.id && (next.role !== old.role || next.is_active !== old.is_active)) fail('אי אפשר לשנות את ההרשאות של הבעלים הראשי', 'P0001');
  }
  if (t === 'arms' && next.status !== old.status && next.status === 'online') next.last_connected_at = iso();
}
/** delete rows and cascade to children */
export function deleteRows(t: string, rows: Row[]) {
  if (!rows.length) return;
  const dead = new Set(rows);
  setTable(t, table(t).filter((r) => !dead.has(r)));
  const pk = pkOf(t);
  if (pk.length !== 1 || pk[0] !== 'id') return;
  const ids = new Set(rows.map((r) => r.id));
  for (const [child, col, parent, how] of FKS) {
    if (parent !== t) continue;
    const kids = table(child).filter((r) => ids.has(r[col]));
    if (!kids.length) continue;
    if (how === 'cascade') deleteRows(child, kids);
    else kids.forEach((k) => (k[col] = null));
  }
}

// ---------------------------------------------------------------- the builder
type Order = { col: string; asc: boolean; nullsFirst: boolean };
type Mode = 'select' | 'insert' | 'upsert' | 'update' | 'delete' | 'rpc';

export class Query implements PromiseLike<Result> {
  private mode: Mode = 'select';
  private cols: string | undefined = '*';
  private returning = false;
  private preds: Pred[] = [];
  private orders: Order[] = [];
  private lim: number | null = null;
  private from = 0;
  private to: number | null = null;
  private countMode: string | null = null;
  private head = false;
  private one: 'single' | 'maybe' | null = null;
  private payload: any = null;
  private onConflict: string | null = null;
  private ignoreDup = false;
  private throws = false;
  private rpcFn: (() => any) | null = null;

  constructor(private t: string) {}

  static rpc(fn: () => any, opts?: { head?: boolean; count?: string }) {
    const q = new Query('');
    q.mode = 'rpc';
    q.rpcFn = fn;
    q.cols = undefined;
    if (opts?.count) q.countMode = opts.count;
    if (opts?.head) q.head = true;
    return q;
  }

  // ----- verbs
  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === 'select' || this.mode === 'rpc') {
      if (cols !== undefined || this.mode === 'select') this.cols = cols ?? '*';
    } else {
      this.returning = true;
      this.cols = cols ?? '*';
    }
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.head = true;
    return this;
  }
  insert(v: any, opts?: { count?: string; defaultToNull?: boolean }) {
    this.mode = 'insert';
    this.payload = v;
    if (opts?.count) this.countMode = opts.count;
    return this;
  }
  upsert(v: any, opts?: { onConflict?: string; ignoreDuplicates?: boolean; count?: string }) {
    this.mode = 'upsert';
    this.payload = v;
    this.onConflict = opts?.onConflict ?? null;
    this.ignoreDup = !!opts?.ignoreDuplicates;
    if (opts?.count) this.countMode = opts.count;
    return this;
  }
  update(v: any, opts?: { count?: string }) {
    this.mode = 'update';
    this.payload = v;
    if (opts?.count) this.countMode = opts.count;
    return this;
  }
  delete(opts?: { count?: string }) {
    this.mode = 'delete';
    if (opts?.count) this.countMode = opts.count;
    return this;
  }

  // ----- filters
  private add(p: Pred) {
    this.preds.push(p);
    return this;
  }
  eq(c: string, v: any) {
    return this.add(opPred(c, 'eq', v));
  }
  neq(c: string, v: any) {
    return this.add(opPred(c, 'neq', v));
  }
  gt(c: string, v: any) {
    return this.add(opPred(c, 'gt', v));
  }
  gte(c: string, v: any) {
    return this.add(opPred(c, 'gte', v));
  }
  lt(c: string, v: any) {
    return this.add(opPred(c, 'lt', v));
  }
  lte(c: string, v: any) {
    return this.add(opPred(c, 'lte', v));
  }
  like(c: string, v: string) {
    return this.add(opPred(c, 'like', v));
  }
  ilike(c: string, v: string) {
    return this.add(opPred(c, 'ilike', v));
  }
  likeAnyOf(c: string, v: string[]) {
    return this.add((r) => v.some((x) => opPred(c, 'like', x)(r)));
  }
  ilikeAnyOf(c: string, v: string[]) {
    return this.add((r) => v.some((x) => opPred(c, 'ilike', x)(r)));
  }
  is(c: string, v: any) {
    return this.add(opPred(c, 'is', v === null ? 'null' : String(v)));
  }
  in(c: string, v: any[]) {
    return this.add(opPred(c, 'in', v));
  }
  contains(c: string, v: any) {
    return this.add(opPred(c, 'cs', v));
  }
  containedBy(c: string, v: any) {
    return this.add(opPred(c, 'cd', v));
  }
  overlaps(c: string, v: any) {
    return this.add(opPred(c, 'ov', v));
  }
  textSearch(c: string, v: string) {
    return this.add(opPred(c, 'fts', v));
  }
  match(o: Row) {
    Object.entries(o).forEach(([k, v]) => this.eq(k, v));
    return this;
  }
  not(c: string, op: string, v: any) {
    const p = opPred(c, op, v);
    return this.add((r) => (op === 'is' ? !p(r) : getCol(r, c) != null && !p(r)));
  }
  or(expr: string, _opts?: any) {
    return this.add(orPred(expr));
  }
  filter(c: string, op: string, v: any) {
    if (op.startsWith('not.')) return this.not(c, op.slice(4), v);
    return this.add(opPred(c, op, v));
  }

  // ----- modifiers
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string }) {
    if (opts?.foreignTable || opts?.referencedTable) return this;
    const asc = opts?.ascending !== false;
    this.orders.push({ col, asc, nullsFirst: opts?.nullsFirst ?? !asc });
    return this;
  }
  limit(n: number, _opts?: any) {
    this.lim = n;
    return this;
  }
  range(a: number, b: number, _opts?: any) {
    this.from = a;
    this.to = b;
    return this;
  }
  single() {
    this.one = 'single';
    return this;
  }
  maybeSingle() {
    this.one = 'maybe';
    return this;
  }
  throwOnError() {
    this.throws = true;
    return this;
  }
  abortSignal(_s: any) {
    return this;
  }
  returns() {
    return this;
  }
  overrideTypes() {
    return this;
  }
  csv() {
    return this;
  }
  explain() {
    return this;
  }

  // ----- run
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.run().then(ok, bad);
  }
  catch<B = never>(bad?: (e: any) => B | PromiseLike<B>) {
    return this.run().catch(bad);
  }
  finally(f?: () => void) {
    return this.run().finally(f);
  }

  private async run(): Promise<Result> {
    await latency();
    let res: Result;
    try {
      res = this.exec();
    } catch (e: any) {
      const err = pgError(e?.message || String(e), e?.code || 'P0001');
      if (!(e instanceof DemoError)) console.warn('[demo]', e);
      res = { data: null, error: err, count: null, status: err.code === '42501' ? 403 : 400, statusText: 'Bad Request' };
    }
    if (this.throws && res.error) throw res.error;
    return res;
  }

  private sortAndPage(rows: Row[]) {
    let out = rows;
    if (this.orders.length) {
      out = rows.slice().sort((a, b) => {
        for (const o of this.orders) {
          const va = getCol(a, o.col);
          const vb = getCol(b, o.col);
          const an = va === null || va === undefined;
          const bn = vb === null || vb === undefined;
          if (an || bn) {
            if (an && bn) continue;
            return (an ? -1 : 1) * (o.nullsFirst ? 1 : -1);
          }
          const d = compare(va, vb);
          if (d) return o.asc ? d : -d;
        }
        return 0;
      });
    }
    const count = out.length;
    let end = out.length;
    if (this.to !== null) end = Math.min(end, this.to + 1);
    if (this.lim !== null) end = Math.min(end, this.from + this.lim);
    end = Math.min(end, this.from + MAX_ROWS);
    return { rows: out.slice(this.from, Math.max(this.from, end)), count };
  }

  private finish(t: string, rows: Row[], c: Ctx, count: number | null): Result {
    const sels = parseSelect(this.cols);
    let data: any = rows.map((r) => (t ? project(t, r, sels, c) : this.cols && this.cols !== '*' ? projectPlain(r, sels) : r)).filter((x) => x !== null);
    if (this.head) data = null;
    if (this.one && data) {
      if (data.length === 1) data = data[0];
      else if (data.length === 0 && this.one === 'maybe') data = null;
      else {
        const err = pgError(
          data.length === 0 ? 'JSON object requested, multiple (or no) rows returned' : 'JSON object requested, multiple (or no) rows returned',
          'PGRST116',
        );
        err.details = `The result contains ${data.length} rows`;
        return { data: null, error: err, count: null, status: 406, statusText: 'Not Acceptable' };
      }
    }
    return { data, error: null, count: this.countMode ? count : null, status: 200, statusText: 'OK' };
  }

  private exec(): Result {
    const c = ctx();
    const t = this.t;
    if (this.mode === 'rpc') {
      const v = this.rpcFn!();
      if (Array.isArray(v)) {
        const filtered = v.filter((r) => this.preds.every((p) => p(r)));
        const { rows, count } = this.sortAndPage(filtered);
        return this.finish('', rows, c, count);
      }
      let data = v === undefined ? null : v;
      if (this.one === 'single' && data === null) return { data: null, error: pgError('JSON object requested, multiple (or no) rows returned', 'PGRST116'), count: null, status: 406, statusText: 'Not Acceptable' };
      if (this.head) data = null;
      return { data, error: null, count: null, status: 200, statusText: 'OK' };
    }
    metaOf(t);
    if (this.mode === 'select') {
      const all = table(t).filter((r) => canRead(t, r, c) && this.preds.every((p) => p(r)));
      const { rows, count } = this.sortAndPage(all);
      return this.finish(t, rows, c, count);
    }
    if (this.mode === 'insert' || this.mode === 'upsert') {
      const list: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      const done: Row[] = [];
      const conflictCols = this.onConflict ? this.onConflict.split(',').map((s) => s.trim()) : null;
      for (const input of list) {
        const row = withDefaults(t, input, c);
        if (this.mode === 'upsert') {
          const sets = conflictCols ? [conflictCols] : uniqueSets(t);
          let existing: Row | undefined;
          for (const cols of sets) {
            existing = table(t).find((x) => keyMatch(cols, row, x));
            if (existing) break;
          }
          if (existing) {
            if (this.ignoreDup) continue;
            if (!canRead(t, existing, c) || !canWrite(t, existing, c, 'update'))
              fail(`new row violates row-level security policy (USING expression) for table "${t}"`, '42501');
            const next = { ...existing };
            for (const [k, v] of Object.entries(input)) if (v !== undefined) next[k] = v;
            beforeUpdate(t, existing, next, c);
            checkRefs(t, next);
            Object.assign(existing, next);
            done.push(existing);
            continue;
          }
        }
        if (!canWrite(t, row, c, 'insert')) fail(`new row violates row-level security policy for table "${t}"`, '42501');
        checkRefs(t, row);
        checkUnique(t, row);
        beforeInsert(t, row);
        table(t).push(row);
        done.push(row);
      }
      touch();
      if (!this.returning) return { data: null, error: null, count: this.countMode ? done.length : null, status: 201, statusText: 'Created' };
      return this.finish(t, done, c, done.length);
    }
    if (this.mode === 'update') {
      const hit = table(t).filter((r) => canRead(t, r, c) && this.preds.every((p) => p(r)) && canWrite(t, r, c, 'update'));
      for (const r of hit) {
        const next = { ...r };
        for (const [k, v] of Object.entries(this.payload || {})) if (v !== undefined) next[k] = v;
        if (t === 'groups' || t === 'group_flags' || t === 'app_settings') next.updated_at = iso();
        beforeUpdate(t, r, next, c);
        checkRefs(t, next);
        checkUnique(t, next, r);
        Object.assign(r, next);
      }
      if (hit.length) touch();
      if (!this.returning) return { data: null, error: null, count: this.countMode ? hit.length : null, status: 204, statusText: 'No Content' };
      return this.finish(t, hit, c, hit.length);
    }
    // delete
    const hit = table(t).filter((r) => canRead(t, r, c) && this.preds.every((p) => p(r)) && canWrite(t, r, c, 'delete'));
    const snapshot = hit.map((r) => ({ ...r }));
    deleteRows(t, hit);
    if (hit.length) touch();
    if (!this.returning) return { data: null, error: null, count: this.countMode ? hit.length : null, status: 204, statusText: 'No Content' };
    return this.finish(t, snapshot, c, snapshot.length);
  }
}

function projectPlain(r: Row, sels: Sel[]) {
  const out: Row = {};
  for (const s of sels) {
    if (s.kind === 'star') Object.assign(out, r);
    else if (s.kind === 'col') out[s.as] = getCol(r, s.col) ?? null;
  }
  return out;
}
