// "Help" auto-distribution: listen to source groups, detect trigger words,
// identify the requester's phone, and create a distribution campaign.
const { db, log } = require('./config');
const { extractText, containsKeyword, formatPhone, jidUser, buildHelpText } = require('./util');
const quote = require('./quote');

const state = {
  settings: { auto_distribution_enabled: false },
  sources: new Map(), // wa_group_id -> row
  triggers: [],
};
quote.setTriggerSource(() => state.triggers);

async function refreshConfig() {
  const [s, src, trg] = await Promise.all([
    db.from('app_settings').select('*').eq('id', 1).single(),
    db.from('source_groups').select('*').eq('is_active', true),
    db.from('triggers').select('*').eq('is_active', true),
  ]);
  if (!s.error) state.settings = s.data;
  if (!src.error) state.sources = new Map(src.data.map((r) => [r.wa_group_id, r]));
  if (!trg.error) state.triggers = trg.data.sort((a, b) => b.keyword.length - a.keyword.length);
}

async function logActivity(action, entity, entityId, details) {
  await db.from('activity_log').insert({
    actor_name: 'מערכת',
    action,
    entity,
    entity_id: entityId,
    details: details || null,
  });
}

async function resolveRequester(arm, m) {
  const k = m.key || {};
  const candidates = [k.participant, m.participant, k.participantPn, k.participantAlt, k.senderPn].filter(Boolean);
  const pnJid = candidates.find((j) => j.endsWith('@s.whatsapp.net'));
  const lid = candidates.find((j) => j.endsWith('@lid'));
  let phoneDigits = pnJid ? jidUser(pnJid) : null;

  // newer WhatsApp versions may expose a LID→phone mapping
  if (!phoneDigits && lid) {
    try {
      const mapper = arm.sock?.signalRepository?.lidMapping;
      const pn = mapper?.getPNForLID ? await mapper.getPNForLID(lid) : null;
      if (pn) phoneDigits = jidUser(pn);
    } catch {}
  }

  let dispatcher = null;
  if (lid) dispatcher = (await db.from('dispatchers').select('*').eq('wa_lid', lid).maybeSingle()).data;
  if (!dispatcher && pnJid) dispatcher = (await db.from('dispatchers').select('*').eq('wa_jid', pnJid).maybeSingle()).data;
  if (!dispatcher && phoneDigits) {
    dispatcher = (await db.from('dispatchers').select('*').eq('phone', formatPhone(phoneDigits)).maybeSingle()).data;
  }

  let phone = phoneDigits ? formatPhone(phoneDigits) : dispatcher?.phone || null;
  const name = m.pushName || dispatcher?.name || null;

  // learn: remember every identity we can link to a phone
  try {
    if (!dispatcher) {
      await db.from('dispatchers').insert({
        name,
        phone,
        wa_jid: pnJid || null,
        wa_lid: lid || null,
        auto_detected: !!phone,
      });
    } else {
      const patch = {};
      if (!dispatcher.wa_lid && lid) patch.wa_lid = lid;
      if (!dispatcher.wa_jid && pnJid) patch.wa_jid = pnJid;
      if (!dispatcher.phone && phone) {
        patch.phone = phone;
        patch.auto_detected = true;
      }
      if (!dispatcher.name && name) patch.name = name;
      if (Object.keys(patch).length) await db.from('dispatchers').update(patch).eq('id', dispatcher.id);
    }
  } catch (e) {
    log.warn({ err: e.message }, 'dispatcher learn failed');
  }

  return { phone, name, jid: lid || pnJid || candidates[0] || null };
}

async function onMessage(arm, m) {
  // 1. quote + trigger, and private-chat commands for it
  if (await quote.handle(arm, m)) {
    log.info({ arm: arm.name, id: m.key?.id }, 'handled by quote flow');
    return;
  }
  // 2. automatic listening to source groups
  // (Baileys may deliver live messages as "append" after its buffer is released, so filter by age instead)
  const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
  if (ts && Date.now() / 1000 - ts > 10 * 60) return;
  if (m.key?.fromMe) return;
  const groupJid = m.key?.remoteJid;
  if (!groupJid || !groupJid.endsWith('@g.us')) return;

  const source = state.sources.get(groupJid);
  if (!source) return;
  if (source.listen_arm_id && source.listen_arm_id !== arm.id) return;
  if (!state.settings.auto_distribution_enabled) return;

  const text = extractText(m.message);
  if (!text) return;
  const trigger = state.triggers.find((t) => containsKeyword(text, t.keyword));
  if (!trigger) return;

  // duplicate guard – the first arm to insert wins, everyone else stops here
  const { error: dupErr } = await db
    .from('processed_messages')
    .insert({ source_group_id: groupJid, message_id: m.key.id });
  if (dupErr) {
    if (dupErr.code !== '23505') log.error({ err: dupErr.message }, 'processed_messages insert failed');
    return;
  }

  if (!trigger.list_id) {
    await logActivity('help_no_list', 'trigger', trigger.id, { keyword: trigger.keyword, text });
    return;
  }

  const requester = await resolveRequester(arm, m);

  const [lg, la] = await Promise.all([
    db.from('list_groups').select('wa_group_id,group_name').eq('list_id', trigger.list_id),
    db.from('list_arms').select('arm_id').eq('list_id', trigger.list_id),
  ]);
  const targets = (lg.data || []).filter((g) => g.wa_group_id !== groupJid);
  let armIds = (la.data || []).map((r) => r.arm_id);
  if (!armIds.length) {
    const { data } = await db.from('arms').select('id').eq('is_active', true);
    armIds = (data || []).map((r) => r.id);
  }

  const { data: campaign, error } = await db
    .from('campaigns')
    .insert({
      kind: 'help',
      status: requester.phone ? 'queued' : 'pending_phone',
      message_text: text,
      requester_name: requester.name,
      requester_phone: requester.phone,
      requester_jid: requester.jid,
      source_group_id: groupJid,
      source_group_name: source.name,
      source_message_id: m.key.id,
      trigger_id: trigger.id,
      list_id: trigger.list_id,
      total: targets.length,
      trigger_key: { remoteJid: groupJid, id: m.key.id, participant: m.key.participant || undefined },
      trigger_arm_id: arm.id,
    })
    .select()
    .single();
  if (error) throw error;

  await arm.react({ remoteJid: groupJid, id: m.key.id, ...(m.key.participant ? { participant: m.key.participant } : {}) }, '⏳');

  if (armIds.length) {
    await db.from('campaign_arms').insert(armIds.map((arm_id) => ({ campaign_id: campaign.id, arm_id })));
  }
  for (let i = 0; i < targets.length; i += 500) {
    await db.from('campaign_targets').insert(
      targets.slice(i, i + 500).map((t) => ({
        campaign_id: campaign.id,
        wa_group_id: t.wa_group_id,
        group_name: t.group_name,
      })),
    );
  }
  await db
    .from('processed_messages')
    .update({ campaign_id: campaign.id })
    .eq('source_group_id', groupJid)
    .eq('message_id', m.key.id);

  await logActivity(requester.phone ? 'help_received' : 'help_pending_phone', 'campaign', campaign.id, {
    requester: requester.name,
    phone: requester.phone,
    source: source.name,
    targets: targets.length,
  });
  log.info({ campaign: campaign.id, phone: requester.phone, targets: targets.length }, 'help campaign created');
}

// Build the final text for help campaigns that have a phone but no text yet
async function prepareHelpCampaigns() {
  const { data, error } = await db
    .from('campaigns')
    .select('id,message_text,requester_phone,trigger_id')
    .eq('kind', 'help')
    .eq('status', 'queued')
    .is('final_text', null)
    .not('requester_phone', 'is', null)
    .limit(20);
  if (error || !data?.length) return;
  for (const c of data) {
    let trigger = null;
    let template = null;
    if (c.trigger_id) {
      trigger = (await db.from('triggers').select('*').eq('id', c.trigger_id).maybeSingle()).data;
      if (trigger?.template_id) {
        template = (await db.from('templates').select('*').eq('id', trigger.template_id).maybeSingle()).data;
      }
    }
    const final_text = buildHelpText({
      body: c.message_text,
      keyword: trigger?.keyword,
      strip: trigger?.strip_keyword ?? true,
      template,
      phone: c.requester_phone,
    });
    await db.from('campaigns').update({ final_text }).eq('id', c.id);
  }
}

// ✅ / ❌ on the original "עזרה" message once a help distribution has finished
async function reactFinished(armsMap) {
  const { data } = await db
    .from('campaigns')
    .select('id,status,sent,trigger_key,trigger_arm_id')
    .eq('kind', 'help')
    .eq('reacted', false)
    .not('trigger_key', 'is', null)
    .in('status', ['completed', 'cancelled', 'failed'])
    .limit(20);
  for (const c of data || []) {
    const arm = armsMap.get(c.trigger_arm_id);
    if (!arm?.online) continue;
    const emoji = c.status === 'cancelled' ? '' : c.sent > 0 ? '✅' : '❌';
    if (await arm.react(c.trigger_key, emoji)) await db.from('campaigns').update({ reacted: true }).eq('id', c.id);
  }
}

module.exports = { refreshConfig, onMessage, prepareHelpCampaigns, reactFinished };
