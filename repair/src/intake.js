// Incoming WhatsApp messages → commands or new tickets.
// Only numbers on the allowed list are served. Text is never executed: it is matched against a
// fixed set of commands, and anything else becomes a problem description for Claude to read.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./messages');
const { formatLocal } = require('./phones');

const IMAGE_WINDOW_MS = 3 * 60_000;
const MAX_TICKETS_PER_HOUR = 10;
const SESSION_MS = 30 * 60_000; // a conversation stays open 30 minutes after the last message

// Explicit commands that carry a ticket number or approval code always work for approved numbers
// (the bot asked for them). Anything else is answered only inside a conversation opened by "עזרה".
const ALWAYS = new Set(['help', 'help_text', 'approve', 'reject', 'cancel', 'rollback', 'show']);
// a button tap from an earlier menu also works after the conversation timed out

function parseCommand(raw) {
  const t = String(raw || '')
    .replace(/[֑-ׇ]/g, '') // niqqud
    .replace(/[*_~]/g, '')
    .trim();
  let m;
  if (/^(עזרה|תפריט|help|\?)$/i.test(t)) return { cmd: 'help' };
  // a tapped menu button arrives as its id; typing the menu number does the same
  if (t === 'menu:report') return { cmd: 'menu_report', button: true };
  if (t === 'menu:human') return { cmd: 'menu_human', button: true };
  if (t === '1') return { cmd: 'menu_report' };
  if (t === '2') return { cmd: 'menu_human' };
  if (/^(פקודות|commands)$/i.test(t)) return { cmd: 'commands' };
  if ((m = /^עזרה[\s,:.!-]+([\s\S]{4,})$/.exec(t))) return { cmd: 'help_text', text: m[1].trim() };
  if (/^(סטטוס|מצב)$/.test(t)) return { cmd: 'status' };
  if (/^(פניות|רשימה)$/.test(t)) return { cmd: 'list' };
  if ((m = /^פני(?:י)?ה\s*#?(\d+)$/.exec(t))) return { cmd: 'show', id: Number(m[1]) };
  if ((m = /^אשר\s*(\d{6})$/.exec(t))) return { cmd: 'approve', code: m[1] };
  if (/^אשר(\s|$)/.test(t) && t.length < 20) return { cmd: 'approve_nocode' };
  if ((m = /^דחה\s*#?(\d+)$/.exec(t))) return { cmd: 'reject', id: Number(m[1]) };
  if ((m = /^בטל\s*#?(\d+)$/.exec(t))) return { cmd: 'cancel', id: Number(m[1]) };
  if ((m = /^החזר\s*#?(\d+)$/.exec(t))) return { cmd: 'rollback', id: Number(m[1]) };
  return { cmd: 'text', text: t };
}

function createIntake({ cfg, store, wa, pipeline, log }) {
  const sessions = new Map(); // approved phone -> last activity
  const inSession = (phone) => Date.now() - (sessions.get(phone) || 0) < SESSION_MS;
  const touch = (phone) => phone && sessions.set(phone, Date.now());
  const recentTickets = new Map(); // phone -> timestamps

  async function findSender(phone, lid) {
    const list = (await store.listNumbers()).filter((n) => n.active);
    let n = (phone && list.find((x) => x.phone === phone)) || (lid && list.find((x) => x.lid === lid)) || null;
    if (n && lid && n.lid !== lid) n = await store.updateNumber(n.id, { lid });
    return n;
  }

  async function denied(jid, actor, what, ticketId = null) {
    await pipeline.audit(ticketId, actor, 'unauthorized_command', `ניסיון לבצע "${what}" בלי הרשאת מאשר`);
    return reply(jid, M.approverOnly);
  }

  const reply = (jid, text) => wa.send(jid, text).catch((e) => log.warn({ err: e.message }, 'reply failed'));

  async function saveImage(image) {
    const dir = path.join(cfg.dataDir, 'media');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700); // the runner user must not read other tickets' screenshots
    const ext = /png/.test(image.mimetype) ? '.png' : /webp/.test(image.mimetype) ? '.webp' : '.jpg';
    const file = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(dir, file), image.buffer);
    return { file, mimetype: image.mimetype, at: new Date().toISOString() };
  }

  async function queuePosition(id) {
    const open = await store.listTickets(100, ['queued', ...pipeline.ACTIVE]);
    return open.filter((t) => t.id < id).length;
  }

  async function handle({ jid, phone, lid, name, text, image }) {
    const sender = await findSender(phone, lid);
    if (!sender) {
      const who = phone || `lid:${lid}`;
      log.warn({ from: phone ? `${phone.slice(0, 5)}***${phone.slice(-2)}` : null, lid: Boolean(lid) }, 'message from a number that is not on the approved list');
      // only someone who writes "עזרה" gets attention – and only approved numbers at all
      if (/^\s*עזרה/.test(text || '')) {
        await pipeline.audit(null, who, 'rejected_sender', `"עזרה" ממספר לא מאושר (${phone ? formatLocal(phone) : 'מספר מוסתר'})`, { phone, lid, name });
      }
      return; // never answer strangers
    }
    const actor = sender.phone;
    const isApprover = sender.role === 'approver';
    const displayName = sender.name || name || formatLocal(actor);
    const c = parseCommand(text);
    if (!ALWAYS.has(c.cmd) && !c.button && !inSession(actor)) return; // not talking to the bot – ignore
    touch(actor);

    // ---- screenshots ----
    if (image && typeof image.load === 'function') image = await image.load();
    if (image) {
      if (image.tooBig || image.failed || !image.buffer) {
        return reply(jid, image.tooBig ? 'התמונה גדולה מדי (מעל 8MB). שלחו צילום מסך רגיל.' : 'לא הצלחתי להוריד את התמונה. נסו לשלוח שוב.');
      }
      const saved = await saveImage(image);
      if (!c.text || c.cmd !== 'text') {
        const open = (await store.listTickets(10, ['queued'])).find(
          (t) => t.requester_phone === actor && Date.now() - new Date(t.created_at).getTime() < IMAGE_WINDOW_MS,
        );
        if (open) {
          const t = await store.updateTicket(open.id, { images: [...(open.images || []), saved] });
          await pipeline.audit(t.id, actor, 'image_attached', 'צורף צילום מסך');
          return reply(jid, M.imageAttached(t));
        }
      }
      return createTicket(jid, actor, displayName, c.text || 'צילום מסך ללא תיאור – יש להבין את התקלה מהתמונה.', [saved]);
    }

    switch (c.cmd) {
      case 'help':
        if (jid.endsWith('@g.us')) return reply(jid, M.help(isApprover));
        return wa.sendButtons(jid, M.menu(), M.MENU).catch((e) => log.warn({ err: e.message }, 'reply failed'));
      case 'commands':
        return reply(jid, M.help(isApprover));
      case 'menu_report':
        return reply(jid, M.askReport);
      case 'menu_human': {
        // hand the chat to a person: the bot stays silent until "עזרה" is written again
        sessions.delete(actor);
        await pipeline.audit(null, actor, 'human_requested', `${displayName} ביקש לדבר עם נציג`);
        await reply(jid, M.toHuman);
        const approvers = (await store.listNumbers()).filter((n) => n.active && n.role === 'approver' && n.phone !== actor);
        for (const a of approvers) await reply(a.phone, M.humanRequested(displayName, formatLocal(actor)));
        return;
      }
      case 'help_text':
        return createTicket(jid, actor, displayName, c.text, []);
      case 'status': {
        const open = await store.listTickets(10, ['queued', 'awaiting_approval', 'blocked', ...pipeline.ACTIVE]);
        return reply(jid, open.length ? `*פניות פתוחות:*\n${open.map(M.statusLine).join('\n')}` : 'אין פניות פתוחות כרגע. ✅');
      }
      case 'list': {
        const all = await store.listTickets(5);
        return reply(jid, all.length ? `*5 הפניות האחרונות:*\n${all.map(M.statusLine).join('\n')}` : 'עוד אין פניות.');
      }
      case 'show': {
        const t = await store.getTicket(c.id);
        if (!t) return reply(jid, M.notFound(c.id));
        if (t.status === 'awaiting_approval' && isApprover) {
          await pipeline.audit(t.id, actor, 'approval_reissued', 'התבקש קוד אישור חדש');
          return pipeline.reissueApproval(t.id);
        }
        return reply(jid, M.ticketDetails(t));
      }
      case 'approve':
        if (!isApprover) return denied(jid, actor, 'אשר');
        {
          const r = await pipeline.approve(actor, c.code, displayName);
          if (r) await reply(jid, r);
        }
        return;
      case 'approve_nocode':
        return reply(jid, isApprover ? 'כדי לאשר שלחו *אשר* ואחריו הקוד בן 6 הספרות מהודעת הסיכום.' : M.approverOnly);
      case 'reject':
        if (!isApprover) return denied(jid, actor, 'דחה', c.id);
        return reply(jid, await pipeline.reject(actor, c.id));
      case 'cancel':
        return reply(jid, await pipeline.cancel(actor, c.id, { isApprover }));
      case 'rollback': {
        if (!isApprover) return denied(jid, actor, 'החזר', c.id);
        await pipeline.audit(c.id, actor, 'rollback_requested', `${displayName} ביקש לחזור לגרסה הקודמת`);
        await reply(jid, `↩️ מחזיר את השרת הפעיל לגרסה שלפני פנייה #${c.id}…`);
        const r = await pipeline.rollback(actor, c.id);
        if (r) await reply(jid, r);
        return;
      }
      default:
        // in the command group people also chat ("תודה", "אוקיי") – only real descriptions open a ticket
        if (jid.endsWith('@g.us') && c.text.length < 8) return;
        if (c.text.length < 4) return reply(jid, M.tooShort);
        return createTicket(jid, actor, displayName, c.text, []);
    }
  }

  async function createTicket(jid, actor, name, description, images) {
    const times = (recentTickets.get(actor) || []).filter((x) => Date.now() - x < 3600_000);
    if (times.length >= MAX_TICKETS_PER_HOUR) return reply(jid, 'נפתחו יותר מדי פניות בשעה האחרונה. נסו שוב מאוחר יותר.');
    recentTickets.set(actor, [...times, Date.now()]);
    const t = await store.createTicket({ requester_phone: actor, requester_name: name, description: description.slice(0, 4000), images, graceSec: cfg.intakeGraceSec });
    await pipeline.audit(t.id, actor, 'ticket_created', `${name} פתח פנייה: ${description.slice(0, 120)}`);
    return reply(jid, M.received(t, await queuePosition(t.id)));
  }

  return { handle, touch };
}

module.exports = { createIntake, parseCommand };
