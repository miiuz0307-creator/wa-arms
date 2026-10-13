// Every database function the web app calls, re-implemented over the demo tables.
// Each mirrors the SQL in supabase/migrations + supabase/pending (permissions, messages, side effects).
import { table, touch, nextId, type Row } from './store';
import { ctx, homeStation, stationById, type Ctx } from './ctx';
import { deleteRows } from './query';
import { iso, localDate, addDays, addMonths, daysBetween, midnightMs, ddmmyyyy, normPhone, trimNum, newUuid, raise, rand } from './util';
import { STATION_CODES } from './seed';

const APP_URL = 'https://web-production-e5de3.up.railway.app';
const today = () => localDate();
const now = () => Date.now();
const notAllowed = () => raise('not allowed');
const ownerSettings = () => table('owner_settings').find((s) => s.id === 1) || ({} as Row);
const appUrl = () => String(ownerSettings().app_url || APP_URL).trim().replace(/\/+$/, '') || APP_URL;
const station = (id: string | null | undefined) => stationById(id);
const profileName = (id: string | null | undefined) => {
  const p = id ? table('profiles').find((x) => x.id === id) : null;
  return p ? p.full_name || p.email : null;
};
const callerName = (c: Ctx) => (c.token ? 'מנהל התחנה' : profileName(c.uid));
const isActStation = (c: Ctx) => !!c.act && !c.token;
const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));
const payLabel = (p: string) => (p === 'bit' ? 'ביט' : p === 'paybox' ? 'פייבוקס' : 'אחר');
const catLabel = (p: string) =>
  ({ arm: 'זרוע', distribution: 'הפצה', groups: 'קבוצות', billing: 'תשלום', account: 'חשבון' } as Record<string, string>)[p] || 'אחר';
const monthsPast = (subEnd: string) => {
  // extract(year/month from age(current_date, sub_end)) + 1
  const a = new Date(subEnd + 'T12:00:00');
  const b = new Date(today() + 'T12:00:00');
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return Math.max(0, m) + 1;
};
const extendFrom = (subEnd: string | null, months: number) => {
  const base = subEnd && subEnd > today() ? subEnd : today();
  return addMonths(base, months);
};

export function outbox(to: string | null | undefined, body: string, hoursValid = 24) {
  const ph = normPhone(to);
  if (!ph) return null;
  const row = {
    id: nextId('wa_outbox'), to_phone: ph, body, status: 'pending', error: null, arm_id: null,
    expires_at: iso(now() + hoursValid * 3_600_000), created_at: iso(), sent_at: null,
  };
  table('wa_outbox').push(row);
  return row;
}
function sysMsg(title: string, body: string | null, level: string, stationId: string | null, days: number | null) {
  table('system_messages').push({
    id: nextId('system_messages'), title, body, level, station_id: stationId, starts_at: iso(), ends_at: days === null ? null : iso(now() + days * 86_400_000), created_at: iso(),
  });
}
function logRow(c: Ctx, sid: string | null, action: string, entity: string | null, entityId: string | null, details: any, actorName?: string | null) {
  table('activity_log').push({
    id: nextId('activity_log'), actor_id: c.uid, actor_name: actorName === undefined ? callerName(c) : actorName, action, entity, entity_id: entityId,
    details: details ?? null, created_at: iso(), station_id: sid ?? homeStation(),
  });
}
/** billing_station(): manager of my_station(), or a valid code login of a station whose subscription ended */
function billingStation(c: Ctx): string | null {
  if (c.station) return c.rank >= 3 ? c.station : null;
  if (!c.token) return null;
  const s = table('station_sessions').find((x) => x.token_hash === c.token && !x.revoked_at);
  if (!s || (s.last_seen && Date.parse(s.last_seen) < now() - 30 * 86_400_000)) return null;
  const st = station(s.station_id);
  return st && st.status === 'active' && !st.is_home ? st.id : null;
}
export const stationActive = (id: string) => {
  const s = station(id);
  return !!s && (s.is_home || (s.status === 'active' && (!s.sub_end || s.sub_end >= today())));
};
export function footerOf(stationId: string): string | null {
  const f = table('message_footers').find((x) => x.station_id === stationId && x.enabled);
  return f && f.footer_text ? f.footer_text : null;
}
const groupName = (sid: string, wa: string) =>
  table('groups')
    .filter((g) => g.wa_group_id === wa && g.station_id === sid)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0]?.name ?? null;

// ---------------------------------------------------------------- the functions
type Fn = (a: Row, c: Ctx) => any;
export const RPC: Record<string, Fn> = {
  // ---------- identity / station login
  station_me: (_a, c) => {
    const s = station(c.station);
    if (!s) return null;
    return { id: s.id, name: s.name, is_home: s.is_home, status: s.status, sub_end: s.sub_end, max_arms: s.max_arms, via_code: !!c.token, acting: isActStation(c) };
  },
  station_login: (a) => {
    const code = String(a.p_code ?? '').replace(/\s/g, '').toUpperCase();
    const st = table('stations').find((s) => s.code_hash === 'demo:' + code && !s.is_home);
    if (!st) return { error: 'קוד שגוי' };
    if (st.status !== 'active') return { error: 'הגישה לתחנה מושעית. פנה למנהל המערכת.' };
    const tok = 'demo-' + newUuid().replace(/-/g, '');
    table('station_sessions').push({ token_hash: tok, station_id: st.id, created_at: iso(), last_seen: iso(), revoked_at: null });
    touch();
    return { token: tok, station: st.name, expired: !!st.sub_end && st.sub_end < today() };
  },
  station_logout: (_a, c) => {
    if (!c.token) return null;
    table('station_sessions').filter((s) => s.token_hash === c.token).forEach((s) => (s.revoked_at = iso()));
    return null;
  },
  station_ping: (_a, c) => {
    if (!c.token) return null;
    const s = table('station_sessions').find((x) => x.token_hash === c.token);
    if (s && (!s.last_seen || Date.parse(s.last_seen) < now() - 60_000)) s.last_seen = iso();
    return null;
  },
  otp_request: (a) => {
    const ph = normPhone(a.p_phone);
    if (!ph || ph.length < 11) return { error: 'מספר טלפון לא תקין' };
    const st = table('stations').find((s) => normPhone(s.phone) === ph && !s.is_home && s.status === 'active' && (!s.sub_end || s.sub_end >= today()));
    if (st) {
      const code = String(rand().int(100000, 999999));
      table('login_otps').push({ id: nextId('login_otps'), phone: ph, station_id: st.id, code, expires_at: iso(now() + 5 * 60_000), attempts: 0, used_at: null, created_at: iso() });
      outbox(ph, `קוד הכניסה שלך למערכת הזרועות: *${code}*\nהקוד תקף ל-5 דקות. אם לא ביקשת, התעלם מההודעה.`, 0.1);
    }
    return { ok: true };
  },
  otp_verify: (a) => {
    const ph = normPhone(a.p_phone);
    const o = table('login_otps')
      .filter((x) => x.phone === ph && !x.used_at && x.station_id && Date.parse(x.expires_at) > now())
      .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))[0];
    if (!o) return { error: 'הקוד פג תוקף או שלא נשלח. בקש קוד חדש.' };
    if (o.attempts >= 5) return { error: 'יותר מדי ניסיונות. בקש קוד חדש.' };
    o.attempts++;
    if (o.code !== String(a.p_code ?? '').replace(/\D/g, '')) return { error: 'קוד שגוי' };
    o.used_at = iso();
    const st = station(o.station_id)!;
    if (st.status !== 'active') return { error: 'הגישה לתחנה מושעית. פנה למנהל המערכת.' };
    if (st.sub_end && st.sub_end < today()) return { error: 'המנוי של התחנה הסתיים. פנה למנהל המערכת לחידוש.' };
    const tok = 'demo-' + newUuid().replace(/-/g, '');
    table('station_sessions').push({ token_hash: tok, station_id: st.id, created_at: iso(), last_seen: iso(), revoked_at: null });
    return { token: tok, station: st.name };
  },
  log_activity: (a, c) => {
    if (c.rank < 1 || !c.station) notAllowed();
    logRow(c, c.station, a.p_action, a.p_entity ?? null, a.p_entity_id ?? null, a.p_details ?? null);
    return null;
  },

  // ---------- operation
  create_manual_campaign: (a, c) => {
    const sid = c.station;
    if (c.rank < 2 || !sid) raise('אין הרשאה');
    if (!String(a.p_message ?? '').trim()) raise('ההודעה ריקה');
    let arms: string[] | null = a.p_arm_ids;
    let grps: string[] | null = a.p_group_ids;
    if (a.p_list_id && !table('distribution_lists').some((l) => l.id === a.p_list_id && l.station_id === sid)) raise('רשימה לא נמצאה');
    if (a.p_list_id) {
      grps = table('list_groups').filter((x) => x.list_id === a.p_list_id).map((x) => x.wa_group_id);
      if (!arms || !arms.length) arms = table('list_arms').filter((x) => x.list_id === a.p_list_id).map((x) => x.arm_id);
    }
    if (!arms || !arms.length) arms = table('arms').filter((x) => x.is_active && x.station_id === sid).map((x) => x.id);
    arms = table('arms').filter((x) => arms!.includes(x.id) && x.station_id === sid).map((x) => x.id);
    if (!arms.length) raise('לא נבחרו זרועות');
    if (!grps || !grps.length) raise('לא נבחרו קבוצות');
    const id = newUuid();
    const camp = {
      id, kind: 'manual', status: 'queued', message_text: a.p_message, final_text: a.p_message, list_id: a.p_list_id ?? null, created_by: c.uid,
      station_id: sid, total: 0, sent: 0, failed: 0, reacted: false, started_at: null, finished_at: null, created_at: iso(), requester_name: null,
      requester_phone: null, requester_jid: null, source_group_id: null, source_group_name: null, source_message_id: null, trigger_id: null,
      trigger_key: null, trigger_arm_id: null, last_claim_at: null,
    };
    table('campaigns').push(camp);
    for (const arm of arms) table('campaign_arms').push({ campaign_id: id, arm_id: arm, station_id: sid });
    const uniq = [...new Set(grps)];
    for (const g of uniq)
      table('campaign_targets').push({
        id: nextId('campaign_targets'), campaign_id: id, wa_group_id: g, group_name: groupName(sid!, g), station_id: sid, status: 'pending',
        attempts: 0, error: null, sent_at: null, claimed_at: null, arm_id: null, tried_arms: [],
      });
    camp.total = uniq.length;
    logRow(c, sid, 'campaign_created', 'campaign', id, { arms: arms.length, groups: grps.length });
    return id;
  },
  retry_failed: (a, c) => {
    if (c.rank < 2) notAllowed();
    const camp = table('campaigns').find((x) => x.id === a.p_campaign && x.station_id === c.station);
    if (!camp) notAllowed();
    const ts = table('campaign_targets').filter((t) => t.campaign_id === a.p_campaign && t.status === 'failed');
    ts.forEach((t) => Object.assign(t, { status: 'pending', attempts: 0, tried_arms: [], error: null }));
    if (ts.length) {
      Object.assign(camp!, { status: 'running', finished_at: null });
      logRow(c, c.station, 'campaign_retry', 'campaign', a.p_campaign, { targets: ts.length });
    }
    return ts.length;
  },

  // ---------- station side: inbox, arms request, brand, footer
  station_inbox: (_a, c) => {
    const sid = c.station;
    if (!sid) return null;
    const st = station(sid)!;
    const os = ownerSettings();
    const dl = st.sub_end ? daysBetween(today(), st.sub_end) : null;
    const overdue = st.sub_end && st.sub_end < today() ? monthsPast(st.sub_end) : 0;
    const t = iso();
    const pending = table('arm_requests').filter((r) => r.station_id === sid && r.status === 'pending').sort((x, y) => y.id - x.id)[0];
    return {
      messages: table('system_messages')
        .filter((m) => (m.station_id == null || m.station_id === sid) && m.starts_at <= t && (!m.ends_at || m.ends_at > t))
        .sort((x, y) => (x.starts_at < y.starts_at ? 1 : -1))
        .map((m) => ({ id: m.id, title: m.title, body: m.body, level: m.level, at: m.starts_at })),
      billing: st.is_home
        ? null
        : {
            price: st.price, sub_end: st.sub_end, days_left: dl, months_overdue: overdue, owed: (Number(st.price) || 0) * overdue,
            payment_note: os.payment_note ?? null, remind: dl !== null && dl <= (os.reminder_days ?? 5),
          },
      arms: { max: st.max_arms, count: table('arms').filter((x) => x.station_id === sid).length },
      arm_request: pending ? { id: pending.id, count: pending.count, status: pending.status, at: pending.created_at } : null,
    };
  },
  station_request_arms: (a, c) => {
    const sid = c.station;
    if (!sid || c.rank < 3) raise('אין הרשאה');
    if (station(sid)!.is_home) raise('לא נדרש בחשבון הראשי');
    const n = Math.min(Math.max(Number(a.p_count) || 1, 1), 10);
    const note = String(a.p_note ?? '').trim() || null;
    let r = table('arm_requests').find((x) => x.station_id === sid && x.status === 'pending');
    if (r) Object.assign(r, { count: n, note, created_at: iso() });
    else {
      r = { id: nextId('arm_requests'), station_id: sid, count: n, note, status: 'pending', price_before: station(sid)!.price, price_after: null, created_at: iso(), decided_at: null };
      table('arm_requests').push(r);
    }
    return { id: r.id };
  },
  station_brand: (_a, c) => {
    const s = station(c.station);
    return s ? [{ station_id: s.id, name: s.name, logo_data: s.logo_data, plan: s.plan, status: s.status, sub_end: s.sub_end, price: num(s.price) }] : [];
  },
  station_set_logo: (a, c) => {
    if (!c.isSuper && (c.rank < 3 || !a.p_station || a.p_station !== c.station)) raise('אין הרשאה');
    const d = String(a.p_data ?? '').trim() || null;
    if (d) {
      if (!/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/.test(d)) raise('פורמט תמונה לא נתמך (PNG / JPG / WEBP)');
      if (d.length > 400000) raise('התמונה גדולה מדי (עד כ-300KB)');
    }
    const s = station(a.p_station);
    if (!s) raise('תחנה לא נמצאה');
    s!.logo_data = d;
    return null;
  },
  station_footer: (_a, c) => {
    if (!c.station || c.rank < 1) return null;
    const f = table('message_footers').find((x) => x.station_id === c.station);
    if (!f || !f.enabled || !f.footer_text) return { enabled: false, footer_text: '' };
    return { enabled: true, footer_text: f.footer_text };
  },
  station_active: (a) => stationActive(a.p_station),

  // ---------- group flags / problems
  group_flag_set: (a, c) => {
    const sid = c.station;
    if (!sid || c.rank < 2) raise('אין הרשאה');
    const ids = [...new Set(((a.p_groups as string[]) || []).map((x) => String(x ?? '').trim()).filter(Boolean))];
    const note = a.p_note == null ? undefined : String(a.p_note).trim() || null;
    for (const g of ids) {
      let f = table('group_flags').find((x) => x.station_id === sid && x.wa_group_id === g);
      if (!f) {
        f = { station_id: sid, wa_group_id: g, include_anyway: !!a.p_include_anyway, disabled: !!a.p_disabled, note: note ?? null, updated_at: iso(), updated_by: c.uid };
        table('group_flags').push(f);
      } else {
        if (a.p_include_anyway != null) f.include_anyway = !!a.p_include_anyway;
        if (a.p_disabled != null) f.disabled = !!a.p_disabled;
        if (note !== undefined) f.note = note;
        f.updated_at = iso();
        f.updated_by = c.uid;
      }
    }
    return ids.length;
  },
  group_problems: (a, c) => {
    const sid = c.station;
    if (!sid || c.rank < 1) raise('אין הרשאה');
    const h = Math.min(Math.max(Number(a.p_hours ?? 48) || 48, 1), 168);
    const since = iso(now() - h * 3_600_000);
    const camps = new Map(table('campaigns').filter((x) => x.station_id === sid && x.created_at > since).map((x) => [x.id, x]));
    const recent = table('campaign_targets')
      .filter((t) => camps.has(t.campaign_id) && ['sent', 'failed', 'skipped'].includes(t.status))
      .map((t) => ({ ...t, at: t.sent_at || t.claimed_at || camps.get(t.campaign_id)!.created_at }));
    const agg = new Map<string, Row>();
    for (const r of recent) {
      if (!(r.status === 'failed' || r.status === 'skipped') || !r.error) continue;
      if (r.error.startsWith('ההפצה בוטלה') || r.error.includes('עברו 15 דקות')) continue;
      const reason = r.error.includes('הרשאה')
        ? 'no_permission'
        : r.error.startsWith('אין זרוע פנויה')
          ? 'no_arm'
          : r.error.includes('הזרוע לא מחוברת')
            ? 'arm_offline'
            : r.status === 'failed'
              ? 'send_error'
              : null;
      if (!reason) continue;
      const k = `${r.wa_group_id}|${r.arm_id}|${reason}`;
      const cur = agg.get(k);
      if (!cur) agg.set(k, { wa_group_id: r.wa_group_id, arm_id: r.arm_id ?? null, reason, last_at: r.at, n: 1 });
      else {
        cur.n++;
        if (r.at > cur.last_at) cur.last_at = r.at;
      }
    }
    return [...agg.values()]
      .filter((p) => !recent.some((s) => s.status === 'sent' && s.wa_group_id === p.wa_group_id && (p.arm_id == null || s.arm_id === p.arm_id) && s.at > p.last_at))
      .sort((x, y) => (x.last_at < y.last_at ? 1 : -1));
  },

  // ---------- subscription & payments (station side)
  station_billing: (_a, c) => {
    const sid = billingStation(c);
    if (!sid) raise('אין הרשאה');
    const st = station(sid)!;
    if (st.is_home) return null;
    const os = ownerSettings();
    return {
      station_id: st.id, name: st.name, plan: st.plan, price: num(st.price), sub_end: st.sub_end, status: st.status,
      days_left: st.sub_end ? daysBetween(today(), st.sub_end) : null, bit_link: os.bit_link ?? null, paybox_link: os.paybox_link ?? null, payment_note: os.payment_note ?? null,
      payments: table('station_payments')
        .filter((p) => p.station_id === sid)
        .sort((x, y) => (x.paid_at === y.paid_at ? y.id - x.id : x.paid_at < y.paid_at ? 1 : -1))
        .slice(0, 50)
        .map((p) => ({ id: p.id, amount: num(p.amount), months: p.months, paid_at: p.paid_at, method: p.method })),
      requests: table('payment_requests')
        .filter((r) => r.station_id === sid)
        .sort((x, y) => y.id - x.id)
        .slice(0, 50)
        .map((r) => ({
          id: r.id, amount: num(r.amount), months: r.months, method: r.method, status: r.status, reject_reason: r.reject_reason, created_at: r.created_at, decided_at: r.decided_at,
        })),
    };
  },
  station_payment_submit: (a, c) => {
    const sid = billingStation(c);
    if (!sid) raise('אין הרשאה');
    const st = station(sid)!;
    if (st.is_home) raise('לא נדרש בחשבון הראשי');
    const amount = Number(a.p_amount);
    const months = Number(a.p_months);
    if (!amount || amount <= 0) raise('סכום לא תקין');
    if (!months || months < 1 || months > 24) raise('מספר חודשים לא תקין (1–24)');
    if (!['bit', 'paybox', 'other'].includes(a.p_method)) raise('אמצעי תשלום לא תקין');
    const pr = String(a.p_proof ?? '').trim() || null;
    if (pr) {
      if (!/^data:(image\/(png|jpeg|jpg|webp|gif|svg\+xml)|application\/pdf);base64,/.test(pr)) raise('האסמכתה חייבת להיות תמונה או PDF');
      if (pr.length > 1500000) raise('האסמכתה גדולה מדי (עד כ-1MB)');
    }
    if (table('payment_requests').some((r) => r.station_id === sid && r.status === 'pending')) raise('כבר קיימת בקשה ממתינה');
    const note = String(a.p_note ?? '').trim() || null;
    const r = {
      id: nextId('payment_requests'), station_id: sid, amount, months, method: a.p_method, proof_data: pr, note, status: 'pending', reject_reason: null,
      decided_by: null, decided_at: null, payment_id: null, token: newUuid(), created_at: iso(),
    };
    table('payment_requests').push(r);
    const os = ownerSettings();
    outbox(
      os.approvals_phone,
      `בקשת תשלום חדשה #${r.id}\nתחנה: ${st.name}\nסכום: ${trimNum(amount)} ₪ (${payLabel(a.p_method)})\nחודשים: ${months}\n` +
        (note ? `הערה: ${note}\n` : '') +
        `לאישור או דחייה: ${appUrl()}/pay?r=${r.token}`,
    );
    logRow(c, sid, 'payment_request', 'payment_request', String(r.id), { amount, months, method: a.p_method });
    return { id: r.id, token: r.token };
  },
  station_payment_cancel: (a, c) => {
    const sid = billingStation(c);
    if (!sid) raise('אין הרשאה');
    const r = table('payment_requests').find((x) => x.id === Number(a.p_id) && x.station_id === sid && x.status === 'pending');
    if (!r) raise('הבקשה לא נמצאה או שכבר טופלה');
    Object.assign(r!, { status: 'cancelled', decided_at: iso() });
    return null;
  },

  // ---------- owner: payment requests
  owner_pay_settings_get: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const s = ownerSettings();
    return {
      bit_link: s.bit_link ?? null, paybox_link: s.paybox_link ?? null, approvals_phone: s.approvals_phone ?? null, support_phone: s.support_phone ?? null,
      app_url: s.app_url ?? null, payment_note: s.payment_note ?? null, reminder_days: s.reminder_days ?? null,
    };
  },
  owner_pay_settings_save: (a, c) => {
    if (!c.isSuper) notAllowed();
    const t = (v: any) => String(v ?? '').trim() || null;
    const b = t(a.p_bit);
    const pb = t(a.p_paybox);
    const u = t(a.p_app_url)?.replace(/\/+$/, '') || null;
    const ap = t(a.p_approvals_phone);
    const sp = t(a.p_support_phone);
    if (b && !/^https:\/\//i.test(b)) raise('קישור ביט חייב להתחיל ב-https://');
    if (pb && !/^https:\/\//i.test(pb)) raise('קישור פייבוקס חייב להתחיל ב-https://');
    if (u && !/^https?:\/\//i.test(u)) raise('כתובת האפליקציה חייבת להתחיל ב-https://');
    if (ap && (normPhone(ap) || '').length < 11) raise('מספר טלפון לאישורים לא תקין');
    if (sp && (normPhone(sp) || '').length < 11) raise('מספר טלפון לתמיכה לא תקין');
    Object.assign(ownerSettings(), { bit_link: b, paybox_link: pb, approvals_phone: ap, support_phone: sp, app_url: u || APP_URL, updated_at: iso() });
    return null;
  },
  owner_payment_requests: (a, c) => {
    if (!c.isSuper) notAllowed();
    return table('payment_requests')
      .filter((r) => a.p_status == null || r.status === a.p_status)
      .sort((x, y) => (x.status === 'pending' ? 0 : 1) - (y.status === 'pending' ? 0 : 1) || (x.created_at < y.created_at ? 1 : -1))
      .slice(0, 300)
      .map((r) => ({
        id: r.id, station_id: r.station_id, station_name: station(r.station_id)?.name ?? null, amount: num(r.amount), months: r.months, method: r.method,
        status: r.status, note: r.note, reject_reason: r.reject_reason, created_at: r.created_at, decided_at: r.decided_at, decided_by_name: profileName(r.decided_by),
        has_proof: r.proof_data != null, token: r.token,
      }));
  },
  owner_payment_request_get: (a, c) => {
    if (!c.isSuper) notAllowed();
    if (a.p_id == null && a.p_token == null) return null;
    const r = table('payment_requests').find((x) => (a.p_id == null || x.id === Number(a.p_id)) && (a.p_token == null || x.token === a.p_token));
    if (!r) return null;
    const s = station(r.station_id)!;
    return {
      id: r.id, station_id: r.station_id, station_name: s.name, station_phone: s.phone, price: num(s.price), sub_end: s.sub_end, station_status: s.status,
      amount: num(r.amount), months: r.months, method: r.method, status: r.status, note: r.note, reject_reason: r.reject_reason, proof_data: r.proof_data,
      created_at: r.created_at, decided_at: r.decided_at, decided_by_name: profileName(r.decided_by), payment_id: r.payment_id, token: r.token,
    };
  },
  owner_payment_decide: (a, c) => {
    if (!c.isSuper) notAllowed();
    if (a.p_approve == null) raise('חסרה החלטה');
    const r = table('payment_requests').find((x) => x.id === Number(a.p_id));
    if (!r) raise('הבקשה לא נמצאה');
    if (r!.status !== 'pending') raise('הבקשה כבר טופלה');
    const st = station(r!.station_id)!;
    const reason = String(a.p_reason ?? '').trim() || null;
    if (a.p_approve) {
      const pid = nextId('station_payments');
      table('station_payments').push({
        id: pid, station_id: st.id, amount: r!.amount, months: r!.months, paid_at: today(), method: payLabel(r!.method), note: 'בקשת תשלום #' + r!.id, created_by: c.uid, created_at: iso(),
      });
      st.sub_end = extendFrom(st.sub_end, r!.months);
      st.status = 'active';
      Object.assign(r!, { status: 'approved', payment_id: pid, decided_by: c.uid, decided_at: iso() });
      sysMsg('התשלום אושר', `התשלום על סך ${trimNum(r!.amount)} ₪ התקבל. המנוי בתוקף עד ${ddmmyyyy(st.sub_end)}. תודה!`, 'info', st.id, 7);
      outbox(st.phone, `התשלום של ${st.name} על סך ${trimNum(r!.amount)} ₪ אושר.\nהמנוי בתוקף עד ${ddmmyyyy(st.sub_end)}. תודה!`);
      return { status: 'approved', sub_end: st.sub_end };
    }
    if (!reason) raise('יש לכתוב סיבת דחייה');
    Object.assign(r!, { status: 'rejected', reject_reason: reason, decided_by: c.uid, decided_at: iso() });
    sysMsg('התשלום לא אושר', `הסיבה: ${reason}. אפשר להגיש אסמכתה מחדש במסך "מנוי ותשלום".`, 'warning', st.id, 7);
    outbox(st.phone, `בקשת התשלום #${r!.id} של ${st.name} לא אושרה.\nהסיבה: ${reason}\nאפשר להגיש אסמכתה מחדש באפליקציה.`);
    return { status: 'rejected', sub_end: st.sub_end };
  },

  // ---------- support
  support_ticket_create: (a, c) => {
    const sid = c.station;
    if (!sid || c.rank < 2) raise('אין הרשאה');
    const st = station(sid)!;
    if (st.is_home) raise('לא נדרש בחשבון הראשי');
    if (!['arm', 'distribution', 'groups', 'billing', 'account', 'other'].includes(a.p_category)) raise('נושא לא תקין');
    const subject = String(a.p_subject ?? '').trim();
    if (!subject) raise('חסרה כותרת לפנייה');
    const img = checkImage(a.p_image);
    if (!String(a.p_body ?? '').trim() && !img) raise('חסר תיאור הבעיה');
    if (a.p_arm && !table('arms').some((x) => x.id === a.p_arm && x.station_id === sid)) raise('הזרוע לא שייכת לתחנה');
    const nm = callerName(c);
    const tid = nextId('support_tickets');
    table('support_tickets').push({
      id: tid, station_id: sid, arm_id: a.p_arm ?? null, category: a.p_category, subject: subject.slice(0, 200), status: 'open', created_by_name: nm,
      created_at: iso(), updated_at: iso(), last_reply_by: 'station',
    });
    table('support_messages').push({
      id: nextId('support_messages'), ticket_id: tid, station_id: sid, author: 'station', author_name: nm, body: String(a.p_body ?? '').trim() || null, image_data: img, created_at: iso(),
    });
    const os = ownerSettings();
    outbox(String(os.support_phone ?? '').trim() || os.approvals_phone, `פנייה חדשה #${tid} מתחנה ${st.name}: ${subject.slice(0, 200)} (${catLabel(a.p_category)})\n${appUrl()}/support?t=${tid}`);
    return tid;
  },
  support_reply: (a, c) => {
    const t = table('support_tickets').find((x) => x.id === Number(a.p_ticket));
    if (!t) raise('הפנייה לא נמצאה');
    const isOwner = c.isSuper && !c.act;
    let who: 'owner' | 'station';
    let nm: string | null;
    if (isOwner) {
      who = 'owner';
      nm = profileName(c.uid);
    } else if (c.rank >= 1 && t!.station_id === c.station) {
      who = 'station';
      nm = callerName(c);
    } else return raise('הפנייה לא נמצאה');
    const img = checkImage(a.p_image);
    if (!String(a.p_body ?? '').trim() && !img) raise('ההודעה ריקה');
    const mid = nextId('support_messages');
    table('support_messages').push({ id: mid, ticket_id: t!.id, station_id: t!.station_id, author: who, author_name: nm, body: String(a.p_body ?? '').trim() || null, image_data: img, created_at: iso() });
    t!.updated_at = iso();
    t!.last_reply_by = who;
    t!.status = who === 'owner' ? (t!.status === 'closed' ? t!.status : 'waiting') : ['waiting', 'closed'].includes(t!.status) ? 'open' : t!.status;
    if (who === 'owner') outbox(station(t!.station_id)?.phone, `התקבלה תשובה לפנייה #${t!.id}: ${t!.subject}\n${appUrl()}/support?t=${t!.id}`);
    return mid;
  },
  support_tickets: (a, c) => {
    const all = c.isSuper && !c.act;
    if (!all && (!c.station || c.rank < 1)) raise('אין הרשאה');
    return table('support_tickets')
      .filter((t) => (all || t.station_id === c.station) && (a.p_status == null || t.status === a.p_status))
      .sort((x, y) => (x.status === 'closed' ? 1 : 0) - (y.status === 'closed' ? 1 : 0) || (x.updated_at < y.updated_at ? 1 : -1))
      .slice(0, 500)
      .map((t) => ({
        id: t.id, station_id: t.station_id, station_name: station(t.station_id)?.name ?? null, arm_id: t.arm_id, arm_name: table('arms').find((x) => x.id === t.arm_id)?.name ?? null,
        category: t.category, subject: t.subject, status: t.status, created_at: t.created_at, updated_at: t.updated_at, last_reply_by: t.last_reply_by,
        messages: table('support_messages').filter((m) => m.ticket_id === t.id).length,
      }));
  },
  support_ticket_get: (a, c) => {
    const all = c.isSuper && !c.act;
    if (!all && (!c.station || c.rank < 1)) raise('אין הרשאה');
    const t = table('support_tickets').find((x) => x.id === Number(a.p_id) && (all || x.station_id === c.station));
    if (!t) return null;
    const s = station(t.station_id);
    return {
      id: t.id, station_id: t.station_id, station_name: s?.name ?? null, station_phone: all ? s?.phone ?? null : null, arm_id: t.arm_id,
      arm_name: table('arms').find((x) => x.id === t.arm_id)?.name ?? null, category: t.category, subject: t.subject, status: t.status,
      created_by_name: t.created_by_name, created_at: t.created_at, updated_at: t.updated_at, last_reply_by: t.last_reply_by,
      messages: table('support_messages')
        .filter((m) => m.ticket_id === t.id)
        .sort((x, y) => x.id - y.id)
        .map((m) => ({ id: m.id, author: m.author, author_name: m.author_name, body: m.body, image_data: m.image_data, created_at: m.created_at })),
    };
  },
  support_ticket_status: (a, c) => {
    if (!c.isSuper) notAllowed();
    if (!['open', 'in_progress', 'waiting', 'closed'].includes(a.p_status)) raise('סטטוס לא תקין');
    const t = table('support_tickets').find((x) => x.id === Number(a.p_id));
    if (!t) raise('הפנייה לא נמצאה');
    Object.assign(t!, { status: a.p_status, updated_at: iso() });
    return null;
  },

  // ---------- message footer
  owner_footers: (_a, c) => {
    if (!c.isSuper) notAllowed();
    return table('stations')
      .slice()
      .sort((x, y) => (x.is_home === y.is_home ? x.name.localeCompare(y.name, 'he') : x.is_home ? -1 : 1))
      .map((s) => {
        const f = table('message_footers').find((x) => x.station_id === s.id);
        return { station_id: s.id, station_name: s.name, is_home: s.is_home, status: s.status, footer_text: f?.footer_text ?? '', enabled: f?.enabled ?? false, updated_at: f?.updated_at ?? null };
      });
  },
  owner_footer_set: (a, c) => {
    if (!c.isSuper) notAllowed();
    const t = String(a.p_text ?? '').trim();
    if (t.length > 500) raise('החתימה ארוכה מדי (עד 500 תווים)');
    const ids: string[] | null = a.p_stations && a.p_stations.length ? a.p_stations : null;
    let n = 0;
    for (const s of table('stations')) {
      if (ids && !ids.includes(s.id)) continue;
      const enabled = (a.p_enabled ?? true) !== false && t !== '';
      const f = table('message_footers').find((x) => x.station_id === s.id);
      if (f) Object.assign(f, { footer_text: t, enabled, updated_at: iso(), updated_by: c.uid });
      else table('message_footers').push({ station_id: s.id, footer_text: t, enabled, updated_at: iso(), updated_by: c.uid });
      n++;
    }
    return n;
  },

  // ---------- owner: stations
  stations_overview: (_a, c) => {
    if (!c.isSuper) notAllowed();
    return table('stations')
      .filter((s) => !s.is_home)
      .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
      .map((s) => {
        const arms = table('arms').filter((a) => a.station_id === s.id);
        const camps = table('campaigns').filter((x) => x.station_id === s.id);
        const sess = table('station_sessions').filter((x) => x.station_id === s.id);
        return {
          id: s.id, name: s.name, manager_name: s.manager_name, phone: s.phone, code_hint: s.code_hint, status: s.status, joined_at: s.joined_at, sub_end: s.sub_end,
          price: num(s.price), max_arms: s.max_arms, notes: s.notes, created_at: s.created_at, arms_total: arms.length, arms_online: arms.filter((a) => a.status === 'online').length,
          groups_count: new Set(table('groups').filter((g) => g.station_id === s.id).map((g) => g.wa_group_id)).size, campaigns_count: camps.length,
          last_campaign: camps.reduce((m: string | null, x) => (!m || x.created_at > m ? x.created_at : m), null),
          last_login: sess.reduce((m: string | null, x) => (!m || x.last_seen > m ? x.last_seen : m), null),
        };
      });
  },
  station_save: (a, c) => {
    if (!c.isSuper) notAllowed();
    const p = a.p || {};
    const name = String(p.name ?? '').trim();
    if (!name) raise('חסר שם תחנה');
    const t = (v: any) => (v === '' || v === undefined ? null : v);
    if (!p.id) {
      const code = String(p.code || genCode()).replace(/\s/g, '').toUpperCase();
      if (code.length < 6) raise('קוד כניסה חייב להיות לפחות 6 תווים');
      if (table('stations').some((s) => s.code_hash === 'demo:' + code)) raise('הקוד כבר בשימוש. בחר קוד אחר.');
      const id = newUuid();
      table('stations').push({
        id, name, manager_name: t(p.manager_name), phone: t(p.phone), code_hash: 'demo:' + code, code_hint: code.slice(-2), is_home: false, status: t(p.status) || 'active',
        joined_at: t(p.joined_at) || today(), sub_end: t(p.sub_end), price: num(t(p.price)), max_arms: num(t(p.max_arms)) ?? 2, notes: t(p.notes), created_at: iso(),
        logo_data: null, plan: 'basic',
      });
      table('app_settings').push({
        id: nextId('app_settings'), station_id: id, min_delay_sec: 8, max_delay_sec: 20, per_arm_group_limit: 60, distribution_mode: 'fill', auto_distribution_enabled: false,
        rate_per_minute: 20, open_trigger: false, duplicate_window_min: 10, cancel_words: ['ביטול', 'בטל'], updated_at: iso(),
      });
      const tpl = { id: newUuid(), name: 'ברירת מחדל', prefix: '', suffix: '📞 לבקשה במספר: {PHONE}', station_id: id, created_at: iso() };
      table('templates').push(tpl);
      table('triggers').push({ id: newUuid(), keyword: 'עזרה', action: 'distribute', template_id: tpl.id, list_id: null, strip_keyword: true, is_active: true, station_id: id, created_at: iso() });
      // new stations get the current common footer
      const common = table('message_footers').find((f) => f.enabled && f.footer_text);
      if (common) table('message_footers').push({ station_id: id, footer_text: common.footer_text, enabled: true, updated_at: iso(), updated_by: c.uid });
      STATION_CODES[id] = code;
      return { id, code };
    }
    const s = table('stations').find((x) => x.id === p.id && !x.is_home);
    if (s)
      Object.assign(s, {
        name, manager_name: p.manager_name ?? null, phone: p.phone ?? null, status: t(p.status) || s.status, joined_at: t(p.joined_at) || s.joined_at,
        sub_end: t(p.sub_end), price: num(t(p.price)), max_arms: num(t(p.max_arms)) ?? s.max_arms, notes: p.notes ?? null,
      });
    return { id: p.id, code: null };
  },
  station_set_code: (a, c) => {
    if (!c.isSuper) notAllowed();
    const code = String(a.p_code || genCode()).replace(/\s/g, '').toUpperCase();
    if (code.length < 6) raise('קוד כניסה חייב להיות לפחות 6 תווים');
    if (table('stations').some((s) => s.code_hash === 'demo:' + code && s.id !== a.p_id)) raise('הקוד כבר בשימוש. בחר קוד אחר.');
    const s = table('stations').find((x) => x.id === a.p_id && !x.is_home);
    if (s) Object.assign(s, { code_hash: 'demo:' + code, code_hint: code.slice(-2) });
    table('station_sessions').filter((x) => x.station_id === a.p_id && !x.revoked_at).forEach((x) => (x.revoked_at = iso()));
    STATION_CODES[a.p_id] = code;
    return code;
  },
  station_logout_all: (a, c) => {
    if (!c.isSuper) notAllowed();
    table('station_sessions').filter((x) => x.station_id === a.p_id && !x.revoked_at).forEach((x) => (x.revoked_at = iso()));
    return null;
  },
  station_extend: (a, c) => {
    if (!c.isSuper) notAllowed();
    const s = table('stations').find((x) => x.id === a.p_id && !x.is_home);
    if (!s) return null;
    s.sub_end = extendFrom(s.sub_end, Number(a.p_months) || 0);
    s.status = 'active';
    return s.sub_end;
  },
  station_delete: (a, c) => {
    if (!c.isSuper) notAllowed();
    deleteRows('stations', table('stations').filter((x) => x.id === a.p_id && !x.is_home));
    return null;
  },

  // ---------- owner: billing
  owner_payment_add: (a, c) => {
    if (!c.isSuper) notAllowed();
    const amount = Number(a.p_amount);
    if (a.p_amount == null || Number.isNaN(amount) || amount < 0) raise('סכום לא תקין');
    const s = table('stations').find((x) => x.id === a.p_station && !x.is_home);
    if (!s) raise('תחנה לא נמצאה');
    const months = Math.max(Number(a.p_months ?? 0) || 0, 0);
    const id = nextId('station_payments');
    table('station_payments').push({
      id, station_id: s!.id, amount, months, paid_at: a.p_paid_at || today(), method: String(a.p_method ?? '').trim() || null, note: String(a.p_note ?? '').trim() || null,
      created_by: c.uid, created_at: iso(),
    });
    if (months > 0) {
      s!.sub_end = extendFrom(s!.sub_end, months);
      s!.status = 'active';
    }
    return { id, sub_end: s!.sub_end };
  },
  owner_payments: (a, c) => {
    if (!c.isSuper) notAllowed();
    const lim = Math.min(Math.max(Number(a.p_limit ?? 200) || 200, 1), 2000);
    return table('station_payments')
      .slice()
      .sort((x, y) => (x.paid_at === y.paid_at ? y.id - x.id : x.paid_at < y.paid_at ? 1 : -1))
      .slice(0, lim)
      .map((p) => ({ id: p.id, station_id: p.station_id, station_name: station(p.station_id)?.name ?? null, amount: num(p.amount), months: p.months, paid_at: p.paid_at, method: p.method, note: p.note, created_at: p.created_at }));
  },
  owner_billing: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const month = today().slice(0, 7);
    return table('stations')
      .filter((s) => !s.is_home)
      .sort((x, y) => x.name.localeCompare(y.name, 'he'))
      .map((s) => {
        const pays = table('station_payments')
          .filter((p) => p.station_id === s.id)
          .sort((x, y) => (x.paid_at === y.paid_at ? y.id - x.id : x.paid_at < y.paid_at ? 1 : -1));
        const overdue = s.sub_end && s.sub_end < today() ? monthsPast(s.sub_end) : 0;
        return {
          station_id: s.id, station_name: s.name, status: s.status, price: num(s.price), sub_end: s.sub_end, last_paid_at: pays[0]?.paid_at ?? null,
          last_amount: num(pays[0]?.amount), paid_total: pays.reduce((t, p) => t + Number(p.amount), 0),
          paid_this_month: pays.filter((p) => String(p.paid_at).slice(0, 7) === month).reduce((t, p) => t + Number(p.amount), 0),
          months_overdue: overdue, owed: (Number(s.price) || 0) * overdue,
        };
      });
  },
  owner_set_price: (a, c) => {
    if (!c.isSuper) notAllowed();
    if (a.p_price != null && Number(a.p_price) < 0) raise('מחיר לא תקין');
    const s = table('stations').find((x) => x.id === a.p_station && !x.is_home);
    if (s) s.price = num(a.p_price);
    return null;
  },
  owner_settings_get: (_a, c) => {
    if (!c.isSuper) notAllowed();
    return { ...ownerSettings() };
  },
  owner_settings_save: (a, c) => {
    if (!c.isSuper) notAllowed();
    Object.assign(ownerSettings(), {
      payment_note: String(a.p_payment_note ?? '').trim() || null, extra_arm_price: Math.max(Number(a.p_extra_arm_price) || 0, 0),
      reminder_days: Math.min(Math.max(Number(a.p_reminder_days ?? 5) || 0, 0), 30), updated_at: iso(),
    });
    return null;
  },
  owner_arm_requests: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const since = iso(now() - 30 * 86_400_000);
    return table('arm_requests')
      .filter((r) => r.status === 'pending' || (r.decided_at && r.decided_at > since))
      .sort((x, y) => (x.status === 'pending' ? 0 : 1) - (y.status === 'pending' ? 0 : 1) || (x.created_at < y.created_at ? 1 : -1))
      .slice(0, 100)
      .map((r) => {
        const s = station(r.station_id)!;
        return {
          id: r.id, station_id: s.id, station_name: s.name, count: r.count, note: r.note, status: r.status, price_before: num(r.price_before ?? s.price),
          price_after: num(r.price_after), max_arms: s.max_arms, arms_count: table('arms').filter((x) => x.station_id === s.id).length, created_at: r.created_at, decided_at: r.decided_at,
        };
      });
  },
  owner_decide_arm_request: (a, c) => {
    if (!c.isSuper) notAllowed();
    const r = table('arm_requests').find((x) => x.id === Number(a.p_id) && x.status === 'pending');
    if (!r) raise('הבקשה כבר טופלה');
    const s = station(r!.station_id)!;
    if (a.p_approve) {
      const n = table('arms').filter((x) => x.station_id === s.id).length;
      s.max_arms = Math.max(s.max_arms ?? 0, n) + r!.count;
      if (a.p_new_price != null) s.price = Number(a.p_new_price);
      Object.assign(r!, { status: 'approved', decided_at: iso(), price_after: a.p_new_price ?? r!.price_before });
      sysMsg(
        'הבקשה לזרוע נוספת אושרה',
        `אפשר להוסיף עכשיו ${r!.count}${r!.count === 1 ? ' זרוע' : ' זרועות'} במסך "חיבור זרועות".` + (a.p_new_price != null ? ` התשלום החודשי החדש: ${Math.round(a.p_new_price)} ₪.` : ''),
        'info', s.id, 7,
      );
    } else {
      Object.assign(r!, { status: 'declined', decided_at: iso() });
      sysMsg('הבקשה לזרוע נוספת לא אושרה', 'לפרטים פנה למנהל המערכת.', 'warning', s.id, 3);
    }
    return null;
  },
  owner_message_send: (a, c) => {
    if (!c.isSuper) notAllowed();
    const title = String(a.p_title ?? '').trim();
    if (!title) raise('חסרה כותרת');
    const id = nextId('system_messages');
    const days = a.p_days == null || Number(a.p_days) <= 0 ? null : Number(a.p_days);
    table('system_messages').push({
      id, title, body: String(a.p_body ?? '').trim() || null, level: a.p_level || 'info', station_id: a.p_station ?? null, starts_at: iso(),
      ends_at: days === null ? null : iso(now() + days * 86_400_000), created_at: iso(),
    });
    return id;
  },
  owner_messages: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const t = iso();
    return table('system_messages')
      .slice()
      .sort((x, y) => (x.starts_at < y.starts_at ? 1 : -1))
      .slice(0, 50)
      .map((m) => ({ id: m.id, title: m.title, body: m.body, level: m.level, station_id: m.station_id, station_name: station(m.station_id)?.name ?? null, starts_at: m.starts_at, ends_at: m.ends_at, active: !m.ends_at || m.ends_at > t }));
  },
  owner_message_end: (a, c) => {
    if (!c.isSuper) notAllowed();
    const m = table('system_messages').find((x) => x.id === Number(a.p_id) && (!x.ends_at || x.ends_at > iso()));
    if (m) m.ends_at = iso();
    return null;
  },
  owner_mail_settings: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const m = table('mail_settings').find((x) => x.id === 1) || ({} as Row);
    return { from_name: m.from_name, address: m.address, smtp_host: m.smtp_host, smtp_port: m.smtp_port, smtp_user: m.smtp_user, has_pass: !!m.smtp_pass, updated_at: m.updated_at };
  },
  owner_mail_settings_save: (a, c) => {
    if (!c.isSuper) notAllowed();
    const p = a.p || {};
    const m = table('mail_settings').find((x) => x.id === 1)!;
    const t = (v: any) => String(v ?? '').trim() || null;
    Object.assign(m, {
      from_name: t(p.from_name) || m.from_name, address: t(p.address), smtp_host: t(p.smtp_host) || 'smtp.gmail.com', smtp_port: Number(p.smtp_port) || 465,
      smtp_user: t(p.smtp_user) || t(p.address), smtp_pass: String(p.smtp_pass ?? '').replace(/\s/g, '') || m.smtp_pass, updated_at: iso(),
    });
    logRow(c, homeStation(), 'mail_settings_saved', 'settings', null, { address: p.address ?? null });
    return { ok: true };
  },

  // ---------- owner: control center / health
  owner_arms: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const d = today();
    return table('arms')
      .map((a) => ({ a, s: station(a.station_id)! }))
      .filter((x) => x.s)
      .sort((x, y) => (x.s.is_home === y.s.is_home ? x.s.name.localeCompare(y.s.name, 'he') || (x.a.created_at < y.a.created_at ? -1 : 1) : x.s.is_home ? -1 : 1))
      .map(({ a, s }) => ({
        arm_id: a.id, arm_name: a.name, station_id: s.id, station_name: s.name, is_home: s.is_home, phone: a.phone, status: a.status, is_active: a.is_active,
        last_error: a.last_error, last_seen_at: a.last_seen_at, sent_today: a.sent_day === d ? a.sent_today : 0, daily_limit: a.daily_limit, linked_at: a.linked_at,
        groups_count: table('groups').filter((g) => g.arm_id === a.id).length,
      }));
  },
  owner_active_campaigns: (_a, c) => {
    if (!c.isSuper) notAllowed();
    return table('campaigns')
      .filter((x) => ['queued', 'running', 'paused', 'pending_phone'].includes(x.status))
      .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
      .slice(0, 100)
      .map((x) => {
        const ts = table('campaign_targets').filter((t) => t.campaign_id === x.id);
        return {
          campaign_id: x.id, station_id: x.station_id, station_name: station(x.station_id)?.name ?? null, kind: x.kind, status: x.status,
          text_preview: String(x.final_text ?? x.message_text ?? '').slice(0, 120), sent: ts.filter((t) => t.status === 'sent').length,
          failed: ts.filter((t) => t.status === 'failed' || t.status === 'skipped').length, total: ts.length, created_at: x.created_at, source_group_name: x.source_group_name,
        };
      });
  },
  owner_today: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const day = iso(midnightMs());
    return table('stations')
      .filter((s) => s.status === 'active')
      .sort((x, y) => (x.is_home === y.is_home ? x.name.localeCompare(y.name, 'he') : x.is_home ? -1 : 1))
      .map((s) => ({
        station_id: s.id, station_name: s.name,
        rides: table('campaigns').filter((x) => x.station_id === s.id && x.created_at >= day).length,
        sent: table('campaign_targets').filter((t) => t.station_id === s.id && t.status === 'sent' && t.sent_at >= day).length,
        failed: table('campaign_targets').filter((t) => t.station_id === s.id && t.status === 'failed' && t.claimed_at >= day).length,
        refused: table('activity_log').filter((l) => l.station_id === s.id && l.created_at >= day && ['quote_blocked', 'quote_cancel_denied', 'quote_operator_pending'].includes(l.action)).length,
      }));
  },
  owner_arm_command: (a, c) => {
    if (!c.isSuper) notAllowed();
    if (!['connect', 'refresh_groups', 'reset'].includes(a.p_command)) raise('unknown command');
    const arm = table('arms').find((x) => x.id === a.p_arm);
    if (!arm) raise('זרוע לא נמצאה');
    table('arm_commands').push({ id: nextId('arm_commands'), arm_id: a.p_arm, command: a.p_command, created_by: c.uid, station_id: arm!.station_id, status: 'pending', error: null, processed_at: null, created_at: iso() });
    return null;
  },
  owner_arm_limit: (a, c) => {
    if (!c.isSuper) notAllowed();
    const arm = table('arms').find((x) => x.id === a.p_arm);
    if (arm) Object.assign(arm, { daily_limit: Math.max(Number(a.p_limit) || 0, 0), sent_day: arm.sent_day || today() });
    return null;
  },
  owner_cancel_campaign: (a, c) => {
    if (!c.isSuper) notAllowed();
    const x = table('campaigns').find((y) => y.id === a.p_id && ['queued', 'running', 'paused', 'pending_phone'].includes(y.status));
    if (x) Object.assign(x, { status: 'cancelled', finished_at: iso() });
    table('campaign_targets')
      .filter((t) => t.campaign_id === a.p_id && t.status === 'pending')
      .forEach((t) => Object.assign(t, { status: 'skipped', error: 'ההפצה בוטלה' }));
    return null;
  },
  owner_health: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const eng = table('arms')
      .filter((a) => a.is_active && a.status === 'online')
      .reduce((m: string | null, a) => (!m || (a.last_seen_at && a.last_seen_at > m) ? a.last_seen_at : m), null);
    const hour = iso(now() - 3_600_000);
    const out: Row[] = [];
    for (const s of table('stations').filter((x) => x.status === 'active')) {
      const fails = table('campaign_targets').filter((t) => t.station_id === s.id && t.status === 'failed' && t.claimed_at > hour).length;
      const bad = table('arms').filter((a) => a.station_id === s.id && a.is_active && a.status !== 'online');
      if (bad.length) bad.forEach((a) => out.push({ station_id: s.id, station_name: s.name, arm_id: a.id, arm_name: a.name, arm_status: a.status, arm_error: a.last_error, failed_hour: fails, engine_seen: eng }));
      else if (fails > 0) out.push({ station_id: s.id, station_name: s.name, arm_id: null, arm_name: null, arm_status: null, arm_error: null, failed_hour: fails, engine_seen: eng });
    }
    out.sort((x, y) => String(x.station_name).localeCompare(String(y.station_name), 'he'));
    return [{ station_id: null, station_name: null, arm_id: null, arm_name: null, arm_status: null, arm_error: null, failed_hour: 0, engine_seen: eng }, ...out];
  },
  owner_delivery: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const hour = iso(now() - 3_600_000);
    const day = iso(now() - 86_400_000);
    return table('arms')
      .filter((a) => a.is_active)
      .map((a) => {
        const ts = table('campaign_targets').filter((t) => t.arm_id === a.id && (t.sent_at || t.claimed_at) > day);
        const h = ts.filter((t) => (t.sent_at || t.claimed_at) > hour);
        const sentH = h.filter((t) => t.status === 'sent').length;
        const sentD = ts.filter((t) => t.status === 'sent').length;
        const k = (n: number, f: number) => Math.floor(n * f);
        return {
          station_name: station(a.station_id)?.name ?? null, arm_id: a.id, arm_name: a.name, arm_status: a.status, sent_hour: sentH, failed_hour: k(sentH, 0.04), devices_hour: k(sentH, 0.01),
          resent_hour: k(sentH, 0.03), lost_hour: 0, undecrypted_hour: 0, sent_day: sentD, failed_day: k(sentD, 0.04), resent_day: k(sentD, 0.03), lost_day: k(sentD, 0.002),
          last_minute: a.status === 'online' && sentD ? iso(now() - 60_000) : null,
        };
      })
      .sort((x, y) => y.failed_hour - x.failed_hour);
  },
  owner_engine_status: (_a, c) => {
    if (!c.isSuper) return null;
    const e = table('engine_status').find((x) => x.id === 1);
    if (!e) return null;
    const online = table('arms').filter((a) => a.status === 'online').length;
    return { sync_ok_at: iso(now() - 4000), sync_age_s: 4, sync_ms: e.sync_ms, sync_stuck_count: 0, arms_running: table('arms').filter((a) => a.is_active).length, arms_online: online, arms_stopping: 0, rss_mb: e.rss_mb, reported_age_s: 4 };
  },
  owner_delivery_daily: () => [],
  owner_delivery_daily_station: () => [],

  // ---------- releases
  owner_releases: (_a, c) => {
    if (!c.isSuper) notAllowed();
    const arms = table('arms').filter((a) => a.is_active);
    const eng = arms.filter((a) => a.status === 'online').reduce((m: string | null, a) => (!m || (a.last_seen_at && a.last_seen_at > m) ? a.last_seen_at : m), null);
    return {
      releases: table('releases')
        .slice()
        .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
        .slice(0, 50)
        .map((r) => ({
          id: r.id, version: r.version, title: r.title, changes: r.changes, components: r.components, affects_arms: r.affects_arms, disconnect_risk: r.disconnect_risk,
          restart_engine: r.restart_engine, risk_notes: r.risk_notes, commit: String(r.commit_sha).slice(0, 7), has_db: r.migration_sql != null, has_undo: r.rollback_sql != null,
          status: r.status, deploy_after: r.deploy_after, decided_at: r.decided_at, started_at: r.started_at, deployed_at: r.deployed_at, verify_until: r.verify_until,
          health: r.health, log: r.log, created_at: r.created_at,
        })),
      live: table('release_live').map((l) => ({ component: l.component, commit: String(l.commit_sha).slice(0, 7), since: l.since, version: table('releases').find((r) => r.id === l.release_id)?.version ?? null })),
      health: { engine_seen: eng, arms_online: arms.filter((a) => a.status === 'online').length, arms_active: arms.length, campaigns_running: table('campaigns').filter((x) => ['queued', 'running'].includes(x.status)).length },
    };
  },
  owner_release_decide: (a, c) => {
    if (!c.isSuper) notAllowed();
    const r = table('releases').find((x) => x.id === Number(a.p_id));
    if (!r) return { error: 'עדכון לא נמצא' };
    const act = a.p_action;
    const log = (msg: string) => (r.log = [...(r.log || []), { at: iso(), msg }]);
    if (act === 'approve_now' || act === 'approve_night') {
      if (r.status !== 'pending') return { error: 'העדכון כבר טופל' };
      const night = new Date();
      night.setHours(3, 0, 0, 0);
      if (night.getTime() < now()) night.setDate(night.getDate() + 1);
      Object.assign(r, { status: 'approved', decided_by: c.uid, decided_at: iso(), deploy_after: act === 'approve_night' ? night.toISOString() : iso() });
      log(act === 'approve_night' ? 'אושר לפריסה בלילה' : 'אושר לפריסה מיידית');
    } else if (act === 'reject') {
      if (!['pending', 'approved'].includes(r.status)) return { error: 'אי אפשר לדחות בשלב הזה' };
      Object.assign(r, { status: 'rejected', decided_by: c.uid, decided_at: iso() });
      log('נדחה');
    } else if (act === 'rollback') {
      if (!['live', 'verifying'].includes(r.status)) return { error: 'אפשר להחזיר רק עדכון פעיל' };
      r.status = 'rollback_requested';
      log('התבקשה חזרה לגרסה הקודמת');
    } else return { error: 'פעולה לא מוכרת' };
    logRow(c, homeStation(), 'release_' + act, 'release', String(r.id), { version: r.version }, null);
    return { ok: true };
  },
};

function checkImage(p: any): string | null {
  const d = String(p ?? '').trim() || null;
  if (!d) return null;
  if (!/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,/.test(d)) raise('פורמט תמונה לא נתמך (PNG / JPG / WEBP)');
  if (d.length > 1500000) raise('התמונה גדולה מדי (עד כ-1MB)');
  return d;
}
function genCode() {
  const al = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 8; i++) c += al[Math.floor(Math.random() * al.length)];
  return c;
}

/** run one function as the current caller (the demo version of PostgREST /rpc) */
export function callRpc(name: string, args: Row | undefined) {
  const f = RPC[name];
  if (!f) raise(`Could not find the function public.${name} without parameters in the schema cache`, 'PGRST202');
  const res = f!(args || {}, ctx());
  touch();
  return res;
}
void addDays;
