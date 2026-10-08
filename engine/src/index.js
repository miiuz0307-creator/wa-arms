// Arms engine – runs 24/7 on the server, independent of the admin UI.
const { db, log } = require('./config');
const { Arm } = require('./arm');
const help = require('./help');
const { randomBetween, sleep } = require('./util');

const arms = new Map(); // arm id -> Arm
let settings = { min_delay_sec: 8, max_delay_sec: 20 };
let shuttingDown = false;

// Keep running arms in line with the arms table
async function reconcileArms() {
  const { data, error } = await db.from('arms').select('id,name,is_active,status');
  if (error) return log.error({ err: error.message }, 'load arms failed');
  const ids = new Set(data.map((a) => a.id));

  for (const row of data) {
    let arm = arms.get(row.id);
    if (arm) arm.name = row.name;
    if (row.is_active && !arm) {
      arm = new Arm(row, help.onMessage);
      arms.set(row.id, arm);
      arm.start();
    } else if (!row.is_active && arm) {
      arms.delete(row.id);
      await arm.stop();
      await db.from('arm_qr').delete().eq('arm_id', row.id);
      await db.from('arms').update({ status: 'paused' }).eq('id', row.id);
      log.info({ arm: row.name }, 'arm paused');
    }
  }
  for (const [id, arm] of arms) {
    if (!ids.has(id)) {
      arms.delete(id);
      await arm.destroy();
      log.info({ arm: arm.name }, 'arm removed');
    }
  }
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
  const { data } = await db.from('app_settings').select('*').eq('id', 1).single();
  if (data) settings = data;
}

// One send at a time per arm, with a random pause between sends
async function sendTick(arm) {
  if (arm.busy || !arm.online || Date.now() < arm.nextSendAt) return;
  arm.busy = true;
  try {
    const { data, error } = await db.rpc('claim_target_engine', { p_arm: arm.id });
    if (error) throw error;
    const job = data?.[0];
    if (!job) return;

    let ok = true;
    let errText = null;
    try {
      await arm.send(job.wa_group_id, job.final_text);
    } catch (e) {
      ok = false;
      errText = e?.message || 'שגיאת שליחה';
    }
    await db.rpc('target_result_engine', { p_id: job.target_id, p_arm: arm.id, p_ok: ok, p_error: errText });
    const min = Math.max(1, settings.min_delay_sec) * 1000;
    const max = Math.max(min, settings.max_delay_sec * 1000);
    arm.nextSendAt = Date.now() + randomBetween(min, max);
    if (!ok) log.warn({ arm: arm.name, group: job.wa_group_id, err: errText }, 'send failed');
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
}

function every(ms, fn, name) {
  const run = async () => {
    if (shuttingDown) return;
    try {
      await fn();
    } catch (e) {
      log.error({ loop: name, err: e.message }, 'loop error');
    }
    setTimeout(run, ms);
  };
  run();
}

async function main() {
  log.info('arms engine starting');
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
  every(10_000, async () => {
    const { error } = await db.rpc('finalize_campaigns_engine');
    if (error) throw error;
  }, 'finalize');
  every(30_000, heartbeat, 'heartbeat');
  every(1_000, async () => {
    await Promise.all([...arms.values()].map(sendTick));
  }, 'send');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  await Promise.race([
    Promise.all([...arms.values()].map((a) => a.stop())),
    sleep(8000),
  ]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error({ err: e?.message || String(e) }, 'unhandled rejection'));
process.on('uncaughtException', (e) => log.error({ err: e?.message || String(e) }, 'uncaught exception'));

main().catch((e) => {
  log.fatal({ err: e.message }, 'engine failed to start');
  process.exit(1);
});
