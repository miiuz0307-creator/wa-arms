// Checks made before the bot handles a ride for a station (BotiX v2):
//  - stationActive: a station whose subscription ended / that is suspended is not handled (its arms stay connected)
//  - dropDisabled:  groups the station switched off ("disabled" in group status) never get rides
//  - unreachableGroups: groups that no arm of the ride can send to (inserted as 'skipped', not sent, not "failed")
// Every check fails OPEN: a database hiccup or a missing function (DB change not applied yet) never stops a ride.
const { db, log } = require('./config');
const { fetchAll } = require('./util');

const ACTIVE_TTL_MS = 60_000;
const FLAGS_TTL_MS = 30_000;
const ERROR_TTL_MS = 10_000; // after an error, ask again in 10s (meanwhile: fail-open)
const RPC_LIMIT_MS = 3_000; // a ride never waits more than this for a check

const UNREACHABLE_TEXT = 'הקבוצה לא זמינה כרגע: אין זרוע מחוברת של הרשימה בקבוצה';

function withLimit(promise) {
  let t;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error('timeout')), RPC_LIMIT_MS);
      t.unref?.();
    }),
  ]).finally(() => clearTimeout(t));
}

// one warning per key per hour (no log flood while the database is down or the station is inactive)
const warnedAt = new Map();
function onceAnHour(key) {
  const last = warnedAt.get(key) || 0;
  if (Date.now() - last < 60 * 60_000) return false;
  warnedAt.set(key, Date.now());
  return true;
}

// ---------- subscription / suspension ----------
const activeCache = new Map(); // station -> { at, ttl, value, pending }

async function stationActive(stationId) {
  if (!stationId) return true;
  const c = activeCache.get(stationId);
  if (c?.pending) return c.pending;
  if (c && Date.now() - c.at < c.ttl) return c.value;
  const pending = withLimit(db.rpc('engine_station_active', { p_station: stationId }))
    .then(({ data, error }) => {
      if (error) throw error;
      const value = data !== false; // only an explicit "false" stops the station
      activeCache.set(stationId, { at: Date.now(), ttl: ACTIVE_TTL_MS, value });
      return value;
    })
    .catch((e) => {
      if (onceAnHour(`active-err|${stationId}`)) log.warn({ station: stationId, err: String(e?.message || e).slice(0, 120) }, 'station check failed – handled as active');
      activeCache.set(stationId, { at: Date.now(), ttl: ERROR_TTL_MS, value: true });
      return true;
    });
  activeCache.set(stationId, { ...(c || {}), pending });
  return pending;
}

// true = the message may be handled; false = the station is inactive (logged once per station per hour)
async function stationAllowed(arm, what) {
  if (await stationActive(arm.stationId)) return true;
  if (onceAnHour(`inactive|${arm.stationId}`)) {
    log.info({ station: arm.stationId, arm: arm.name, what }, 'station inactive (subscription ended / suspended) – ride ignored, arms stay connected');
  }
  return false;
}

// ---------- group status ----------
const flagsCache = new Map(); // station -> { at, ttl, map, pending }

// station -> Map(wa_group_id -> { include_anyway, disabled }); on error the last known flags (or none)
async function groupFlags(stationId) {
  if (!stationId) return new Map();
  const c = flagsCache.get(stationId);
  if (c?.pending) return c.pending;
  if (c?.map && Date.now() - c.at < c.ttl) return c.map;
  // rows: one per flagged group of one station (the RPC returns all of them)
  const pending = withLimit(db.rpc('engine_group_flags', { p_station: stationId }))
    .then(({ data, error }) => {
      if (error) throw error;
      const map = new Map((Array.isArray(data) ? data : []).map((r) => [r.wa_group_id, { include_anyway: !!r.include_anyway, disabled: !!r.disabled }]));
      flagsCache.set(stationId, { at: Date.now(), ttl: FLAGS_TTL_MS, map });
      return map;
    })
    .catch((e) => {
      if (onceAnHour(`flags-err|${stationId}`)) log.warn({ station: stationId, err: String(e?.message || e).slice(0, 120) }, 'group status check failed – no group removed');
      const map = c?.map || new Map();
      flagsCache.set(stationId, { at: Date.now(), ttl: ERROR_TTL_MS, map });
      return map;
    });
  flagsCache.set(stationId, { ...(c || {}), pending });
  return pending;
}

// the groups without those the station switched off
async function dropDisabled(stationId, groups) {
  if (!groups?.length) return groups || [];
  const flags = await groupFlags(stationId);
  if (!flags.size) return groups;
  return groups.filter((g) => !flags.get(g.wa_group_id)?.disabled);
}

// ---------- groups no arm of the ride can reach ----------
// Same rule the database uses to close such groups as failed 'אין זרוע פנויה' (finalize_campaigns), decided
// once per ride when the groups are added instead of 10 seconds later, so nobody tries to send there and they
// are not counted as failures. It only ever judges LESS strictly than the database (doubt → the group stays
// pending exactly as before): a group with at least one possible arm is never touched.
const DEAD_STATUSES = new Set(['error', 'qr', 'paused']); // blocked by WhatsApp / waiting for a QR scan / paused

function dateIn(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return null;
  }
}

function armCanSend(a) {
  if (!a.is_active) return false;
  if (DEAD_STATUSES.has(a.status)) return false;
  // reached the daily limit today – counted only when "today" is the same date in UTC and in Israel
  // (the database's current_date), so around midnight the arm is still counted
  const today = dateIn('UTC');
  const atLimit =
    a.daily_limit != null && a.sent_today != null && Number(a.sent_today) >= Number(a.daily_limit) &&
    a.sent_day && String(a.sent_day).slice(0, 10) === today && today === dateIn('Asia/Jerusalem');
  return !atLimit;
}

/**
 * Of `groupIds`, the groups that none of the ride's arms (`armIds` = campaign arms) can send to:
 * every arm is switched off / blocked / waiting for QR / paused / at its daily limit, or is not in the group.
 * `keep` = groups never judged (e.g. "include anyway"). Any doubt (error, empty answer) → empty set.
 */
async function unreachableGroups(armIds, groupIds, keep = new Set()) {
  const none = new Set();
  try {
    if (!armIds?.length || !groupIds?.length) return none;
    const { data: armRows, error } = await db
      .from('arms')
      .select('id,is_active,status,sent_day,sent_today,daily_limit')
      .in('id', armIds);
    if (error || !Array.isArray(armRows) || !armRows.length) return none;
    const known = new Map(armRows.map((a) => [a.id, a]));
    // an arm missing from the answer is not ruled out (doubt → it counts)
    const usable = armIds.filter((id) => !known.has(id) || armCanSend(known.get(id)));
    let reachable = new Set();
    if (usable.length) {
      const { data: rows, error: gErr } = await fetchAll(() => db.from('groups').select('arm_id,wa_group_id').in('arm_id', usable).order('arm_id').order('wa_group_id'));
      if (gErr || !Array.isArray(rows) || !rows.length) return none; // no answer / no groups at all: leave it to the database
      reachable = new Set(rows.map((r) => r.wa_group_id));
    }
    return new Set(groupIds.filter((g) => !reachable.has(g) && !keep.has(g)));
  } catch (e) {
    log.warn({ err: String(e?.message || e).slice(0, 120) }, 'reachability check failed – every group stays pending');
    return none;
  }
}

/**
 * Rows for campaign_targets: groups no arm can reach are added as 'skipped' (not sent, not a failure),
 * all others exactly as before.
 */
function targetRows(campaignId, groups, unreachable, exclude = () => []) {
  return groups.map((g) => ({
    campaign_id: campaignId,
    wa_group_id: g.wa_group_id,
    group_name: g.group_name,
    tried_arms: exclude(g.wa_group_id),
    ...(unreachable?.has(g.wa_group_id) ? { status: 'skipped', error: UNREACHABLE_TEXT } : {}),
  }));
}

// groups marked "include anyway" are never judged unreachable by the engine
async function includeAnyway(stationId) {
  const flags = await groupFlags(stationId);
  return new Set([...flags].filter(([, f]) => f.include_anyway).map(([g]) => g));
}

// ---------- message footer (the owner's line under every message of a station) ----------
const FOOTER_TTL_MS = 30_000;
const footerCache = new Map(); // station -> { at, ttl, value, pending }

// the footer text for a station, or '' (none / switched off / DB without the function / error → last known)
async function stationFooter(stationId) {
  if (!stationId) return '';
  const c = footerCache.get(stationId);
  if (c?.pending) return c.pending;
  if (c && Date.now() - c.at < c.ttl) return c.value;
  const pending = withLimit(db.rpc('engine_station_footer', { p_station: stationId }))
    .then(({ data, error }) => {
      if (error) throw error;
      const value = typeof data === 'string' ? data.trim() : '';
      footerCache.set(stationId, { at: Date.now(), ttl: FOOTER_TTL_MS, value });
      return value;
    })
    .catch((e) => {
      if (onceAnHour(`footer-err|${stationId}`)) log.warn({ station: stationId, err: String(e?.message || e).slice(0, 120) }, 'footer check failed – last known footer used');
      const value = c?.value || '';
      footerCache.set(stationId, { at: Date.now(), ttl: ERROR_TTL_MS, value });
      return value;
    });
  footerCache.set(stationId, { ...(c || {}), pending });
  return pending;
}

// the message with the footer under it (once: a text that already ends with it is left as is)
function withFooter(text, footer) {
  const t = String(text ?? '');
  const f = String(footer || '').trim();
  if (!f || t.trimEnd().endsWith(f)) return t;
  return `${t.trimEnd()}\n\n${f}`;
}

function _reset() {
  footerCache.clear();
  activeCache.clear();
  flagsCache.clear();
  warnedAt.clear();
}

module.exports = {
  stationActive,
  stationAllowed,
  groupFlags,
  dropDisabled,
  includeAnyway,
  unreachableGroups,
  targetRows,
  armCanSend,
  UNREACHABLE_TEXT,
  stationFooter,
  withFooter,
  _reset,
};
