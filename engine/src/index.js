// Arms engine – runs 24/7 on the server, independent of the admin UI.
const { db, log } = require('./config');
const { Arm } = require('./arm');
const help = require('./help');
const quote = require('./quote');
const backup = require('./backup');
const { randomBetween, sleep } = require('./util');

const arms = new Map(); // arm id -> Arm
quote.setArmsSource(() => arms);
Arm.setRelevance(help.relevance);
// settings per station (station_id -> app_settings row)
const settingsByStation = new Map();
const settingsFor = (arm) => settingsByStation.get(arm.stationId) || { min_delay_sec: 8, max_delay_sec: 20 };
let shuttingDown = false;

// Keep running arms in line with the arms table
async function reconcileArms() {
  const [{ data, error }, st] = await Promise.all([
    db.from('arms').select('id,name,is_active,status,station_id,linked_at'),
    db.rpc('engine_station_states'),
  ]);
  if (error) throw new Error('load arms failed: ' + error.message);
  if (st.error) throw new Error('load station states failed: ' + st.error.message);
  // stations that are suspended or whose subscription ended: their arms stop
  const blocked = new Set((st.data || []).filter((s) => !s.allowed).map((s) => s.id));
  const ids = new Set(data.map((a) => a.id));

  for (const row of data) {
    let arm = arms.get(row.id);
    if (arm) {
      arm.name = row.name;
      arm.stationId = row.station_id;
      arm.linkedAt = row.linked_at ? new Date(row.linked_at).getTime() : 0;
    }
    const shouldRun = row.is_active && !blocked.has(row.station_id);
    if (row.is_active && blocked.has(row.station_id) && !arm && row.status !== 'paused') {
      await db.from('arms').update({ status: 'paused', last_error: 'התחנה מושעית או שהמנוי הסתיים' }).eq('id', row.id);
    }
    if (shouldRun && !arm) {
      arm = new Arm(row, help.onMessage);
      arms.set(row.id, arm);
      arm.start();
    } else if (!shouldRun && arm) {
      arms.delete(row.id);
      await arm.stop();
      await db.from('arm_qr').delete().eq('arm_id', row.id);
      await db.from('arms').update({
        status: 'paused',
        ...(row.is_active ? { last_error: 'התחנה מושעית או שהמנוי הסתיים' } : {}),
      }).eq('id', row.id);
      log.info({ arm: row.name }, 'arm paused');
    }
  }
  // An arm missing from the list is logged out of WhatsApp only when it was really deleted:
  // an empty/partial answer from the database (overload, permissions hiccup) must never
  // log out every number. Require: the list is not empty, the arm is missing on two checks
  // at least 30s apart, and a direct lookup by id confirms the row is gone.
  if (!data.length && arms.size) {
    log.warn({ running: arms.size }, 'arms list came back empty – ignoring (no arm is removed)');
    return;
  }
  for (const [id, arm] of arms) {
    if (ids.has(id)) {
      missingSince.delete(id);
      continue;
    }
    const since = missingSince.get(id);
    if (!since) {
      missingSince.set(id, Date.now());
      continue;
    }
    if (Date.now() - since < 30_000) continue;
    const { data: row, error: e2 } = await db.from('arms').select('id').eq('id', id).maybeSingle();
    if (e2 || row) {
      missingSince.delete(id);
      continue;
    }
    missingSince.delete(id);
    arms.delete(id);
    await arm.destroy();
    log.info({ arm: arm.name }, 'arm removed (deleted in the app)');
  }
}
const missingSince = new Map();

async function processCommands() {
  const { data, error } = await db
    .from('arm_commands')
    .select('*')
    .eq('status', 'pending')
    .order('created_at')
    .limit(20);
  if (error || !data?.length) return;

  for (const cmd of data) {
    let status = 'done';
    let errText = null;
    try {
      let arm = arms.get(cmd.arm_id);
      if (!arm && (cmd.command === 'reset' || cmd.command === 'connect')) {
        // re-activate a paused arm
        await db.from('arms').update({ is_active: true }).eq('id', cmd.arm_id);
        await reconcileArms();
        arm = arms.get(cmd.arm_id);
      }
      if (!arm) throw new Error('הזרוע לא פעילה');
      if (cmd.command === 'reset') await arm.reset();
      else if (cmd.command === 'connect') await arm.start();
      else if (cmd.command === 'refresh_groups') await arm.syncGroups();
      else if (cmd.command === 'disconnect') {
        await db.from('arms').update({ is_active: false }).eq('id', cmd.arm_id);
        await reconcileArms();
      }
    } catch (e) {
      status = 'failed';
      errText = e.message;
    }
    await db
      .from('arm_commands')
      .update({ status, error: errText, processed_at: new Date().toISOString() })
      .eq('id', cmd.id);
  }
}

async function refreshSettings() {
  const { data, error } = await db.from('app_settings').select('*');
  if (error || !data) return;
  settingsByStation.clear();
  for (const r of data) settingsByStation.set(r.station_id, r);
}

const MAX_IN_FLIGHT = 4; // parallel sends per arm (fewer = incoming messages like 'עזרה'/'נ' aren't stuck behind sends) in "messages per minute" mode
const MAX_REQUEUES = 8;
const WARMUP_MS = 24 * 60 * 60_000;
const WARMUP_RATE = 6; // messages per minute during a new number's first day // a group refused by WhatsApp goes back to the queue up to this many times

// "not-acceptable" = the arm has no permission to write in that group – no point retrying
const NO_PERMISSION = /not-acceptable|forbidden|not-authorized/i;
// WhatsApp refusals that mean "too fast / try later"
const THROTTLED = /rate-overlimit/i;
const NO_PERMISSION_TEXT = 'אין הרשאה לשלוח בקבוצה';
// short network/encryption hiccups – retry right away a couple of times
const HICCUP = /timed out|timeout|no sessions|connection closed|internal-server-error|ECONN|socket/i;

function adminOnlyBlocked(arm, jid) {
  const meta = arm.groupMeta?.get(jid);
  if (!meta?.announce) return false; // "only admins can send" is off
  const mine = new Set(arm.ownJids());
  const me = (meta.participants || []).find((p) => mine.has(String(p.id).replace(/:\d+(?=@)/, '')));
  return !(me && (me.admin === 'admin' || me.admin === 'superadmin'));
}

// Adaptive speed per arm: every refusal doubles the pause, every 5 successes in a row ease it back
// The owner chose the speed and accepts the risk: a refusal does NOT slow the arm down,
// the group just goes back to the queue and is retried at the configured speed.
function slowDown(arm) {
  arm.penalty = 1;
  log.warn({ arm: arm.name }, 'WhatsApp refused – group requeued, speed unchanged');
}
function speedUp(arm) {
  arm.okStreak = (arm.okStreak || 0) + 1;
  if ((arm.penalty || 1) > 1 && arm.okStreak >= 5) {
    arm.penalty = Math.max(1, arm.penalty / 2);
    arm.okStreak = 0;
  }
}

// WhatsApp-style message id (3EB0 + hex), the same for every retry of one target on one arm
function msgIdFor(targetId, armId) {
  return '3EB0' + require('crypto').createHash('sha1').update(`${targetId}|${armId}`).digest('hex').slice(0, 18).toUpperCase();
}

async function withRetry(fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    // supabase queries are 'thenable' but not real promises (no .catch) – wrap them
    const res = await Promise.resolve().then(fn).catch((e) => ({ error: e }));
    if (!res?.error) return res;
    last = res.error;
    await sleep(Math.min(8000, 500 * 2 ** i));
  }
  log.error({ err: String(last?.message || last).slice(0, 120) }, 'database write failed after retries');
  return { error: last };
}

const recordResult = (id, armId, ok, err) =>
  withRetry(() => db.rpc('target_result_engine', { p_id: id, p_arm: armId, p_ok: ok, p_error: err }));

async function sendOne(arm) {
  const { data, error } = await db.rpc('claim_target_engine', { p_arm: arm.id });
  if (error) throw error;
  const job = data?.[0];
  if (!job) return false;

  // groups where only admins may write: skip up front instead of failing
  if (adminOnlyBlocked(arm, job.wa_group_id)) {
    await db
      .from('campaign_targets')
      .update({ status: 'skipped', error: `${NO_PERMISSION_TEXT} (רק מנהלים)` })
      .eq('id', job.target_id);
    return true;
  }

  let ok = false;
  let errText = null;
  let uncertain = false;
  const messageId = msgIdFor(job.target_id, arm.id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await arm.send(job.wa_group_id, job.final_text, messageId);
      ok = true;
      break;
    } catch (e) {
      errText = e?.message || 'שגיאת שליחה';
      if (e?.uncertain) {
        uncertain = true;
        break;
      }
      if (!HICCUP.test(errText) || attempt === 3) break;
      await sleep(1000 * attempt);
    }
  }

  if (ok) {
    speedUp(arm);
    // the message is out: recording it must not be lost to a database hiccup, otherwise the
    // group would look unsent and could get the ride again
    await recordResult(job.target_id, arm.id, true, null);
    return true;
  }

  // no confirmation from WhatsApp: it may have been delivered – close it, never re-send
  if (uncertain) {
    await withRetry(() => db.from('campaign_targets').update({ status: 'failed', error: `${errText}. לא נשלחה שוב כדי למנוע כפילות` }).eq('id', job.target_id));
    log.warn({ arm: arm.name, group: job.wa_group_id }, 'send unconfirmed – not retried');
    return true;
  }

  // "not-acceptable" in a group this arm already sent to = WhatsApp refusing because it is too fast
  let noPermission = NO_PERMISSION.test(errText);
  if (noPermission) {
    const { data: okBefore } = await db
      .from('campaign_targets')
      .select('id')
      .eq('wa_group_id', job.wa_group_id)
      .eq('arm_id', arm.id)
      .eq('status', 'sent')
      .limit(1);
    if (okBefore?.length) {
      noPermission = false;
      errText = `${errText} – WhatsApp דחה (מהר מדי)`;
      slowDown(arm);
    }
  }

  // no permission in this group → mark it (shown on the website after the distribution, with an option to remove it)
  if (noPermission) {
    await db
      .from('campaign_targets')
      .update({ status: 'skipped', error: `${NO_PERMISSION_TEXT} (${errText})` })
      .eq('id', job.target_id);
    log.warn({ arm: arm.name, group: job.wa_group_id }, 'no permission in group');
    return true;
  }

  // refused for now → slow down and put the group back in the queue instead of failing it
  if (THROTTLED.test(errText) || HICCUP.test(errText) || NO_PERMISSION.test(errText)) {
    if (THROTTLED.test(errText)) slowDown(arm);
    const { data: row } = await db.from('campaign_targets').select('attempts').eq('id', job.target_id).single();
    if ((row?.attempts || 0) < MAX_REQUEUES) {
      await db
        .from('campaign_targets')
        .update({ status: 'pending', error: `${errText} – ממתין לניסיון נוסף`, claimed_at: null })
        .eq('id', job.target_id);
      return true;
    }
  }

  await recordResult(job.target_id, arm.id, false, errText);
  log.warn({ arm: arm.name, group: job.wa_group_id, err: errText }, 'send failed');
  return true;
}

// One light "is anything waiting?" check per second for all arms, instead of every idle arm
// asking the database for a group to send every second.
let hasWork = true;
let lastWorkCheck = 0;
async function checkWork() {
  if (Date.now() - lastWorkCheck < 1000) return;
  lastWorkCheck = Date.now();
  const { data, error } = await db.from('campaigns').select('id').in('status', ['queued', 'running']).limit(1);
  if (!error) hasWork = !!data?.length;
  else {
    hasWork = false; // database unreachable: nothing can be sent anyway – look again in 10s
    lastWorkCheck = Date.now() + 9000;
  }
}

async function sendTick(arm) {
  if (!hasWork || !arm.online || Date.now() < arm.nextSendAt) return;
  const settings = settingsFor(arm);
  // Warm-up: a number linked less than 24 hours ago sends slowly (at most WARMUP_RATE a minute, one at a time).
  // Every first message to a group hands our new encryption key to every member; done fast across hundreds
  // of groups WhatsApp refuses (rate-overlimit) and members see "waiting for this message".
  const warming = arm.linkedAt && Date.now() - arm.linkedAt < WARMUP_MS;
  let rate = Number(settings.rate_per_minute) || 0;
  if (warming) rate = Math.min(rate || WARMUP_RATE, WARMUP_RATE);
  const penalty = arm.penalty || 1;

  if (rate > 0) {
    // "N messages per minute": start a send every 60/N seconds (±15%), several may run at once.
    // After a refusal (penalty > 1) the arm sends one at a time, more slowly.
    arm.inFlight = arm.inFlight || 0;
    const maxInFlight = penalty > 1 || warming ? 1 : MAX_IN_FLIGHT;
    if (arm.inFlight >= maxInFlight || arm.claiming) return;
    const interval = (60_000 / rate) * penalty;
    arm.claiming = true;
    arm.nextSendAt = Date.now() + interval * (0.85 + Math.random() * 0.3);
    arm.inFlight += 1;
    sendOne(arm)
      .then((had) => {
        if (!had) arm.nextSendAt = Date.now() + 1000; // nothing to send – check again in a second
      })
      .catch((e) => {
        log.error({ arm: arm.name, err: e.message }, 'send tick failed');
        arm.nextSendAt = Date.now() + 5000;
      })
      .finally(() => {
        arm.inFlight -= 1;
      });
    setTimeout(() => {
      arm.claiming = false;
    }, 50);
    return;
  }

  // seconds mode: one send at a time with a random pause between sends
  if (arm.busy) return;
  arm.busy = true;
  try {
    await sendOne(arm);
    const min = Math.max(0, Number(settings.min_delay_sec) || 0) * 1000;
    const max = Math.max(min, (Number(settings.max_delay_sec) || 0) * 1000);
    arm.nextSendAt = Math.max(arm.nextSendAt || 0, Date.now() + randomBetween(min, max) * (arm.penalty || 1));
  } catch (e) {
    log.error({ arm: arm.name, err: e.message }, 'send tick failed');
    arm.nextSendAt = Date.now() + 5000;
  } finally {
    arm.busy = false;
  }
}

// Per arm, per minute: members who could not decrypt our messages, repairs, re-sends, losses.
async function saveDelivery() {
  const rows = [];
  for (const a of arms.values()) {
    const d = a.takeDelivery?.();
    if (!d) continue;
    const lost = (d.resendExpired || 0) + (d.resendGaveUp || 0) + (d.resendDropped || 0);
    const row = {
      arm_id: a.id,
      sent: d.sent || 0,
      retry_receipts: d.retryReceipts || 0,
      failing_devices: d.failingDevices || 0,
      resent: d.resent || 0,
      resend_failed: d.resendFailed || 0,
      resend_lost: lost,
      sessions_learned: d.sessionsLearned || 0,
      undecrypted_in: d.undecryptedIn || 0,
      detail: d,
    };
    rows.push(row);
    if (row.retry_receipts || row.undecrypted_in) log.info({ arm: a.name, ...row, detail: undefined, queue: a.resendQueue?.length || 0 }, 'delivery (last minute)');
  }
  if (!rows.length) return;
  // monitoring must never slow the other loops (they share the database back-off): log and move on
  const { error } = await db.rpc('engine_delivery_stats', { p_rows: rows });
  if (error) log.warn({ err: String(error.message).slice(0, 120) }, 'delivery stats not saved');
}

async function heartbeat() {
  const online = [...arms.values()].filter((a) => a.online).map((a) => a.id);
  if (online.length) {
    await db.from('arms').update({ last_seen_at: new Date().toISOString() }).in('id', online);
  }
}

// While the database is failing, back off (up to a minute) instead of hammering it –
// a struggling database recovers faster when it is left alone.
let dbFailStreak = 0;
function every(ms, fn, name) {
  const run = async () => {
    if (shuttingDown) return;
    let failed = false;
    try {
      await fn();
    } catch (e) {
      failed = true;
      log.error({ loop: name, err: String(e.message).slice(0, 120) }, 'loop error');
    }
    if (failed) dbFailStreak = Math.min(dbFailStreak + 1, 20);
    else if (dbFailStreak) dbFailStreak = Math.max(0, dbFailStreak - 1);
    const wait = dbFailStreak > 2 ? Math.min(60_000, ms * 2 ** Math.min(dbFailStreak - 2, 6)) : ms;
    setTimeout(run, wait);
  };
  run();
}

const INSTANCE = require('crypto').randomUUID();

// Deploys briefly run two containers. Two engines on the same WhatsApp session corrupt its
// encryption keys, so a new engine waits until the previous one has let go.
async function acquireLock() {
  for (let i = 0; ; i++) {
    const { data, error } = await db.rpc('engine_lock_acquire', { p_holder: INSTANCE });
    if (!error && data === true) return;
    if (i % 5 === 0) log.info('waiting for the previous engine to stop');
    await sleep(3000);
  }
}

async function main() {
  let bv = '?';
  try {
    bv = require('@whiskeysockets/baileys/package.json').version;
  } catch {}
  log.info({ baileys: bv, node: process.version }, 'arms engine starting');
  await acquireLock();
  log.info('engine lock acquired');
  every(5_000, async () => {
    const { data } = await db.rpc('engine_lock_acquire', { p_holder: INSTANCE });
    if (data === false) {
      log.error('another engine took over – exiting');
      await shutdown('lock-lost');
    }
  }, 'lock');
  // Arms that were "online" before a restart are reconnecting now
  await db.from('arms').update({ status: 'connecting' }).eq('status', 'online');
  await refreshSettings();
  await help.refreshConfig();

  every(5_000, reconcileArms, 'arms');
  every(3_000, processCommands, 'commands');
  every(10_000, async () => {
    await refreshSettings();
    await help.refreshConfig();
  }, 'config');
  every(3_000, help.prepareHelpCampaigns, 'prepare');
  // closing finished distributions: every 10s while something is running, once a minute otherwise
  let lastFinalize = 0;
  every(10_000, async () => {
    if (!hasWork && Date.now() - lastFinalize < 60_000) return;
    lastFinalize = Date.now();
    const { error } = await db.rpc('finalize_campaigns_engine');
    if (error) throw error;
  }, 'finalize');
  every(30_000, heartbeat, 'heartbeat');
  // delivery monitoring: once a minute, per arm (see arm.count / arm_delivery_stats)
  every(60_000, saveDelivery, 'delivery');
  // memory picture every 5 minutes (to size servers by measurement, not guesses)
  every(5 * 60_000, async () => {
    const m = process.memoryUsage();
    const mb = (x) => Math.round(x / 1048576);
    log.info({
      rssMb: mb(m.rss), heapMb: mb(m.heapUsed), externalMb: mb(m.external), buffersMb: mb(m.arrayBuffers),
      arms: [...arms.values()].map((a) => ({ arm: a.name, online: a.online, groupsKept: a.groupMeta?.size || 0, devices: a.devCache?.keys?.().length || 0, sentKept: a.sentStore?.size || 0 })),
    }, 'memory');
  }, 'memory');
  // daily database backup to the server disk (does not fail the loop – errors are logged)
  every(10 * 60_000, () => backup.maybeBackup(), 'backup');
  every(5_000, () => quote.notifyFinished(arms), 'quote-notify');
  every(5_000, () => help.reactFinished(arms), 'help-react');
  every(250, async () => {
    await checkWork();
    await Promise.all([...arms.values()].map(sendTick));
  }, 'send');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  // no new sends start now (loops stop on shuttingDown); let sends already on the way finish and be recorded
  const t0 = Date.now();
  while (Date.now() - t0 < 12_000 && [...arms.values()].some((a) => a.inFlight > 0 || a.busy)) await sleep(200);
  await Promise.race([
    Promise.all([...arms.values()].map((a) => a.stop())),
    sleep(8000),
  ]);
  if (signal !== 'lock-lost') {
    try {
      await db.rpc('engine_lock_release', { p_holder: INSTANCE });
    } catch {}
  }
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error({ err: e?.message || String(e) }, 'unhandled rejection'));
  process.on('uncaughtException', (e) => log.error({ err: e?.message || String(e) }, 'uncaught exception'));

  main().catch((e) => {
    log.fatal({ err: e.message }, 'engine failed to start');
    process.exit(1);
  });
}

// for the automated tests
module.exports = { reconcileArms, sendOne, arms, msgIdFor };
