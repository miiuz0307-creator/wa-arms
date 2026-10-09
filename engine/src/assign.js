// Which arm runs a new distribution.
// Each new "עזרה" goes to the arm with the least work right now (a free arm first).
// If that arm is not in some of the groups, another arm is added only for those groups.
const { db, log } = require('./config');

async function assignArms(candidateIds, groupIds) {
  const all = { armIds: candidateIds, exclude: () => [] };
  if (candidateIds.length <= 1 || !groupIds.length) return all;
  try {
    const [armsRes, groupsRes, activeRes] = await Promise.all([
      db.from('arms').select('id,name,status,is_active').in('id', candidateIds),
      db.from('groups').select('arm_id,wa_group_id').in('arm_id', candidateIds),
      db.from('campaigns').select('id').in('status', ['queued', 'running']),
    ]);
    const wanted = new Set(groupIds);
    const covers = new Map(candidateIds.map((id) => [id, new Set()]));
    for (const g of groupsRes.data || []) if (wanted.has(g.wa_group_id)) covers.get(g.arm_id)?.add(g.wa_group_id);

    // how many running distributions each arm already has
    const load = new Map(candidateIds.map((id) => [id, 0]));
    const activeIds = (activeRes.data || []).map((c) => c.id);
    if (activeIds.length) {
      const { data: ca } = await db.from('campaign_arms').select('arm_id').in('campaign_id', activeIds);
      for (const r of ca || []) if (load.has(r.arm_id)) load.set(r.arm_id, load.get(r.arm_id) + 1);
    }

    const rows = (armsRes.data || []).filter((a) => a.is_active);
    const online = rows.filter((a) => a.status === 'online');
    const pool = (online.length ? online : rows).map((a) => a.id).filter((id) => covers.get(id)?.size);
    if (!pool.length) return all;
    pool.sort((a, b) => load.get(a) - load.get(b) || covers.get(b).size - covers.get(a).size);

    // first arm takes everything it can; others only fill the groups it is missing
    const owner = new Map();
    const chosen = [];
    for (const id of pool) {
      let took = 0;
      for (const g of covers.get(id)) {
        if (!owner.has(g)) {
          owner.set(g, id);
          took++;
        }
      }
      if (took) chosen.push(id);
      if (owner.size === wanted.size) break;
    }
    log.info(
      { arms: chosen.map((id) => rows.find((r) => r.id === id)?.name), load: chosen.map((id) => load.get(id)) },
      'distribution assigned',
    );
    return {
      armIds: chosen,
      // the other chosen arms don't take this group (unless its owner can't send it)
      exclude: (g) => (owner.has(g) ? chosen.filter((id) => id !== owner.get(g)) : []),
    };
  } catch (e) {
    log.warn({ err: e.message }, 'arm assignment failed – using all arms');
    return all;
  }
}

// No list chosen on the trigger: every arm works with its own list(s).
// Pick the free arm (fewest running distributions, online first) and use only the lists linked to it.
async function pickFreeArm(stationId) {
  try {
    const [la, armsRes, activeRes] = await Promise.all([
      db.from('list_arms').select('arm_id,list_id').eq('station_id', stationId),
      db.from('arms').select('id,name,status,is_active,sent_today,sent_day,daily_limit').eq('station_id', stationId).eq('is_active', true),
      db.from('campaigns').select('id').eq('station_id', stationId).in('status', ['queued', 'running']),
    ]);
    const listsByArm = new Map();
    for (const r of la.data || []) {
      if (!listsByArm.has(r.arm_id)) listsByArm.set(r.arm_id, []);
      listsByArm.get(r.arm_id).push(r.list_id);
    }
    const today = new Date().toISOString().slice(0, 10);
    const usable = (armsRes.data || []).filter(
      (a) => listsByArm.has(a.id) && !(a.sent_day === today && a.sent_today >= a.daily_limit),
    );
    if (!usable.length) return null;
    const load = new Map(usable.map((a) => [a.id, 0]));
    const activeIds = (activeRes.data || []).map((c) => c.id);
    if (activeIds.length) {
      const { data: ca } = await db.from('campaign_arms').select('arm_id').in('campaign_id', activeIds);
      for (const r of ca || []) if (load.has(r.arm_id)) load.set(r.arm_id, load.get(r.arm_id) + 1);
    }
    usable.sort(
      (a, b) => (a.status === 'online' ? 0 : 1) - (b.status === 'online' ? 0 : 1) || load.get(a.id) - load.get(b.id) || (a.sent_today || 0) - (b.sent_today || 0),
    );
    const arm = usable[0];
    log.info({ arm: arm.name, load: load.get(arm.id) }, 'help goes to the free arm');
    return { armId: arm.id, listIds: listsByArm.get(arm.id) };
  } catch (e) {
    log.warn({ err: e.message }, 'free arm pick failed');
    return null;
  }
}

module.exports = { assignArms, pickFreeArm };
