// The "engine" of the demo: WhatsApp is simulated. Messages in wa_outbox are "sent" after ~2s, arm commands
// produce a QR and then a connected arm, rides progress pending → sent, and now and then a new ride arrives.
import { table, touch, nextId, getDB, type Row } from './store';
import { iso, localDate, rand, newUuid } from './util';
import { stationActive, footerOf } from './rpc';
import { ID, NO_PERM_ERR, NO_ARM_ERR, SEND_ERRS } from './seed';

let started = false;
let ticks = 0;
let nextRideAt = 0;

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const phone = () => `9725${rand().pick(['0', '2', '3', '4', '8'])}${rand().int(1000000, 9999999)}`;

export function startSim() {
  if (started || typeof window === 'undefined') return;
  started = true;
  nextRideAt = Date.now() + 20_000 + rand().int(0, 15_000);
  setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.warn('[demo sim]', e);
    }
  }, 1000);
}

function tick() {
  ticks++;
  const now = Date.now();
  let changed = false;
  const today = localDate();

  // ---- WhatsApp messages from the system (codes, approvals, reminders)
  for (const m of table('wa_outbox')) {
    if (m.status !== 'pending') continue;
    if (now - Date.parse(m.created_at) < 2000) continue;
    if (m.expires_at && Date.parse(m.expires_at) < now) Object.assign(m, { status: 'failed', error: 'פג תוקף לפני שליחה' });
    else Object.assign(m, { status: 'sent', sent_at: iso(), arm_id: table('arms').find((a) => a.station_id === ID.home && a.status === 'online')?.id ?? null });
    changed = true;
  }

  // ---- arm commands and new arms
  for (const cmd of table('arm_commands')) {
    if (cmd.status !== 'pending') continue;
    const arm = table('arms').find((a) => a.id === cmd.arm_id);
    Object.assign(cmd, { status: 'done', processed_at: iso() });
    changed = true;
    if (!arm) continue;
    if (cmd.command === 'connect' || cmd.command === 'reset') showQr(arm, now + 6000 + rand().int(0, 2000));
    else if (String(cmd.command).startsWith('pair:')) {
      const abc = 'ABCDEFGHJKLMNPQRSTVWXYZ23456789';
      const code = Array.from({ length: 8 }, () => abc[rand().int(0, abc.length - 1)]).join('');
      showQr(arm, now + 20000, `${code.slice(0, 4)}-${code.slice(4)}`);
    }
    else if (cmd.command === 'refresh_groups') table('groups').filter((g) => g.arm_id === arm.id).forEach((g) => (g.updated_at = iso()));
    else if (cmd.command === 'disconnect') Object.assign(arm, { status: 'offline', last_error: null });
  }
  for (const arm of table('arms')) {
    if (arm.status === 'pending' && arm.is_active && now - Date.parse(arm.created_at) > 2500 && !table('arm_qr').some((q) => q.arm_id === arm.id)) {
      showQr(arm, now + 8000);
      changed = true;
    }
  }
  for (const q of table('arm_qr').slice()) {
    if (!q.demo_online_at || q.demo_online_at > now) continue;
    const arm = table('arms').find((a) => a.id === q.arm_id);
    getDB().t.arm_qr = table('arm_qr').filter((x) => x !== q);
    changed = true;
    if (!arm) continue;
    Object.assign(arm, { status: 'online', last_error: null, phone: arm.phone || phone(), linked_at: arm.linked_at || iso(), last_connected_at: iso(), last_seen_at: iso() });
    if (!table('groups').some((g) => g.arm_id === arm.id)) {
      // a new number: it is a member of some of the station's groups
      const seen = new Set<string>();
      const pool = table('groups').filter((g) => g.station_id === arm.station_id && !seen.has(g.wa_group_id) && seen.add(g.wa_group_id));
      for (const g of rand().shuffle(pool).slice(0, 40))
        table('groups').push({ id: newUuid(), arm_id: arm.id, wa_group_id: g.wa_group_id, name: g.name, participants: g.participants, updated_at: iso(), station_id: arm.station_id });
    }
  }

  // ---- heartbeat
  if (ticks % 3 === 0) {
    for (const a of table('arms')) {
      if (a.sent_day !== today) Object.assign(a, { sent_day: today, sent_today: 0 });
      if (a.status === 'online' && a.is_active) a.last_seen_at = iso(now - rand().int(0, 4000));
    }
    changed = true;
  }

  // ---- rides
  if (ticks % 3 === 0 && progressRides(now)) changed = true;
  if (now >= nextRideAt) {
    nextRideAt = now + 45_000 + rand().int(0, 45_000);
    if (newRide()) changed = true;
  }
  if (ticks % 60 === 0) prune();

  if (changed) touch();
}

function showQr(arm: Row, onlineAt: number, pairCode?: string) {
  Object.assign(arm, { status: 'qr', last_error: null });
  const qr = pairCode ? `PAIR:${pairCode}` : `2@${newUuid().replace(/-/g, '')},${btoa(String(Date.now())).replace(/=/g, '')},demo-botix`;
  const cur = table('arm_qr').find((q) => q.arm_id === arm.id);
  if (cur) Object.assign(cur, { qr, updated_at: iso(), demo_online_at: onlineAt });
  else table('arm_qr').push({ arm_id: arm.id, qr, updated_at: iso(), station_id: arm.station_id, demo_online_at: onlineAt });
}

function progressRides(now: number): boolean {
  const camps = table('campaigns').filter((c) => (c.status === 'queued' || c.status === 'running') && c.final_text);
  if (!camps.length) return false;
  const targetsBy = new Map<string, Row[]>();
  for (const t of table('campaign_targets')) if (t.status === 'pending') (targetsBy.get(t.campaign_id) || targetsBy.set(t.campaign_id, []).get(t.campaign_id)!).push(t);
  let changed = false;
  for (const c of camps) {
    if (!stationActive(c.station_id)) continue; // the engine does not handle a station whose subscription ended
    const pending = targetsBy.get(c.id) || [];
    const armIds = table('campaign_arms').filter((x) => x.campaign_id === c.id).map((x) => x.arm_id);
    const arms = table('arms').filter((a) => armIds.includes(a.id));
    const live = arms.filter((a) => a.is_active && a.status === 'online' && !(a.sent_day === localDate() && a.sent_today >= a.daily_limit));
    if (c.status === 'queued') Object.assign(c, { status: 'running', started_at: c.started_at || iso() });
    const disabled = new Set(table('group_flags').filter((f) => f.station_id === c.station_id && f.disabled).map((f) => f.wa_group_id));
    const budget = Math.max(4, live.length * 5);
    let k = 0;
    for (const t of pending) {
      if (k >= budget) break;
      k++;
      changed = true;
      t.attempts = (t.attempts || 0) + 1;
      // spread over the last tick, never before the ride started (the history screen measures from started_at)
      const startMs = Date.parse(c.started_at || c.created_at) || now;
      const at = Math.max(startMs + 50, now - rand().int(0, 2500));
      t.claimed_at = iso(Math.max(startMs, at - rand().int(150, 600)));
      if (disabled.has(t.wa_group_id)) {
        Object.assign(t, { status: 'skipped', error: 'הקבוצה סומנה "לא לשלוח"' });
        continue;
      }
      const usable = live.filter((a) => !(t.tried_arms || []).includes(a.id) && table('groups').some((g) => g.arm_id === a.id && g.wa_group_id === t.wa_group_id));
      if (!usable.length) {
        Object.assign(t, { status: 'failed', error: NO_ARM_ERR });
        continue;
      }
      const arm = usable[(hash(t.wa_group_id) + t.attempts) % usable.length];
      t.arm_id = arm.id;
      if (hash(t.wa_group_id + arm.id) % 53 === 0) {
        Object.assign(t, { status: 'skipped', error: NO_PERM_ERR });
        continue;
      }
      if (rand().chance(0.012)) {
        Object.assign(t, { status: 'failed', error: rand().pick(SEND_ERRS), tried_arms: [...(t.tried_arms || []), arm.id] });
        continue;
      }
      Object.assign(t, { status: 'sent', sent_at: iso(at), error: null });
      arm.sent_today = (arm.sent_day === localDate() ? arm.sent_today || 0 : 0) + 1;
      arm.sent_day = localDate();
      arm.sent_total = (arm.sent_total || 0) + 1;
    }
    c.last_claim_at = iso();
    const all = table('campaign_targets').filter((t) => t.campaign_id === c.id);
    c.total = all.length;
    c.sent = all.filter((t) => t.status === 'sent').length;
    c.failed = all.filter((t) => t.status === 'failed' || t.status === 'skipped').length;
    if (!all.some((t) => t.status === 'pending' || t.status === 'sending')) Object.assign(c, { status: 'completed', finished_at: iso() });
  }
  return changed;
}

const FROM_TO: Record<string, string[]> = {
  [ID.sharon]: ['נתניה', 'כפר סבא', 'רעננה', 'הרצליה', 'הוד השרון', 'רמת השרון', 'כפר יונה', 'אבן יהודה', 'קדימה', 'נתב״ג', 'תל אביב', 'פתח תקווה'],
  [ID.castel]: ['ירושלים', 'מבשרת', 'בית שמש', 'מעלה אדומים', 'נתב״ג', 'מודיעין', 'רמות', 'גילה'],
  [ID.home]: ['תל אביב', 'רמת גן', 'נתב״ג', 'חולון', 'בת ים', 'גבעתיים'],
};
const EXTRAS = ['', '', ' + 2 מזוודות', ' · מושב בטיחות לילד', ' · רכב 7 מקומות', ' · תשלום באשראי'];
const NAMES = ['אבי כהן', 'משה לוי', 'רונן פרץ', 'שלומי ביטון', 'עמית מזרחי', 'גיל אזולאי', 'סהר דהן'];

/** a dispatcher's ride arrives in a source group and is distributed to a list */
function newRide(): boolean {
  const r = rand();
  const sid = r.chance(0.7) ? ID.sharon : r.pick([ID.castel, ID.home]);
  if (!stationActive(sid)) return false;
  const set = table('app_settings').find((s) => s.station_id === sid);
  if (set && set.auto_distribution_enabled === false) return false;
  const lists = table('distribution_lists').filter((l) => l.station_id === sid);
  const sizes = new Map(lists.map((l) => [l.id, table('list_groups').filter((g) => g.list_id === l.id).length]));
  const usable = lists.filter((l) => (sizes.get(l.id) || 0) > 0 && (sizes.get(l.id) || 0) <= 240);
  if (!usable.length) return false;
  const list = r.pick(usable);
  const cities = FROM_TO[sid];
  const from = r.pick(cities);
  let to = r.pick(cities);
  if (to === from) to = 'נתב״ג';
  const hh = new Date(Date.now() + r.int(20, 240) * 60_000);
  const text = `🚕 נסיעה מ${from} ל${to}\n⏰ ${String(hh.getHours()).padStart(2, '0')}:${r.pick(['00', '15', '30', '45'])}\n👥 ${r.int(1, 6)} נוסעים${r.pick(EXTRAS)}`;
  const help = r.chance(0.35);
  const reqPhone = `05${r.pick(['0', '2', '4', '8'])}${r.int(1000000, 9999999)}`;
  const finalText = help ? `${text}\n📞 לבקשה במספר: ${reqPhone}` : text;
  const src = table('source_groups').find((s) => s.station_id === sid && s.is_active);
  const disp = table('dispatchers').filter((d) => d.station_id === sid);
  const d = disp.length ? r.pick(disp) : { name: r.pick(NAMES), phone: reqPhone, wa_jid: null };
  const trig = help ? table('triggers').find((t) => t.station_id === sid && t.keyword === 'עזרה') : null;
  const id = newUuid();
  const camp = {
    id, kind: help ? 'help' : 'quote', status: 'queued', message_text: help ? `עזרה ${text}` : text, final_text: finalText, requester_name: d.name,
    requester_phone: help ? reqPhone : d.phone, requester_jid: d.wa_jid ?? null, source_group_id: src?.wa_group_id ?? null, source_group_name: src?.name ?? null,
    source_message_id: 'DEMO' + r.int(100000, 999999), trigger_id: trig?.id ?? null, list_id: list.id, total: 0, sent: 0, failed: 0, created_by: null,
    created_at: iso(), started_at: iso(), finished_at: null, trigger_key: null, trigger_arm_id: src?.listen_arm_id ?? null, reacted: true, last_claim_at: null, station_id: sid,
  };
  table('campaigns').push(camp);
  for (const la of table('list_arms').filter((x) => x.list_id === list.id)) table('campaign_arms').push({ campaign_id: id, arm_id: la.arm_id, station_id: sid });
  const members = table('list_groups').filter((g) => g.list_id === list.id);
  for (const g of members)
    table('campaign_targets').push({
      id: nextId('campaign_targets'), campaign_id: id, wa_group_id: g.wa_group_id, group_name: g.group_name, station_id: sid, status: 'pending', attempts: 0,
      error: null, sent_at: null, claimed_at: null, arm_id: null, tried_arms: [],
    });
  camp.total = members.length;
  table('activity_log').push({
    id: nextId('activity_log'), actor_id: null, actor_name: 'הבוט', action: help ? 'help_received' : 'quote_distributed', entity: 'campaign', entity_id: id,
    details: { group: src?.name ?? null, list: list.name }, created_at: iso(), station_id: sid,
  });
  return true;
}

/** keep the saved demo small: drop the per-group rows of old rides (their totals stay) */
function prune() {
  const ts = table('campaign_targets');
  if (ts.length < 18_000) return;
  const camps = table('campaigns')
    .filter((c) => c.status === 'completed' || c.status === 'cancelled')
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const drop = new Set<string>();
  let n = ts.length;
  for (const c of camps) {
    if (n < 13_000) break;
    const k = ts.filter((t) => t.campaign_id === c.id).length;
    if (!k) continue;
    drop.add(c.id);
    n -= k;
  }
  getDB().t.campaign_targets = ts.filter((t) => !drop.has(t.campaign_id));
}

/** what WhatsApp would show: the last rides as they went out to the groups (with the station's footer) */
export function lastRideTexts(limit = 12) {
  return table('campaigns')
    .filter((c) => c.final_text && c.sent > 0)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit)
    .map((c) => {
      const f = footerOf(c.station_id);
      return {
        id: c.id, station: table('stations').find((s) => s.id === c.station_id)?.name ?? '', at: c.created_at, sent: c.sent, total: c.total, status: c.status,
        text: f ? `${c.final_text}\n\n${f}` : c.final_text, footer: f,
      };
    });
}
