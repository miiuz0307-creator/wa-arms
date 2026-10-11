// Test stand-in for supabase-js. Every query is answered by global.__db(op), where op =
// { table|rpc, action, filters, payload, ... }. Default answer: { data: [], error: null }.
function builder(base) {
  const op = { ...base, filters: [], mods: [] };
  const run = () => Promise.resolve().then(() => (global.__db ? global.__db(op) : null) || { data: [], error: null });
  const b = {
    select(cols) { if (!op.action) op.action = 'select'; op.cols = cols; return b; },
    insert(p) { op.action = 'insert'; op.payload = p; return b; },
    upsert(p, o) { op.action = 'upsert'; op.payload = p; op.opts = o; return b; },
    update(p) { op.action = 'update'; op.payload = p; return b; },
    delete() { op.action = 'delete'; return b; },
    single() { op.single = true; return b; },
    maybeSingle() { op.maybeSingle = true; return b; },
    then(res, rej) { return run().then(res, rej); },
  };
  for (const f of ['eq', 'neq', 'in', 'gt', 'lt', 'gte', 'lte', 'is', 'not', 'or', 'filter', 'like', 'ilike', 'contains'])
    b[f] = (...a) => (op.filters.push([f, ...a]), b);
  for (const f of ['order', 'limit', 'range']) b[f] = (...a) => (op.mods.push([f, ...a]), b);
  return b;
}
exports.createClient = () => ({
  from: (table) => builder({ table }),
  rpc: (fn, args) => builder({ rpc: fn, args, action: 'rpc' }),
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
});
