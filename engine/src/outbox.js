// System messages to private numbers (wa_outbox): login codes (and later other system messages). The database
// queues them; the engine sends each as a plain WhatsApp text. Sender: the arm whose number is set as the
// "codes number" (owner_settings.otp_sender_phone, 053-230-6885). If that number is not connected, an online
// arm of the HOME station sends it instead, so logging in never depends on one phone. Never a customer
// station's arm.
const { db, log } = require('./config');
const { sleep } = require('./util');

const BATCH = 5;
const HOME_TTL_MS = 10 * 60_000;
const NOT_ON_WA = 'המספר לא בוואטסאפ';
const state = { busy: false, gapMs: 1500, home: null, homeAt: 0, sender: null, senderAt: 0, sent: 0, failed: 0 };

// 050-123-4567 / +972 50 123 4567 / 00972501234567 / 972501234567 → 972501234567@s.whatsapp.net
function phoneJid(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  if (d.length < 10 || d.length > 15) return null;
  return `${d}@s.whatsapp.net`;
}

async function homeStation() {
  if (state.home && Date.now() - state.homeAt < HOME_TTL_MS) return state.home;
  const { data, error } = await db.rpc('engine_home_station');
  if (error) throw new Error('home station: ' + error.message);
  state.home = data || null;
  state.homeAt = Date.now();
  return state.home;
}

async function senderPhone() {
  if (Date.now() - state.senderAt < HOME_TTL_MS) return state.sender;
  const { data } = await db.rpc('engine_otp_sender');
  state.sender = typeof data === 'string' && data ? data.replace(/\D/g, '').replace(/^972/, '0') : null;
  state.senderAt = Date.now();
  return state.sender;
}

// the dedicated codes number first (if connected), then online arms of the home station, least used first (fewest messages sent today, then the one online longest
// without a send), so system messages do not pile on one number
async function pickArms(arms, home) {
  const want = await senderPhone().catch(() => null);
  if (want) {
    const own = [...arms.values()].find((a) => a.online && a.sock && String(a.sock.user?.id || '').split(/[:@]/)[0].replace(/^972/, '0') === want);
    if (own) return [own];
  }
  const online = [...arms.values()].filter((a) => a.online && a.sock && a.stationId === home);
  if (online.length < 2) return online;
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = new Map();
  const { data } = await db.from('arms').select('id,sent_today,sent_day').in('id', online.map((a) => a.id));
  for (const r of data || []) sentToday.set(r.id, String(r.sent_day || '').slice(0, 10) === today ? Number(r.sent_today) || 0 : 0);
  return online.sort(
    (x, y) => (sentToday.get(x.id) || 0) - (sentToday.get(y.id) || 0) || (x.outboxAt || 0) - (y.outboxAt || 0),
  );
}

async function done(id, ok, error, armId) {
  const { error: e } = await Promise.resolve()
    .then(() => db.rpc('engine_outbox_done', { p_id: id, p_ok: ok, p_error: error, p_arm: armId || null }))
    .catch((err) => ({ error: err }));
  if (e) log.warn({ outbox: id, err: String(e.message || e).slice(0, 120) }, 'outbox: recording the result failed');
}

async function sendOne(arm, msg) {
  const jid = phoneJid(msg.to_phone);
  if (!jid) return done(msg.id, false, 'מספר טלפון לא תקין', arm.id);
  // not on WhatsApp → no send (only when the check answers clearly)
  if (typeof arm.sock?.onWhatsApp === 'function') {
    try {
      const res = await arm.sock.onWhatsApp(jid);
      if (Array.isArray(res) && !res.some((r) => r?.exists)) {
        state.failed += 1;
        log.info({ outbox: msg.id, arm: arm.name }, 'outbox: number not on WhatsApp');
        return done(msg.id, false, NOT_ON_WA, arm.id);
      }
    } catch {} // the check itself failed – try to send anyway
  }
  try {
    arm.outboxAt = Date.now();
    await arm.send(jid, msg.body);
    state.sent += 1;
    log.info({ outbox: msg.id, arm: arm.name }, 'outbox: sent');
    return done(msg.id, true, null, arm.id);
  } catch (e) {
    state.failed += 1;
    const err = String(e?.message || 'שגיאת שליחה').slice(0, 300);
    log.warn({ outbox: msg.id, arm: arm.name, err }, 'outbox: send failed');
    return done(msg.id, false, err, arm.id);
  }
}

/**
 * One pass: take up to 5 waiting messages and send them, ≥1.5s apart. Runs only while an arm of the home
 * station is online; stops taking messages when the engine shuts down. Never throws.
 */
async function tick(arms, isStopping = () => false) {
  if (state.busy || isStopping()) return;
  state.busy = true;
  try {
    const home = await homeStation();
    if (!home) return;
    if (!(await pickArms(arms, home)).length) return;
    const { data: msgs, error } = await db.rpc('engine_outbox_take', { p_limit: BATCH });
    if (error) throw new Error('take: ' + error.message);
    if (!msgs?.length) return;
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      // already taken from the queue: if the engine is stopping or no arm is left, close it with a reason
      // (the database has no "put back"; login codes can simply be requested again)
      if (isStopping()) {
        await done(msg.id, false, 'המנוע הופעל מחדש לפני השליחה – נסו שוב', null);
        continue;
      }
      const choice = await pickArms(arms, home);
      if (!choice.length) {
        await done(msg.id, false, 'אין זרוע מחוברת של התחנה הראשית', null);
        continue;
      }
      const arm = choice[0];
      if (i > 0) await sleep(state.gapMs);
      await sendOne(arm, msg);
    }
  } catch (e) {
    log.warn({ err: String(e?.message || e).slice(0, 120) }, 'outbox: pass failed');
  } finally {
    state.busy = false;
  }
}

module.exports = { tick, phoneJid, state, NOT_ON_WA };
