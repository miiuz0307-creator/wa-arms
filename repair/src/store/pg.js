// Postgres store (Railway Postgres). Same interface as memory.js.
const fs = require('fs');
const path = require('path');
const pg = require('pg');

// ids are bigserial (int8); node-postgres returns those as strings by default
pg.types?.setTypeParser?.(20, (v) => Number(v));
const { Pool } = pg;

const TICKET_JSON = new Set(['images', 'files', 'warnings', 'test_result', 'staging_result', 'deploy']);

async function createPgStore(url) {
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0] || null;

  return {
    kind: 'postgres',
    close: () => pool.end(),

    async getSetting(key, def = null) {
      const r = await one('select value from settings where key=$1', [key]);
      return r ? r.value : def;
    },
    async setSetting(key, value) {
      await q(
        'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value, updated_at=now()',
        [key, JSON.stringify(value)],
      );
    },

    listNumbers: () => q('select * from allowed_numbers order by id'),
    async addNumber({ phone, name = '', role = 'requester' }) {
      return one(
        `insert into allowed_numbers(phone,name,role) values($1,$2,$3)
         on conflict(phone) do update set name=excluded.name, role=excluded.role, active=true returning *`,
        [phone, name, role],
      );
    },
    updateNumber: (id, patch) => {
      const keys = Object.keys(patch).filter((k) => ['name', 'role', 'active', 'lid'].includes(k));
      if (!keys.length) return one('select * from allowed_numbers where id=$1', [id]);
      const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
      return one(`update allowed_numbers set ${sets} where id=$1 returning *`, [id, ...keys.map((k) => patch[k])]);
    },
    removeNumber: (id) => q('delete from allowed_numbers where id=$1', [id]),

    createTicket: (t) =>
      one(
        `insert into tickets(requester_phone,requester_name,description,images,start_after)
         values($1,$2,$3,$4, now() + make_interval(secs => $5)) returning *`,
        [t.requester_phone, t.requester_name || '', t.description, JSON.stringify(t.images || []), t.graceSec || 0],
      ),
    getTicket: (id) => one('select * from tickets where id=$1', [id]),
    listTickets: (limit = 50, status) =>
      status
        ? q('select * from tickets where status = any($1) order by id desc limit $2', [status, limit])
        : q('select * from tickets order by id desc limit $1', [limit]),
    async updateTicket(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return this.getTicket(id);
      const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
      const vals = keys.map((k) => (TICKET_JSON.has(k) ? JSON.stringify(patch[k]) : patch[k]));
      return one(`update tickets set ${sets}, updated_at=now() where id=$1 returning *`, [id, ...vals]);
    },
    /** Change a ticket only if it is still in one of `from` (null when it moved on meanwhile). */
    async transitionTicket(id, from, patch) {
      const keys = Object.keys(patch);
      const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(',');
      const vals = keys.map((k) => (TICKET_JSON.has(k) ? JSON.stringify(patch[k]) : patch[k]));
      return one(`update tickets set ${sets}, updated_at=now() where id=$1 and status = any($2) returning *`, [id, from, ...vals]);
    },
    // atomically take the next ticket whose grace period passed
    claimNextTicket: () =>
      one(
        `update tickets set status='investigating', updated_at=now()
         where id = (select id from tickets where status='queued' and start_after <= now()
                     order by id limit 1 for update skip locked)
         returning *`,
      ),
    // tickets left mid-work by a restart
    async resetStuck() {
      return q(
        `update tickets set status='failed', error='השרת הופעל מחדש באמצע הטיפול', updated_at=now()
         where status in ('investigating','testing','staging','deploying') returning id, status`,
      );
    },

    addEvent: (e) =>
      one('insert into events(ticket_id,actor,type,message,data) values($1,$2,$3,$4,$5) returning *', [
        e.ticket_id || null,
        e.actor,
        e.type,
        e.message,
        e.data ? JSON.stringify(e.data) : null,
      ]),
    listEvents: ({ ticketId, limit = 200 } = {}) =>
      ticketId
        ? q('select * from events where ticket_id=$1 order by id limit $2', [ticketId, limit])
        : q('select * from events order by id desc limit $1', [limit]),

    createApproval: (a) =>
      one('insert into approvals(ticket_id,code_hash,expires_at) values($1,$2,$3) returning *', [
        a.ticket_id,
        a.code_hash,
        a.expires_at,
      ]),
    activeApproval: (ticketId) =>
      one(
        'select * from approvals where ticket_id=$1 and used_at is null and expires_at > now() order by id desc limit 1',
        [ticketId],
      ),
    // a code works exactly once, even if two approvals arrive at the same moment
    consumeApproval: (id, by) =>
      one('update approvals set used_at=now(), used_by=$2 where id=$1 and used_at is null and expires_at > now() returning *', [id, by]),
    updateApproval: (id, patch) => {
      const keys = Object.keys(patch);
      const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(',');
      return one(`update approvals set ${sets} where id=$1 returning *`, [id, ...keys.map((k) => patch[k])]);
    },

    async authGet(key) {
      const r = await one('select value from wa_auth where key=$1', [key]);
      return r ? r.value : null;
    },
    authSet: (key, value) =>
      q('insert into wa_auth(key,value) values($1,$2) on conflict(key) do update set value=excluded.value', [key, value]),
    authDel: (key) => q('delete from wa_auth where key=$1', [key]),
    authClear: () => q('delete from wa_auth'),
  };
}

module.exports = { createPgStore };
