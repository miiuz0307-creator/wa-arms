// Arms engine – runs 24/7 on the server, independent of the admin UI.
const { db, log } = require('./config');
const { Arm } = require('./arm');
const help = require('./help');
const quote = require('./quote');
const backup = require('./backup');
const { randomBetween, sleep } = require('./util');
const phones = require('./phones');
const outbox = require('./outbox');

const arms = new Map(); // arm id -> Arm
quote.setArmsSource(() => arms);
Arm.setRelevance(help.relevance);
// settings per station (station_id -> app_settings row)
const settingsByStation = new Map();
const settingsFor = (arm) => settingsByStation.get(arm.stationId) || { min_delay_sec: 8, max_delay_sec: 20 };
let shuttingDown = false;

// ---------- arms sync: keep running arms in line with the arms table ----------
// Rules (11 Oct: one blocked number froze this sync for hours – new arms didn't start, warm-up and
// on/off changes weren't picked up):
//  1. The sync never waits for an arm. Stopping / removing an arm runs in the background with a time
//     limit; the sync goes on at once.
//  2. An arm that is still stopping is not started again until that stop is over (or its time limit
//     passed) – never two connections of the same number.
//  3. A pass that does not finish within SYNC_STUCK_MS is abandoned (it can no longer change anything)
//     and a fresh pass starts – the engine recovers without a restart.
//  4. Health: when the last good pass was and how long it took are reported to the database.
const stopLimitMs = () => Number(process.env.ENGINE_STOP_LIMIT_MS) || 10_000;
const syncStuckMs = () => Number(process.env.ENGINE_SYNC_STUCK_MS) || 60_000;
const stopping = new Map(); // arm id -> { done: Promise, since }

function stopInBackground(id, arm, how, what) {
  const since = Date.now();
  const work = Promise.resolve()
    .then(() => (how === 'destroy' ? arm.destroy() : arm.stop()))
    .catch((e) => log.warn({ what, err: e?.message }, 'stop failed'));
  const limit = new Promise((r) => {
    const t = setTimeout(() => {
      log.warn({ what }, 'stop took too long – the sync went on without it');
      // make sure the old connection is really closed before the number can be started again
      try {
        arm.stopped = true;
        arm.sock?.end?.(undefined);
      } catch {}
      r();
    }, stopLimitMs());
    t.unref?.();
  });
  const done = Promise.race([work, limit]).finally(() => {
    if (stopping.get(id)?.since === since) stopping.delete(id);
  });
  stopping.set(id, { done, since });
  return done;
}

let syncGen = 0; // bumped when a pass is abandoned – the abandoned pass then changes nothing
const syncState = { running: null, okAt: 0, ms: 0, stuck: 0, errors: 0, nextAt: 0 };

async function reconcileArms(gen = syncGen) {
  const live = () => gen === syncGen && !shuttingDown;
  const [{ data, error }, st] = await Promise.all([
    db.from('arms').select('id,name,is_active,status,station_id,linked_at'),
    db.rpc('engine_station_states'),
  ]);
  if (error) throw new Error('load arms failed: ' + error.message);
  if (st.error) throw new Error('load station states failed: ' + st.error.message);
  if (!live()) return;
  // stations that are suspended or whose subscription ended: their arms stop
  const blocked = new Set((st.data || []).filter((s) => !s.allowed).map((s) => s.id));
  const ids = new Set(data.map((a) => a.id));
  const writes = []; // database updates of this pass – sent together, never one arm waiting on another

  for (const row of data) {
    let arm = arms.get(row.id);
    if (arm) {
      arm.name = row.name;
      arm.stationId = row.station_id;
      arm.linkedAt = row.linked_at ? new Date(row.linked_at).getTime() : 0;
    }
    const shouldRun = row.is_active && !blocked.has(row.station_id);
    if (row.is_active && blocked.has(row.station_id) && !arm && row.status !== 'paused') {
      writes.push(db.from('arms').update({ status: 'paused', last_error: 'התחנה מושעית או שהמנוי הסתיים' }).eq('id', row.id));
    }
    if (shouldRun && !arm) {
      if (stopping.has(row.id)) continue; // the previous connection of this number is still closing
      arm = new Arm(row, help.onMessage);
      arm.onBlocked = alertBlocked;
      arms.set(row.id, arm);
      arm.start();
    } else if (!shouldRun && arm) {
      arms.delete(row.id);
      stopInBackground(row.id, arm, 'stop', `stop ${row.name}`);
      writes.push(db.from('arm_qr').delete().eq('arm_id', row.id));
      writes.push(
        db.from('arms').update({
          status: 'paused',
          ...(row.is_active ? { last_error: 'התחנה מושעית או שהמנוי הסתיים' } : {}),
        }).eq('id', row.id),
      );
      log.info({ arm: row.name }, 'arm paused');
    }
  }
  await Promise.all(writes.map((w) => Promise.resolve(w).catch(() => {})));
  if (!live()) return;
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
    if (!live()) return;
    if (e2 || row) {
      missingSince.delete(id);
      continue;
    }
    missingSince.delete(id);
    arms.delete(id);
    stopInBackground(id, arm, 'destroy', `destroy ${arm.name}`);
    log.info({ arm: arm.name }, 'arm removed (deleted in the app)');
  }
}
const missingSince = new Map();

// One pass at a time; a pass stuck longer than syncStuckMs() is abandoned and a fresh one starts.
async function syncArms() {
  const now = Date.now();
  if (syncState.running) {
    if (now - syncState.running.startedAt < syncStuckMs()) return syncState.running.promise;
    syncGen += 1;
    syncState.stuck += 1;
    log.error({ stuckSec: Math.round((now - syncState.running.startedAt) / 1000), times: syncState.stuck }, 'arms sync stuck – abandoning that pass and starting a fresh one');
    syncState.running = null;
  }
  if (now < syncState.nextAt) return;
  const gen = syncGen;
  const startedAt = now;
  const promise = reconcileArms(gen)
    .then(() => {
      if (gen !== syncGen) return;
      syncState.okAt = Date.now();
      syncState.ms = Date.now() - startedAt;
      syncState.errors = 0;
    })
    .catch((e) => {
      if (gen !== syncGen) return;
      syncState.errors += 1;
      // a failing database is left alone for a while (5s, 10s, 20s … up to a minute)
      syncState.nextAt = Date.now() + Math.min(60_000, 5_000 * 2 ** Math.min(syncState.errors - 1, 4));
      log.error({ loop: 'arms', err: String(e.message).slice(0, 120) }, 'loop error');
    })
    .finally(() => {
      if (syncState.running?.gen === gen) syncState.running = null;
    });
  syncState.running = { gen, startedAt, promise };
  return promise;
}

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
      const pairPhone = String(cmd.command || '').startsWith('pair:') ? cmd.command.slice(5) : null;
      if (!arm && (cmd.command === 'reset' || cmd.command === 'connect' || pairPhone)) {
        // re-activate a paused arm
        await db.from('arms').update({ is_active: true }).eq('id', cmd.arm_id);
        await syncArms();
        arm = arms.get(cmd.arm_id);
      }
      if (!arm) throw new Error('הזרוע לא פעילה');
      if (pairPhone) await arm.pairWithCode(pairPhone);
      else if (cmd.command === 'reset') await arm.reset();
      else if (cmd.command === 'connect') await arm.start();
      else if (cmd.command === 'refresh_groups') await arm.syncGroups();
      else if (cmd.command === 'disconnect') {
        await db.from('arms').update({ is_active: false }).eq('id', cmd.arm_id);
        await syncArms();
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
// Anti-block: one refusal changes nothing, but WhatsApp refusing the same number again and again
// ("rate-overlimit") comes right before a block. Then THAT number rests for a few minutes and the other
// arms carry on with the ride – the station's speed setting is never changed.
const COOL_REFUSALS = 4; // refusals …
const COOL_WINDOW_MS = 5 * 60_000; // … within 5 minutes
const COOL_MS = 10 * 60_000; // → this arm rests 10 minutes
function slowDown(arm) {
  arm.penalty = 1;
  const now = Date.now();
  arm.refusals = (arm.refusals || []).filter((t) => now - t < COOL_WINDOW_MS);
  arm.refusals.push(now);
  if (arm.refusals.length >= COOL_REFUSALS && !(arm.coolUntil > now)) {
    arm.coolUntil = now + COOL_MS;
    arm.refusals = [];
    log.warn({ arm: arm.name, until: new Date(arm.coolUntil).toISOString() }, 'anti-block: repeated refusals – this arm rests, the others continue');
    return;
  }
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
  if (arm.coolUntil > Date.now()) return; // anti-block rest (see slowDown)
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

async function heartbeat() {
  const online = [...arms.values()].filter((a) => a.online).map((a) => a.id);
  if (online.length) {
    await db.from('arms').update({ last_seen_at: new Date().toISOString() }).in('id', online);
  }
  // engine health for the control center and the update checks
  await db.rpc('engine_status_report', {
    p: {
      sync_ok_at: syncState.okAt ? new Date(syncState.okAt).toISOString() : null,
      sync_ms: syncState.ms,
      sync_stuck_count: syncState.stuck,
      arms_running: arms.size,
      arms_online: online.length,
      arms_stopping: stopping.size,
      rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    },
  }).then(() => {}, () => {});
}

// A number WhatsApp blocked (403): a WhatsApp message right away to the system owner (the phone of the home
// system) and to the manager of the arm's station (its phone), sent by another connected arm – preferably of
// the same station. Once per block (the blocked arm stops and is not retried until someone presses "התחבר").
async function alertBlocked(blocked) {
  const { data: rows } = await db.from('stations').select('id,name,phone,is_home'); // rows: bounded – stations
  const home = (rows || []).find((s) => s.is_home);
  const own = (rows || []).find((s) => s.id === blocked.stationId);
  const intl = (raw) => {
    const d = phones.normalize(raw);
    return /^05\d{8}$/.test(d) ? '972' + d.slice(1) : null;
  };
  const to = [...new Set([home?.phone, own?.phone].map(intl).filter(Boolean))];
  if (!to.length) return log.warn({ arm: blocked.name }, 'block alert: no phone to send to (set the phone of the home system)');
  const others = [...arms.values()].filter((a) => a !== blocked && a.online);
  const sender = others.find((a) => a.stationId === blocked.stationId) || others[0];
  if (!sender) return log.warn({ arm: blocked.name }, 'block alert: no connected arm to send from');
  const { data: me } = await db.from('arms').select('phone,sent_today,sent_day').eq('id', blocked.id).maybeSingle();
  const today = new Date().toISOString().slice(0, 10);
  const time = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  const text = [
    '⚠️ *זרוע נחסמה*',
    `${blocked.name}${me?.phone ? ` (${me.phone})` : ''}${own && !own.is_home ? ` – ${own.name}` : ''}`,
    `וואטסאפ חסם את המספר ב-${time}${me?.sent_day === today ? ` אחרי ${Number(me.sent_today || 0).toLocaleString('he-IL')} הודעות היום` : ''}.`,
    'הזרוע הפסיקה לשלוח, ושאר הזרועות ממשיכות. בדוק בטלפון של המספר, ואחרי שישוחרר לחץ "התחבר" במסך הזרועות.',
  ].join('\n');
  for (const p of to) {
    await sender.send(`${p}@s.whatsapp.net`, text).catch((e) => log.warn({ arm: blocked.name, err: e.message }, 'block alert: send failed'));
  }
  log.info({ arm: blocked.name, to: to.length, via: sender.name }, 'block alert sent');
}

// While the database is failing, back off (up to a minute) instead of hammering it –
// a struggling database recovers faster when it is left alone.
let dbFailStreak = 0;
// timeoutMs (only for loops where a second pass is harmless – never for sending): a pass that hangs is given
// up after timeoutMs and the loop goes on. On 15 Oct the completion-notice and settings loops hung on one
// WhatsApp call at 00:56 and never ran again – no ✓ on any ride and no settings reload until a restart.
function every(ms, fn, name, timeoutMs = 0) {
  const run = async () => {
    if (shuttingDown) return;
    let failed = false;
    const slow = setTimeout(() => log.warn({ loop: name }, 'loop still running after 3 minutes'), 180_000);
    slow.unref?.();
    try {
      if (timeoutMs) {
        let t;
        await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, rej) => {
            t = setTimeout(() => rej(new Error(`pass did not finish in ${Math.round(timeoutMs / 1000)}s – given up`)), timeoutMs);
          }),
        ]).finally(() => clearTimeout(t));
      } else {
        await fn();
      }
    } catch (e) {
      failed = true;
      log.error({ loop: name, err: String(e.message).slice(0, 120) }, 'loop error');
    }
    clearTimeout(slow);
    if (failed) dbFailStreak = Math.min(dbFailStreak + 1, 20);
    else if (dbFailStreak) dbFailStreak = Math.max(0, dbFailStreak - 1);
    const wait = dbFailStreak > 2 ? Math.min(60_000, ms * 2 ** Math.min(dbFailStreak - 2, 6)) : ms;
    setTimeout(run, wait);
  };
  run();
}

// Disk picture once an hour: how much the WhatsApp keys of each arm and the backups take on the server
// disk, and folders of arms that no longer exist (left for the owner to decide – nothing is deleted here).
// `du` runs as a separate process, so the engine is not slowed down while it counts.
async function diskReport() {
  const { execFile } = require('child_process');
  const fsp = require('fs/promises');
  const pathM = require('path');
  const AUTH = process.env.AUTH_DIR || '/data/auth';
  const BACK = process.env.BACKUP_DIR || '/data/backups';
  const du = (dirs) =>
    new Promise((res) =>
      execFile('du', ['-sk', '--', ...dirs], { timeout: 120_000, maxBuffer: 1 << 20 }, (err, out) =>
        res(String(out || '').trim().split('\n').filter(Boolean).map((l) => {
          const [kb, ...p] = l.split('\t');
          return { kb: Number(kb), dir: p.join('\t') };
        })),
      ),
    );
  const ids = await fsp.readdir(AUTH).catch(() => []);
  const rows = ids.length ? await du(ids.map((i) => pathM.join(AUTH, i))) : [];
  const [backups] = await du([BACK]);
  const { data: known } = await db.from('arms').select('id,name,is_active');
  const byId = new Map((known || []).map((a) => [a.id, a]));
  const mb = (kb) => Math.round((kb / 1024) * 10) / 10;
  const per = rows
    .map((r) => {
      const id = pathM.basename(r.dir);
      const a = byId.get(id);
      return { arm: a ? a.name : `(לא קיימת) ${id.slice(0, 8)}`, active: !!a?.is_active, mb: mb(r.kb) };
    })
    .sort((x, y) => y.mb - x.mb);
  const authMb = per.reduce((t, r) => t + r.mb, 0);
  log.info({ authMb: Math.round(authMb), backupsMb: mb(backups?.kb || 0), arms: per }, 'disk');
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

  // arms sync every 5s; never two passes at once; a stuck pass is replaced (see syncArms)
  const syncTimer = setInterval(() => !shuttingDown && syncArms(), 5_000);
  syncTimer.unref?.();
  syncArms();
  every(3_000, processCommands, 'commands');
  every(10_000, async () => {
    await refreshSettings();
    await help.refreshConfig();
  }, 'config', 60_000);
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
  // disk picture every hour (first one 2 minutes after start)
  setTimeout(() => every(60 * 60_000, diskReport, 'disk'), 120_000);
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
  // login codes and other system messages to private numbers (wa_outbox)
  every(4_000, () => outbox.tick(arms, () => shuttingDown), 'outbox', 120_000);
  every(5_000, () => quote.notifyFinished(arms), 'quote-notify', 60_000);
  every(5_000, () => help.reactFinished(arms), 'help-react', 60_000);
  // each arm sends on its own: one slow or stuck send never delays the other arms
  every(250, async () => {
    await checkWork();
    for (const a of arms.values()) sendTick(a).catch((e) => log.error({ arm: a.name, err: e.message }, 'send tick failed'));
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
module.exports = { reconcileArms, syncArms, syncState, stopping, sendOne, sendTick, arms, msgIdFor, slowDown };
