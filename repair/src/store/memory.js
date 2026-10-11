// In-memory store: used by tests, and as a last resort when DATABASE_URL is missing
// (then nothing survives a restart – the admin screen warns about it).
function createMemoryStore() {
  let seq = { n: 0, t: 0, e: 0, a: 0 };
  const settings = new Map();
  const numbers = [];
  const tickets = [];
  const events = [];
  const approvals = [];
  const auth = new Map();
  const now = () => new Date();
  const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);

  return {
    kind: 'memory',
    close: async () => {},

    async getSetting(key, def = null) {
      return settings.has(key) ? clone(settings.get(key)) : def;
    },
    async setSetting(key, value) {
      settings.set(key, clone(value));
    },

    async listNumbers() {
      return clone(numbers);
    },
    async addNumber({ phone, name = '', role = 'requester' }) {
      let n = numbers.find((x) => x.phone === phone);
      if (n) Object.assign(n, { name, role, active: true });
      else numbers.push((n = { id: ++seq.n, phone, lid: null, name, role, active: true, created_at: now() }));
      return clone(n);
    },
    async updateNumber(id, patch) {
      const n = numbers.find((x) => x.id === Number(id));
      if (!n) return null;
      for (const k of ['name', 'role', 'active', 'lid']) if (k in patch) n[k] = patch[k];
      return clone(n);
    },
    async removeNumber(id) {
      const i = numbers.findIndex((x) => x.id === Number(id));
      if (i >= 0) numbers.splice(i, 1);
    },

    async createTicket(t) {
      const row = {
        id: ++seq.t,
        requester_phone: t.requester_phone,
        requester_name: t.requester_name || '',
        description: t.description,
        images: t.images || [],
        area: null,
        status: 'queued',
        branch: null,
        base_sha: null,
        pr_url: null,
        pr_number: null,
        summary: null,
        root_cause: null,
        risk: null,
        files: [],
        warnings: [],
        diff_stat: null,
        test_result: null,
        staging_result: null,
        deploy: null,
        error: null,
        cost_usd: null,
        start_after: new Date(Date.now() + (t.graceSec || 0) * 1000),
        created_at: now(),
        updated_at: now(),
      };
      tickets.push(row);
      return clone(row);
    },
    async getTicket(id) {
      return clone(tickets.find((x) => x.id === Number(id)) || null);
    },
    async listTickets(limit = 50, status) {
      return clone(
        tickets
          .filter((t) => !status || status.includes(t.status))
          .slice()
          .reverse()
          .slice(0, limit),
      );
    },
    async updateTicket(id, patch) {
      const t = tickets.find((x) => x.id === Number(id));
      if (!t) return null;
      Object.assign(t, clone(patch), { updated_at: now() });
      return clone(t);
    },
    async transitionTicket(id, from, patch) {
      const t = tickets.find((x) => x.id === Number(id));
      if (!t || !from.includes(t.status)) return null;
      Object.assign(t, clone(patch), { updated_at: now() });
      return clone(t);
    },
    async claimNextTicket() {
      const t = tickets.find((x) => x.status === 'queued' && new Date(x.start_after) <= now());
      if (!t) return null;
      t.status = 'investigating';
      t.updated_at = now();
      return clone(t);
    },
    async resetStuck() {
      const out = [];
      for (const t of tickets) {
        if (['investigating', 'testing', 'staging', 'deploying'].includes(t.status)) {
          out.push({ id: t.id, status: t.status });
          Object.assign(t, { status: 'failed', error: 'השרת הופעל מחדש באמצע הטיפול' });
        }
      }
      return out;
    },

    async addEvent(e) {
      const row = { id: ++seq.e, ticket_id: e.ticket_id || null, actor: e.actor, type: e.type, message: e.message, data: e.data || null, created_at: now() };
      events.push(row);
      return clone(row);
    },
    async listEvents({ ticketId, limit = 200 } = {}) {
      if (ticketId) return clone(events.filter((e) => e.ticket_id === Number(ticketId)).slice(0, limit));
      return clone(events.slice().reverse().slice(0, limit));
    },

    async createApproval(a) {
      const row = { id: ++seq.a, ticket_id: a.ticket_id, code_hash: a.code_hash, expires_at: new Date(a.expires_at), used_at: null, used_by: null, attempts: 0, created_at: now() };
      approvals.push(row);
      return clone(row);
    },
    async activeApproval(ticketId) {
      const list = approvals.filter((a) => a.ticket_id === Number(ticketId) && !a.used_at && new Date(a.expires_at) > now());
      return clone(list[list.length - 1] || null);
    },
    async consumeApproval(id, by) {
      const a = approvals.find((x) => x.id === id);
      if (!a || a.used_at || new Date(a.expires_at) <= now()) return null;
      Object.assign(a, { used_at: now(), used_by: by });
      return clone(a);
    },
    async updateApproval(id, patch) {
      const a = approvals.find((x) => x.id === id);
      if (a) Object.assign(a, patch);
      return clone(a);
    },

    async authGet(key) {
      return auth.has(key) ? auth.get(key) : null;
    },
    async authSet(key, value) {
      auth.set(key, value);
    },
    async authDel(key) {
      auth.delete(key);
    },
    async authAll() {
      return [...auth].map(([key, value]) => ({ key, value }));
    },
    async authSetMany(entries) {
      for (const [k, v] of entries) auth.set(k, v);
    },
    async authDelMany(keys) {
      for (const k of keys) auth.delete(k);
    },
    async authClear() {
      auth.clear();
    },
  };
}

module.exports = { createMemoryStore };
