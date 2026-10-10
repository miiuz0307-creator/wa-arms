// Distribution from a quoted message:
// someone posts a ride in a group → operator replies to it (quote), tags the bot, writes "עזרה"
// → the bot opens a private chat with the operator: preview without the customer's phone,
//   numbered list of distribution lists, edit, "הפץ", live status.
const { db, log } = require('./config');
const { extractText, jidUser } = require('./util');

const { sanitize, verifyNoCustomerPhone, normalize, formatPhone, findPhones } = require('./phones');

const SESSION_TTL_MS = 30 * 60 * 1000;
const normJid = (j) => (j ? String(j).replace(/:\d+(?=@)/, '') : null);

let getTriggers = () => [];
function setTriggerSource(fn) {
  getTriggers = fn;
}
let getArms = () => new Map();
let isSourceGroup = () => true;
function setSourceGroupCheck(fn) {
  isSourceGroup = fn;
}
let getSettings = () => null;
function setSettingsSource(fn) {
  getSettings = fn;
}
function setArmsSource(fn) {
  getArms = fn;
}

function unwrap(message) {
  if (!message) return null;
  return (
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message
  );
}

function contextOf(msg) {
  return (
    msg?.extendedTextMessage?.contextInfo ||
    msg?.imageMessage?.contextInfo ||
    msg?.videoMessage?.contextInfo ||
    null
  );
}

// Private messages are disabled on purpose: requesters get only reactions on their "עזרה" message
// (⏳ received, ✅ distributed, ❌ not distributed). Details are on the website.
async function reply() {
  return true;
}

async function fail(arm, key, sessionId, reason) {
  if (key) await arm.react(key, '❌');
  await activity(arm.stationId, 'quote_blocked', sessionId, { reason });
}

async function activity(stationId, action, entityId, details) {
  await db.from('activity_log').insert({ actor_name: 'בוט', action, entity: 'quote', entity_id: entityId, details, station_id: stationId });
}

// ---------- operator identity & permission ----------

async function resolveOperator(arm, m) {
  const k = m.key || {};
  const ids = [k.participant, m.participant, k.participantPn, k.participantAlt, k.senderPn].filter(Boolean).map(normJid);
  const pnJid = ids.find((j) => j.endsWith('@s.whatsapp.net')) || null;
  const lid = ids.find((j) => j.endsWith('@lid')) || null;
  let phone = pnJid ? normalize(jidUser(pnJid)) : null;
  if (!phone && lid) {
    try {
      const pn = await arm.sock?.signalRepository?.lidMapping?.getPNForLID?.(lid);
      if (pn) phone = normalize(jidUser(pn));
    } catch {}
  }

  const st = arm.stationId;
  let op = null;
  if (lid) op = (await db.from('wa_operators').select('*').eq('station_id', st).eq('wa_lid', lid).maybeSingle()).data;
  if (!op && pnJid) op = (await db.from('wa_operators').select('*').eq('station_id', st).eq('wa_jid', pnJid).maybeSingle()).data;
  if (!op && phone) {
    const { data } = await db.from('wa_operators').select('*').eq('station_id', st).eq('phone', formatPhone(phone)).limit(1);
    op = data?.[0] || null;
  }

  const patch = {};
  if (op) {
    if (!op.wa_lid && lid) patch.wa_lid = lid;
    if (!op.wa_jid && pnJid) patch.wa_jid = pnJid;
    if (!op.phone && phone) patch.phone = formatPhone(phone);
    if (!op.name && m.pushName) patch.name = m.pushName;
    if (Object.keys(patch).length) {
      await db.from('wa_operators').update(patch).eq('id', op.id);
      Object.assign(op, patch);
    }
  } else {
    const { data } = await db
      .from('wa_operators')
      .insert({ station_id: st, name: m.pushName || null, phone: phone ? formatPhone(phone) : null, wa_jid: pnJid, wa_lid: lid, status: 'pending' })
      .select()
      .single();
    op = data;
  }
  // private chat target: prefer the phone JID (most reliable for sending)
  const chat = pnJid || (phone ? `${phone.replace(/^0/, '972')}@s.whatsapp.net` : null) || lid;
  const alt = lid && chat !== lid ? lid : pnJid && chat !== pnJid ? pnJid : null;
  return { op, chat, alt };
}

// ---------- menu rendering ----------

async function loadLists(stationId) {
  const { data } = await db.from('distribution_lists').select('id,name, list_groups(count)').eq('station_id', stationId).order('name');
  return (data || []).map((l) => ({ id: l.id, name: l.name, count: l.list_groups?.[0]?.count ?? 0 }));
}

async function selectedGroups(listIds, excludeGroup) {
  if (!listIds.length) return [];
  const { data } = await db.from('list_groups').select('wa_group_id,group_name').in('list_id', listIds);
  const map = new Map();
  for (const g of data || []) if (g.wa_group_id !== excludeGroup && !map.has(g.wa_group_id)) map.set(g.wa_group_id, g);
  return [...map.values()];
}

async function renderMenu(session, note) {
  const lists = await loadLists(session.station_id);
  const groups = await selectedGroups(session.selected_list_ids, session.source_group_id);
  const sel = new Set(session.selected_list_ids);
  const lines = [];
  if (note) lines.push(note, '');
  lines.push('🚕 *נסיעה להפצה*', '━━━━━━━━━━━━');
  lines.push(session.clean_text);
  lines.push('━━━━━━━━━━━━');
  if (session.removed_phones > 0) lines.push(`🔒 הוסרו ${session.removed_phones} מספרי טלפון של הלקוח`);
  else lines.push('🔒 לא נמצא מספר טלפון של לקוח בהודעה');
  if (session.needs_review) {
    lines.push('', `⚠️ *נדרש אישור ידני:* ${session.review_reason}`);
    lines.push('בדוק שלא נשאר מספר לקוח. אם תקין – כתוב *אשר*. אם לא – שלח *עריכה* עם הטקסט הנכון.');
  }
  lines.push('', '*בחר רשימות הפצה:*');
  if (!lists.length) lines.push('אין רשימות הפצה במערכת. צור רשימה בממשק הניהול.');
  lists.forEach((l, i) => lines.push(`${i + 1}. ${sel.has(l.id) ? '✅' : '⬜'} ${l.name} (${l.count})`));
  lines.push('', `📊 *נבחרו ${groups.length} קבוצות*`);
  lines.push(
    '',
    '_מספרים (למשל 1 3) – בחירה/ביטול_',
    '_*הכל* – בחר הכול · *נקה* – בטל הכול_',
    '_*עריכה* + הטקסט החדש – עריכת ההודעה_',
    '_*הפץ* – הפץ עכשיו · *ביטול* – ביטול_',
  );
  return { text: lines.join('\n'), lists, groups };
}

// ---------- group trigger ----------

// the message must be the trigger word alone ("עזרה"), nothing else besides tags, punctuation or emoji
function bareWords(text) {
  return String(text || '')
    .replace(/@\S+/g, ' ')
    .replace(/[\p{P}\p{S}\u200e\u200f\u202a-\u202e\ufe0f]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const CANCEL_WORDS = new Set(['ביטול', 'בטל', 'נ', 'נמכר', 'נמכרה']);

function sentByOtherArm(arm, m) {
  if (m.key?.fromMe) return null;
  const k = m.key || {};
  const senderIds = [k.participant, m.participant, k.participantPn, k.participantAlt, k.senderPn].filter(Boolean).map(normJid);
  for (const other of getArms().values()) {
    if (other !== arm && other.stationId === arm.stationId && other.ownJids().some((j) => senderIds.includes(j))) return other;
  }
  return null;
}

function keyOf(m, op) {
  const fromMe = !!m.key.fromMe;
  const pn = fromMe ? null : op?.wa_jid || [m.key.participantPn, m.key.participantAlt].find((j) => j?.endsWith('@s.whatsapp.net')) || null;
  return {
    remoteJid: m.key.remoteJid,
    id: m.key.id,
    fromMe,
    ...(m.key.participant ? { participant: m.key.participant } : {}),
    ...(pn ? { participantPn: pn } : {}),
  };
}

// Reply to the ride or to the "עזרה" message with ביטול / נ / נמכר → stop that distribution
async function handleCancel(arm, m, ctx) {
  const quotedId = ctx.stanzaId;
  if (!quotedId) return false;
  const groupJid = m.key.remoteJid;

  // find an active distribution started from that message (quoted ride or the "עזרה" reply)
  const idq = `"${String(quotedId).replace(/"/g, '')}"`;
  const { data: sessions } = await db
    .from('quote_sessions')
    .select('id,campaign_id,trigger_key,status')
    .eq('station_id', arm.stationId)
    .eq('source_group_id', groupJid)
    .or(`source_message_id.eq.${idq},trigger_key->>id.eq.${idq}`)
    .order('created_at', { ascending: false })
    .limit(5);
  const { data: helps } = await db
    .from('campaigns')
    .select('id,status,trigger_key')
    .eq('station_id', arm.stationId)
    .eq('kind', 'help')
    .eq('source_group_id', groupJid)
    .eq('source_message_id', quotedId)
    .limit(5);
  const campaignIds = [...(sessions || []).map((s) => s.campaign_id), ...(helps || []).map((c) => c.id)].filter(Boolean);
  if (!campaignIds.length) return false; // not a reply to a distribution – let other handlers see it

  if (sentByOtherArm(arm, m)) return true;
  const { error: dupErr } = await db.from('processed_messages').insert({ station_id: arm.stationId, source_group_id: groupJid, message_id: `x:${m.key.id}` });
  if (dupErr) return true; // another arm handles it

  let op = null;
  if (!m.key.fromMe) {
    op = (await resolveOperator(arm, m)).op;
    // same rule as for "עזרה": in "anyone in the group" mode everyone except blocked numbers may cancel
    const open = !!getSettings(arm.stationId)?.open_trigger;
    if (!op || op.status === 'blocked' || (op.status !== 'approved' && !open)) {
      await activity(arm.stationId, 'quote_cancel_denied', op?.id || null, { name: m.pushName, group: groupJid });
      return true;
    }
  }

  const { data: stopped } = await db
    .from('campaigns')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .in('id', campaignIds)
    .in('status', ['queued', 'running', 'pending_phone'])
    .select('id,sent,total');
  const cancelKey = keyOf(m, op);
  if (!stopped?.length) {
    log.info({ arm: arm.name }, 'cancel: distribution already finished');
    await arm.react(cancelKey, '🤷');
    return true;
  }
  const ids = stopped.map((c) => c.id);
  await db
    .from('campaign_targets')
    .update({ status: 'skipped', error: 'ההפצה בוטלה' })
    .in('campaign_id', ids)
    .eq('status', 'pending');
  await db.from('campaigns').update({ reacted: true }).in('id', ids).eq('kind', 'help');
  await db
    .from('quote_sessions')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .in('campaign_id', ids);

  const triggerKeys = [
    ...(sessions || []).filter((s) => ids.includes(s.campaign_id)).map((s) => s.trigger_key),
    ...(helps || []).filter((c) => ids.includes(c.id)).map((c) => c.trigger_key),
  ].filter(Boolean);
  for (const k of triggerKeys) await arm.react(k, '🛑');
  await arm.react(cancelKey, '👍');
  await activity(arm.stationId, 'quote_cancelled', ids[0], {
    by: op?.name || m.pushName || 'אני',
    word: bareWords(extractText(unwrap(m.message))),
    sent_before_stop: stopped.reduce((a, c) => a + (c.sent || 0), 0),
  });
  log.info({ arm: arm.name, campaigns: ids }, 'distribution cancelled from WhatsApp');
  return true;
}

async function handleGroup(arm, m) {
  const msg = unwrap(m.message);
  const ctx = contextOf(msg);
  if (!ctx?.quotedMessage) return false;

  // Only the station's own operator groups (Settings → help → source groups). Everywhere else
  // "עזרה" / "ביטול" are ordinary messages and the arm ignores them.
  if (!isSourceGroup(arm.stationId, m.key.remoteJid)) return false;

  const text = extractText(msg);
  const words = bareWords(text);
  // "נננ" / "ביטולל" count too (repeated letters collapsed)
  if (CANCEL_WORDS.has(words) || CANCEL_WORDS.has(words.replace(/(.)\1+/g, '$1'))) return handleCancel(arm, m, ctx);

  const trigger = getTriggers(arm.stationId).find((t) => words === bareWords(t.keyword));
  if (!trigger) {
    log.info({ arm: arm.name, text: text.slice(0, 40) }, 'quote: not exactly a trigger word');
    return false;
  }

  const groupJid = m.key.remoteJid;
  const fromMe = !!m.key.fromMe;

  // No tagging needed. If the sender is one of our own arms, that arm handles it (as "fromMe").
  const other = sentByOtherArm(arm, m);
  if (other) {
    log.info({ arm: arm.name, other: other.name }, 'quote: sent by another arm, it will handle');
    return true;
  }

  // Several arms see the same message – only the first one handles it.
  // (a database hiccup must not swallow the request – try again for up to ~40 seconds)
  let dupErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    ({ error: dupErr } = await db.from('processed_messages').insert({ station_id: arm.stationId, source_group_id: groupJid, message_id: `q:${m.key.id}` }));
    if (!dupErr || dupErr.code === '23505') break;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (dupErr) {
    if (dupErr.code !== '23505') log.error({ err: dupErr.message }, 'quote dedupe insert failed');
    else log.info({ arm: arm.name }, 'quote: already handled by another arm');
    return true;
  }

  let chat;
  let alt = null;
  let op = null;
  let opName;
  let opPhone;

  if (fromMe) {
    // the operator is the arm's own phone – talk in "message yourself"
    chat = normJid(arm.sock?.user?.id);
    alt = normJid(arm.sock?.user?.lid) || null;
    opName = 'אני';
    opPhone = normalize(jidUser(chat));
  } else {
    const r = await resolveOperator(arm, m);
    op = r.op;
    chat = r.chat;
    alt = r.alt;
    // "open" mode (station setting): anyone in the group may trigger, except blocked numbers.
    // Otherwise only approved numbers – others are ignored silently.
    const open = !!getSettings(arm.stationId)?.open_trigger;
    if (!op || op.status === 'blocked' || (op.status !== 'approved' && !open)) {
      if (op?.status === 'pending') await activity(arm.stationId, 'quote_operator_pending', op.id, { name: m.pushName, group: groupJid });
      return false;
    }
    opName = op?.name || m.pushName || 'מבקש';
    opPhone = op?.phone ? normalize(op.phone) : null;
  }
  if (!chat) return true;

  // ⏳ on the "עזרה" message: request received
  const pnParticipant = fromMe ? null : op?.wa_jid || [m.key.participantPn, m.key.participantAlt].find((j) => j?.endsWith('@s.whatsapp.net')) || null;
  const triggerKey = {
    remoteJid: groupJid,
    id: m.key.id,
    fromMe,
    ...(m.key.participant ? { participant: m.key.participant } : {}),
    ...(pnParticipant ? { participantPn: pnParticipant } : {}),
  };
  await arm.react(triggerKey, '⏳');

  const original = extractText(unwrap(ctx.quotedMessage));
  if (!original) {
    await fail(arm, triggerKey, null, 'בהודעה המצוטטת אין טקסט');
    return true;
  }

  // template (same as the trigger's template), operator phone allowed to stay
  let template = null;
  if (trigger.template_id) template = (await db.from('templates').select('*').eq('id', trigger.template_id).maybeSingle()).data;
  // no template set → still add the requester's number
  if (!template) template = { prefix: '', suffix: '📞 לבקשה במספר: {PHONE}' };
  // Every phone in the ride itself is removed (even if it equals the number written in the template).
  // Numbers written in the template are added afterwards and allowed only there.
  const templatePhones = findPhones(`${template?.prefix || ''}\n${template?.suffix || ''}`).map((p) => p.digits);
  const s = sanitize(original, { allow: opPhone ? [opPhone] : [] });
  // the quoted message must be an actual ride, not just a word
  const bare = s.text.replace(/[\s\p{P}\p{S}]/gu, '');
  if (bare.length < 6 || getTriggers(arm.stationId).some((t) => s.text.trim() === t.keyword)) {
    log.info({ arm: arm.name, text: s.text.slice(0, 30) }, 'quote: quoted text is not a ride, ignored');
    await arm.react(triggerKey, '');
    return true;
  }
  const phoneShown = opPhone ? formatPhone(opPhone) : '';
  const fill = (x) => (phoneShown ? (x || '').split('{PHONE}').join(phoneShown) : x || '');
  const parts = [];
  if (template?.prefix?.trim()) parts.push(fill(template.prefix).trim());
  parts.push(s.text);
  if (template?.suffix?.trim()) parts.push(fill(template.suffix).trim());
  const clean = parts.join('\n\n');

  const reasons = [];
  if (s.suspicious.length) reasons.push(`נמצא רצף מספרים שעשוי להיות טלפון: ${s.suspicious.join(', ')}`);
  if (!s.text.trim()) reasons.push('אחרי הסרת המספרים לא נשאר טקסט');
  if (clean.includes('{PHONE}')) reasons.push('לא זיהיתי את המספר שלך. שלח *מספר* ואחריו המספר שלך, למשל: מספר 050-1234567');

  // cancel older open session in this chat
  await db
    .from('quote_sessions')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('arm_id', arm.id)
    .eq('chat_jid', chat)
    .eq('status', 'selecting');

  const quotedId = ctx.stanzaId || null;
  if (quotedId) {
    // the same ride is still being distributed, or was fully distributed in the last 30 minutes → don't send it twice.
    // A cancelled distribution can be started again.
    const { data: prev } = await db
      .from('quote_sessions')
      .select('campaign_id')
      .eq('station_id', arm.stationId)
      .eq('source_message_id', quotedId)
      .not('campaign_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(5);
    const ids = (prev || []).map((p) => p.campaign_id);
    if (ids.length) {
      const { data: camps } = await db.from('campaigns').select('id,status,finished_at').in('id', ids);
      const busy = (camps || []).find(
        (c) => ['queued', 'running'].includes(c.status) || (c.status === 'completed' && Date.now() - new Date(c.finished_at).getTime() < 30 * 60 * 1000),
      );
      if (busy) {
        log.info({ arm: arm.name, campaign: busy.id, status: busy.status }, 'quote: this ride was already distributed');
        await arm.react(triggerKey, '🔁');
        await activity(arm.stationId, 'quote_duplicate', busy.id, { operator: opName });
        return true;
      }
    }
  }

  // target lists: the trigger's list if set, otherwise every distribution list
  let listIds = trigger.list_id ? [trigger.list_id] : [];
  if (!listIds.length) {
    const { data: all } = await db.from('distribution_lists').select('id').eq('station_id', arm.stationId);
    listIds = (all || []).map((l) => l.id);
  }

  const { data: groupRow } = await db.from('groups').select('name').eq('station_id', arm.stationId).eq('wa_group_id', groupJid).limit(1);
  const { data: session, error } = await db
    .from('quote_sessions')
    .insert({
      arm_id: arm.id,
      chat_jid: chat,
      chat_alt_jid: alt,
      operator_id: op?.id || null,
      operator_name: opName,
      operator_phone: phoneShown || null,
      is_self: fromMe,
      source_group_id: groupJid,
      source_group_name: groupRow?.[0]?.name || null,
      source_message_id: quotedId,
      trigger_key: triggerKey,
      original_text: original,
      clean_text: clean,
      removed_phones: s.removed.length,
      needs_review: reasons.length > 0,
      review_reason: reasons.join(' · ') || null,
      selected_list_ids: listIds,
    })
    .select()
    .single();
  if (error) throw error;
  await activity(arm.stationId, 'quote_received', session.id, { operator: opName, group: session.source_group_name, removed: s.removed.length });

  // safe and complete → send right away, no questions
  if (!reasons.length) {
    return distribute(arm, chat, session, [...(phoneShown ? [phoneShown] : []), ...templatePhones], { quiet: true });
  }

  // something is missing (requester phone unknown / possible customer phone left) → not sent, ❌
  await update(session, { status: 'cancelled' });
  await fail(arm, triggerKey, session.id, session.review_reason);
  return true;
}

// ---------- private chat commands ----------

async function findSession(arm, chat) {
  const { data } = await db
    .from('quote_sessions')
    .select('*')
    .eq('arm_id', arm.id)
    .or(`chat_jid.eq."${chat}",chat_alt_jid.eq."${chat}"`)
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

async function update(session, patch) {
  const { data } = await db
    .from('quote_sessions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', session.id)
    .select()
    .single();
  return data || { ...session, ...patch };
}

async function statusText(session) {
  if (!session.campaign_id) return null;
  const { data: rows } = await db.from('campaign_targets').select('status').eq('campaign_id', session.campaign_id);
  const c = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of rows || []) c[r.status] = (c[r.status] || 0) + 1;
  const total = (rows || []).length;
  return [
    `📊 *סטטוס הפצה* (${total} קבוצות)`,
    `⏳ ממתין: ${c.pending}`,
    `📤 שולח: ${c.sending}`,
    `✅ נשלח בהצלחה: ${c.sent}`,
    `❌ נכשל: ${c.failed}`,
  ].join('\n');
}

async function handleDM(arm, m) {
  const chat = normJid(m.key.remoteJid);
  const selfChats = [normJid(arm.sock?.user?.id), normJid(arm.sock?.user?.lid)].filter(Boolean);
  const isSelfChat = selfChats.includes(chat);
  if (m.key.fromMe && !isSelfChat) return false; // our own outgoing messages in someone's chat

  const raw = extractText(unwrap(m.message));
  if (!raw) return false;
  const text = raw.trim();

  let session = await findSession(arm, chat);
  if (!session) return false;

  const cmd = text.split('\n')[0].trim().replace(/[!.]+$/, '');

  if (/^(סטטוס|מצב)$/.test(cmd)) {
    const st = await statusText(session);
    await reply(arm, chat, st || 'אין עדיין הפצה פעילה.');
    return true;
  }

  if (session.status !== 'selecting') return false;

  if (Date.now() - new Date(session.updated_at).getTime() > SESSION_TTL_MS) {
    await update(session, { status: 'expired' });
    await reply(arm, chat, '⌛ פג תוקף הבקשה (30 דקות בלי פעילות). צטט את הנסיעה שוב וכתוב עזרה.');
    return true;
  }

  const allow = session.operator_phone ? [session.operator_phone] : [];

  if (/^(ביטול|בטל)$/.test(cmd)) {
    await update(session, { status: 'cancelled' });
    if (session.trigger_key) await arm.react(session.trigger_key, '');
    await reply(arm, chat, '❎ ההפצה בוטלה. לא נשלח כלום.');
    return true;
  }

  if (/^(הכל|הכול|בחר הכל|בחר הכול)$/.test(cmd)) {
    const lists = await loadLists(session.station_id);
    session = await update(session, { selected_list_ids: lists.map((l) => l.id) });
    await reply(arm, chat, (await renderMenu(session)).text);
    return true;
  }

  if (/^(נקה|בטל הכל|בטל הכול)$/.test(cmd)) {
    session = await update(session, { selected_list_ids: [] });
    await reply(arm, chat, (await renderMenu(session)).text);
    return true;
  }

  if (/^(תצוגה|תצוגה מקדימה|תפריט)$/.test(cmd)) {
    await reply(arm, chat, (await renderMenu(session)).text);
    return true;
  }

  if (/^עריכה/.test(text)) {
    const newText = text.replace(/^עריכה[:\s]*/, '').trim();
    if (!newText) {
      await reply(arm, chat, '✏️ כדי לערוך, שלח *עריכה* ובשורות הבאות את הטקסט המלא החדש.');
      return true;
    }
    const s = sanitize(newText, { allow });
    const reasons = [];
    if (s.suspicious.length) reasons.push(`נמצא רצף מספרים שעשוי להיות טלפון: ${s.suspicious.join(', ')}`);
    session = await update(session, {
      clean_text: s.text,
      removed_phones: session.removed_phones + s.removed.length,
      needs_review: reasons.length > 0,
      review_reason: reasons.join(' · ') || null,
    });
    const note = s.removed.length ? `✏️ הטקסט עודכן. הוסרו עוד ${s.removed.length} מספרי טלפון.` : '✏️ הטקסט עודכן.';
    await reply(arm, chat, (await renderMenu(session, note)).text);
    return true;
  }

  const phoneCmd = cmd.match(/^(?:מספר|הטלפון שלי|טלפון)?[:\s]*(\+?[\d\s\-]{9,16})$/);
  if (phoneCmd && phoneCmd[1].replace(/\D/g, '').length >= 9) {
    const p = normalize(phoneCmd[1]);
    if (!/^0\d{8,9}$/.test(p)) {
      await reply(arm, chat, '⚠️ המספר לא תקין. נסה שוב, למשל: מספר 050-1234567');
      return true;
    }
    const shown = formatPhone(p);
    const newText = session.clean_text.split('{PHONE}').join(shown);
    const reasons = (session.review_reason || '')
      .split(' · ')
      .filter((r) => r && !r.startsWith('לא זיהיתי את המספר שלך'));
    session = await update(session, {
      operator_phone: shown,
      clean_text: newText,
      needs_review: reasons.length > 0,
      review_reason: reasons.join(' · ') || null,
    });
    if (session.operator_id) await db.from('wa_operators').update({ phone: shown }).eq('id', session.operator_id);
    if (!session.needs_review && session.selected_list_ids.length) {
      await reply(arm, chat, `📞 המספר שלך נשמר: ${shown}. מפיץ עכשיו.`);
      return distribute(arm, chat, session, [shown], { quiet: true });
    }
    await reply(arm, chat, (await renderMenu(session, `📞 המספר שלך נשמר: ${shown}`)).text);
    return true;
  }

  if (/^אשר$/.test(cmd)) {
    if (!session.needs_review) {
      await reply(arm, chat, 'אין מה לאשר. כתוב *הפץ* כדי לשלוח.');
      return true;
    }
    if (session.clean_text.includes('{PHONE}')) {
      await reply(arm, chat, 'קודם שלח את המספר שלך: *מספר* ואחריו המספר, למשל: מספר 050-1234567');
      return true;
    }
    session = await update(session, { needs_review: false, review_reason: null });
    await activity(arm.stationId, 'quote_manual_approved', session.id, { operator: session.operator_name });
    if (session.selected_list_ids.length) {
      await reply(arm, chat, '👍 אושר. מפיץ עכשיו.');
      return distribute(arm, chat, session, allow, { quiet: true });
    }
    await reply(arm, chat, (await renderMenu(session, '👍 אושר ידנית.')).text);
    return true;
  }

  if (/^[\d\s,،.]+$/.test(cmd)) {
    const lists = await loadLists(session.station_id);
    const sel = new Set(session.selected_list_ids);
    const bad = [];
    for (const n of cmd.split(/[\s,،.]+/).filter(Boolean).map(Number)) {
      const l = lists[n - 1];
      if (!l) bad.push(n);
      else if (sel.has(l.id)) sel.delete(l.id);
      else sel.add(l.id);
    }
    session = await update(session, { selected_list_ids: [...sel] });
    await reply(arm, chat, (await renderMenu(session, bad.length ? `⚠️ אין מספר ${bad.join(', ')} בתפריט.` : null)).text);
    return true;
  }

  if (/^(הפץ|הפץ עכשיו|שלח|הפצה)$/.test(cmd)) {
    return distribute(arm, chat, session, allow);
  }

  await reply(arm, chat, 'לא הבנתי 🙂 אפשר: מספרים לבחירה, *הכל*, *נקה*, *עריכה*, *הפץ*, *ביטול*, *סטטוס*.');
  return true;
}

async function distribute(arm, chat, session, allow, opts = {}) {
  if (!session.selected_list_ids.length) {
    await fail(arm, session.trigger_key, session.id, '⚠️ לא נבחרה אף רשימה. שלח מספר מהתפריט או *הכל*.');
    return true;
  }
  if (session.clean_text.includes('{PHONE}')) {
    await fail(arm, session.trigger_key, session.id, '⛔ חסר המספר שלך בהודעה. שלח *מספר* ואחריו המספר שלך, למשל: מספר 050-1234567');
    return true;
  }
  if (session.needs_review) {
    await fail(arm, session.trigger_key, session.id, session.review_reason);
    return true;
  }
  // final safety check – no customer phone may leave
  const problems = verifyNoCustomerPhone(session.clean_text, allow);
  if (problems.length) {
    await update(session, { needs_review: true, review_reason: `נשאר מספר טלפון בטקסט: ${problems.join(', ')}` });
    await fail(arm, session.trigger_key, session.id, `נשאר מספר טלפון בטקסט: ${problems.join(', ')}`);
    return true;
  }

  const groups = await selectedGroups(session.selected_list_ids, session.source_group_id);
  if (!groups.length) {
    await fail(arm, session.trigger_key, session.id, '⚠️ ברשימות שנבחרו אין קבוצות.');
    return true;
  }
  const { data: la } = await db.from('list_arms').select('arm_id').in('list_id', session.selected_list_ids);
  let armIds = [...new Set((la || []).map((r) => r.arm_id))];
  if (!armIds.length) {
    const { data } = await db.from('arms').select('id').eq('station_id', arm.stationId).eq('is_active', true);
    armIds = (data || []).map((r) => r.id);
  }
  // all the station's arms join; the database hands out the work like a ladder
  // (each arm on its own ride under load, all arms on one ride when it's the only one)
  const plan = { armIds, exclude: () => [] };

  const { data: campaign, error } = await db
    .from('campaigns')
    .insert({
      station_id: arm.stationId,
      kind: 'quote',
      status: 'queued',
      message_text: session.original_text,
      // the text is set only after all groups are added: a campaign without text is not
      // picked up or closed yet (before, it could be marked "completed" with 0 groups)
      final_text: null,
      requester_name: session.operator_name,
      requester_phone: session.operator_phone,
      source_group_id: session.source_group_id,
      source_group_name: session.source_group_name,
      source_message_id: session.source_message_id,
      total: groups.length,
    })
    .select()
    .single();
  if (error) {
    await fail(arm, session.trigger_key, session.id, `שגיאה ביצירת ההפצה: ${error.message}`);
    return true;
  }
  const insertWithRetry = async (table, rows) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error: e } = await db.from(table).insert(rows);
      if (!e) return null;
      if (e.code === '23505') return null; // already there
      if (attempt === 3) return e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  };
  let insErr = await insertWithRetry('campaign_arms', armIds.map((arm_id) => ({ campaign_id: campaign.id, arm_id })));
  for (let i = 0; !insErr && i < groups.length; i += 500) {
    insErr = await insertWithRetry(
      'campaign_targets',
      groups.slice(i, i + 500).map((g) => ({
        campaign_id: campaign.id,
        wa_group_id: g.wa_group_id,
        group_name: g.group_name,
        tried_arms: plan.exclude(g.wa_group_id),
      })),
    );
  }
  if (insErr) {
    log.error({ arm: arm.name, err: insErr.message }, 'quote: adding groups failed');
    await db.from('campaigns').update({ status: 'failed', finished_at: new Date().toISOString() }).eq('id', campaign.id);
    await fail(arm, session.trigger_key, session.id, `שגיאה בהוספת הקבוצות: ${insErr.message}`);
    return true;
  }
  // now it may start
  await db.from('campaigns').update({ final_text: session.clean_text }).eq('id', campaign.id);
  await update(session, { status: 'sending', campaign_id: campaign.id });
  await activity(arm.stationId, 'quote_distributed', session.id, { campaign: campaign.id, groups: groups.length, arms: armIds.length });
  if (!opts.quiet) {
    await reply(
      arm,
      chat,
      `🚀 *ההפצה התחילה*\n${groups.length} קבוצות דרך ${armIds.length} זרועות.\nאעדכן כשהיא תסתיים. בכל רגע אפשר לכתוב *סטטוס*.`,
    );
  }
  return true;
}

// ---------- completion notices ----------

async function notifyFinished(armsMap) {
  const { data: sessions } = await db.from('quote_sessions').select('*').eq('status', 'sending').limit(20);
  for (const s of sessions || []) {
    if (!s.campaign_id) continue;
    const { data: c } = await db.from('campaigns').select('status,sent,failed,total').eq('id', s.campaign_id).single();
    if (!c || !['completed', 'cancelled', 'failed'].includes(c.status)) continue;
    const arm = armsMap.get(s.arm_id);
    if (!arm?.online) continue; // try again when that arm is back
    const { data: failed } = await db
      .from('campaign_targets')
      .select('group_name,wa_group_id,error')
      .eq('campaign_id', s.campaign_id)
      .eq('status', 'failed')
      .limit(10);
    const lines = [
      c.status === 'completed' ? '✅ *ההפצה הסתיימה*' : '⏹️ *ההפצה הופסקה*',
      `נשלח בהצלחה: ${c.sent}/${c.total}`,
      `נכשל: ${c.failed}`,
    ];
    if (failed?.length) {
      lines.push('', '*קבוצות שנכשלו:*');
      for (const f of failed) lines.push(`• ${f.group_name || f.wa_group_id} – ${f.error || 'שגיאה'}`);
      if (c.failed > failed.length) lines.push(`ועוד ${c.failed - failed.length}…`);
    }
    if (s.trigger_key) await arm.react(s.trigger_key, c.sent > 0 ? '✅' : '❌');
    if (await reply(arm, s.chat_jid, lines.join('\n'))) {
      await db.from('quote_sessions').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', s.id);
    }
  }
}

/** Returns true when the message belonged to the quote flow (so other handlers skip it). */
async function handle(arm, m) {
  if (arm.isOwnSent(m.key?.id)) return true;
  // ignore old messages replayed after a reconnect
  const ts = Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0);
  if (ts && Date.now() / 1000 - ts > 10 * 60) {
    const mm = unwrap(m.message);
    if (contextOf(mm)?.quotedMessage) log.info({ arm: arm.name, ageMin: Math.round((Date.now() / 1000 - ts) / 60) }, 'quote: message too old, ignored');
    return false;
  }
  const jid = m.key?.remoteJid || '';
  if (jid.endsWith('@g.us')) return handleGroup(arm, m);
  // private chats are not used (no menu, no commands)
  return false;
}

module.exports = { handle, notifyFinished, setTriggerSource, setArmsSource, setSettingsSource, setSourceGroupCheck, renderMenu };
