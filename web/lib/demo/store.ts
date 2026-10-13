// The demo database: plain arrays of rows per table, kept in localStorage ('botix-demo-db').
import { iso } from './util';
import { seedDemo } from './seed';

export type Row = Record<string, any>;
export type DB = { v: number; seededAt: string; seedDay: string; seq: Record<string, number>; t: Record<string, Row[]> };

export const DB_KEY = 'botix-demo-db';
/** bump when the shape of the demo data changes: old saved demo data is thrown away and seeded again */
export const DB_VERSION = 4;

type Meta = {
  /** primary key columns */
  pk: string[];
  /** extra unique constraints (for upsert onConflict and duplicate errors) */
  unique?: string[][];
  /** id generator: uuid or bigint identity */
  id?: 'uuid' | 'int';
  /** row is isolated per station (RLS: station_id = my_station()) */
  station?: boolean;
  /** min rank to read / to write (RLS policies) */
  read?: number;
  write?: number;
  /** no policies for the app at all (only security definer functions) */
  closed?: boolean;
  /** station_id copied from a parent row (inherit_station trigger) */
  inherit?: [string, string];
  defaults?: Row;
};

export const META: Record<string, Meta> = {
  stations: { pk: ['id'], id: 'uuid', defaults: { is_home: false, status: 'active', plan: 'basic', logo_data: null } },
  profiles: { pk: ['id'], id: 'uuid', defaults: { role: 'viewer', is_active: true, is_primary: false, title: null } },
  arms: {
    pk: ['id'], id: 'uuid', station: true, read: 1, write: 3,
    defaults: { status: 'pending', daily_limit: 500, sent_today: 0, sent_total: 0, is_active: true, phone: null, last_error: null, last_seen_at: null, last_connected_at: null, linked_at: null, sent_day: null },
  },
  arm_qr: { pk: ['arm_id'], station: true, read: 3, write: 3, inherit: ['arms', 'arm_id'] },
  arm_commands: { pk: ['id'], id: 'int', station: true, read: 3, write: 3, inherit: ['arms', 'arm_id'], defaults: { status: 'pending', error: null, processed_at: null } },
  groups: { pk: ['id'], id: 'uuid', unique: [['arm_id', 'wa_group_id']], station: true, read: 1, write: 3, inherit: ['arms', 'arm_id'] },
  distribution_lists: { pk: ['id'], id: 'uuid', station: true, read: 1, write: 2, defaults: { description: null } },
  list_groups: { pk: ['list_id', 'wa_group_id'], station: true, read: 1, write: 2, inherit: ['distribution_lists', 'list_id'], defaults: { group_name: null } },
  list_arms: { pk: ['list_id', 'arm_id'], station: true, read: 1, write: 2, inherit: ['distribution_lists', 'list_id'] },
  group_flags: { pk: ['station_id', 'wa_group_id'], station: true, read: 1, write: 2, defaults: { include_anyway: false, disabled: false, note: null } },
  source_groups: { pk: ['id'], id: 'uuid', unique: [['station_id', 'wa_group_id']], station: true, read: 1, write: 3, defaults: { is_active: true, listen_arm_id: null } },
  templates: { pk: ['id'], id: 'uuid', station: true, read: 1, write: 3, defaults: { prefix: '', suffix: '' } },
  triggers: {
    pk: ['id'], id: 'uuid', unique: [['station_id', 'keyword']], station: true, read: 1, write: 3,
    defaults: { action: 'distribute', strip_keyword: true, is_active: true, list_id: null, template_id: null },
  },
  dispatchers: { pk: ['id'], id: 'uuid', station: true, read: 1, write: 2, defaults: { auto_detected: false, wa_jid: null, wa_lid: null } },
  wa_operators: { pk: ['id'], id: 'uuid', station: true, read: 3, write: 3, defaults: { status: 'pending' } },
  campaigns: {
    pk: ['id'], id: 'uuid', station: true, read: 1, write: 2,
    defaults: { status: 'queued', total: 0, sent: 0, failed: 0, reacted: false, final_text: null, list_id: null, started_at: null, finished_at: null },
  },
  campaign_arms: { pk: ['campaign_id', 'arm_id'], station: true, read: 1, write: 2, inherit: ['campaigns', 'campaign_id'] },
  campaign_targets: {
    pk: ['id'], id: 'int', unique: [['campaign_id', 'wa_group_id']], station: true, read: 1, write: 2, inherit: ['campaigns', 'campaign_id'],
    defaults: { status: 'pending', attempts: 0, error: null, sent_at: null, claimed_at: null, arm_id: null, tried_arms: [] },
  },
  app_settings: { pk: ['id'], id: 'int', unique: [['station_id']], station: true, read: 1, write: 3 },
  activity_log: { pk: ['id'], id: 'int', station: true, read: 3, write: 99 },
  quote_sessions: { pk: ['id'], id: 'uuid', station: true, read: 1, write: 99 },
  processed_messages: { pk: ['station_id', 'source_group_id', 'message_id'], station: true, read: 1, write: 99 },
  // tables with RLS on and no policy: only reachable through functions
  station_sessions: { pk: ['token_hash'], closed: true },
  station_payments: { pk: ['id'], id: 'int', closed: true },
  payment_requests: { pk: ['id'], id: 'int', closed: true, defaults: { status: 'pending', reject_reason: null, decided_by: null, decided_at: null, payment_id: null, note: null } },
  support_tickets: { pk: ['id'], id: 'int', closed: true, defaults: { status: 'open' } },
  support_messages: { pk: ['id'], id: 'int', closed: true },
  system_messages: { pk: ['id'], id: 'int', closed: true, defaults: { level: 'info' } },
  arm_requests: { pk: ['id'], id: 'int', closed: true, defaults: { status: 'pending' } },
  owner_settings: { pk: ['id'], closed: true },
  mail_settings: { pk: ['id'], closed: true },
  releases: { pk: ['id'], id: 'int', closed: true },
  release_live: { pk: ['component'], closed: true },
  wa_outbox: { pk: ['id'], id: 'int', closed: true, defaults: { status: 'pending', error: null, arm_id: null, sent_at: null } },
  login_otps: { pk: ['id'], id: 'int', closed: true },
  sub_alerts: { pk: ['station_id', 'sub_end', 'kind'], closed: true },
  engine_status: { pk: ['id'], closed: true },
  message_footers: { pk: ['station_id'], closed: true, defaults: { footer_text: '', enabled: true } },
};

/** foreign keys [child table, column, parent table] – used for embedded selects and cascades */
export const FKS: [string, string, string, 'cascade' | 'null'][] = [
  ['groups', 'arm_id', 'arms', 'cascade'],
  ['arm_qr', 'arm_id', 'arms', 'cascade'],
  ['arm_commands', 'arm_id', 'arms', 'cascade'],
  ['list_arms', 'arm_id', 'arms', 'cascade'],
  ['campaign_arms', 'arm_id', 'arms', 'cascade'],
  ['source_groups', 'listen_arm_id', 'arms', 'null'],
  ['campaign_targets', 'arm_id', 'arms', 'null'],
  ['campaigns', 'trigger_arm_id', 'arms', 'null'],
  ['support_tickets', 'arm_id', 'arms', 'null'],
  ['list_groups', 'list_id', 'distribution_lists', 'cascade'],
  ['list_arms', 'list_id', 'distribution_lists', 'cascade'],
  ['triggers', 'list_id', 'distribution_lists', 'null'],
  ['campaigns', 'list_id', 'distribution_lists', 'null'],
  ['triggers', 'template_id', 'templates', 'null'],
  ['campaigns', 'trigger_id', 'triggers', 'null'],
  ['campaign_targets', 'campaign_id', 'campaigns', 'cascade'],
  ['campaign_arms', 'campaign_id', 'campaigns', 'cascade'],
  ['support_messages', 'ticket_id', 'support_tickets', 'cascade'],
  ['payment_requests', 'payment_id', 'station_payments', 'null'],
];
// every station-owned table belongs to stations (on delete cascade)
for (const [t, m] of Object.entries(META)) if (m.station) FKS.push([t, 'station_id', 'stations', 'cascade']);
for (const t of ['station_sessions', 'station_payments', 'payment_requests', 'support_tickets', 'system_messages', 'arm_requests', 'login_otps', 'sub_alerts', 'message_footers'])
  FKS.push([t, 'station_id', 'stations', 'cascade']);

// ---------------------------------------------------------------------------------------------
let db: DB | null = null;
const listeners = new Set<() => void>();
let saveTimer: any = null;
let memoryOnly = false;

function ls(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** columnar form: { cols, rows: [[...]] } – about half the size of plain JSON rows */
function pack(d: DB) {
  const t: Record<string, { c: string[]; r: any[][] }> = {};
  for (const [name, rows] of Object.entries(d.t)) {
    const cols: string[] = [];
    const idx = new Map<string, number>();
    for (const r of rows) for (const k of Object.keys(r)) if (!idx.has(k)) (idx.set(k, cols.length), cols.push(k));
    t[name] = { c: cols, r: rows.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c]))) };
  }
  return JSON.stringify({ v: d.v, seededAt: d.seededAt, seedDay: d.seedDay, seq: d.seq, t });
}
function unpack(s: string): DB | null {
  const o = JSON.parse(s);
  if (!o || o.v !== DB_VERSION) return null;
  const t: Record<string, Row[]> = {};
  for (const [name, { c, r }] of Object.entries<any>(o.t)) {
    t[name] = r.map((vals: any[]) => {
      const row: Row = {};
      c.forEach((k: string, i: number) => (row[k] = vals[i]));
      return row;
    });
  }
  return { v: o.v, seededAt: o.seededAt, seedDay: o.seedDay, seq: o.seq || {}, t };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function getDB(): DB {
  if (db) return db;
  let loaded: DB | null = null;
  try {
    const s = ls()?.getItem(DB_KEY);
    if (s) loaded = unpack(s);
  } catch {
    loaded = null;
  }
  // a new day: seed again, so "today's rides" and subscription dates stay meaningful
  if (loaded && loaded.seedDay !== today()) loaded = null;
  if (!loaded) {
    loaded = { v: DB_VERSION, seededAt: iso(), seedDay: today(), seq: {}, t: {} };
    db = loaded;
    seedDemo(loaded);
    saveNow();
  }
  db = loaded;
  for (const k of Object.keys(META)) db.t[k] ||= [];
  return db;
}

export function table(name: string): Row[] {
  const d = getDB();
  return (d.t[name] ||= []);
}
export function setTable(name: string, rows: Row[]) {
  getDB().t[name] = rows;
}
export function nextId(name: string): number {
  const d = getDB();
  if (!d.seq[name]) d.seq[name] = table(name).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  return ++d.seq[name];
}

export function saveNow() {
  if (!db || memoryOnly) return;
  const s = ls();
  if (!s) return;
  try {
    s.setItem(DB_KEY, pack(db));
  } catch {
    // quota: keep working from memory
    memoryOnly = true;
  }
}
/** every change: tell open demo widgets, save a moment later */
export function touch() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 800);
  listeners.forEach((f) => {
    try {
      f();
    } catch {}
  });
}
export function onChange(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

export function resetDemoDB() {
  try {
    ls()?.removeItem(DB_KEY);
  } catch {}
  db = null;
  memoryOnly = false;
  getDB();
  touch();
}

export const demoDBSize = () => {
  try {
    return db ? pack(db).length : 0;
  } catch {
    return 0;
  }
};
