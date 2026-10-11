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

function parseCommand(raw) {
  const t = String(raw || '')
    .replace(/[֑-ׇ]/g, '') // niqqud
    .replace(/[*_~]/g, '')
    .trim();
  let m;
  if (/^(עזרה|תפריט|help|\?)$/i.test(t)) return { cmd: 'help' };
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
  const lastStrangerReply = new Map();
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
      await pipeline.audit(null, who, 'rejected_sender', `הודעה ממספר לא מאושר (${phone ? formatLocal(phone) : 'מספר מוסתר'})`, { phone, lid, name });
      const last = lastStrangerReply.get(who) || 0;
      if (Date.now() - last > 24 * 3600_000) {
        lastStrangerReply.set(who, Date.now());
        await reply(jid, M.notAllowed);
      }
      return;
    }
    const actor = sender.phone;
    const isApprover = sender.role === 'approver';
    const displayName = sender.name || name || formatLocal(actor);
    const c = parseCommand(text);

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
        return reply(jid, M.help(isApprover));
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

  return { handle };
}

module.exports = { createIntake, parseCommand };
