// Demo arm: same interface as the real one, made-up groups, no WhatsApp at all.
const { toIntl } = require('./phone');

const NAMES = [
  'נהגים 8080 צפון', 'נהגים 8080 מרכז', 'נהגים 8080 דרום', 'הסעות ירושלים', 'מוניות חיפה והקריות',
  'נסיעות נתב"ג', 'סדרנים ראשי', 'עזרה בין תחנות', 'הסעות אילת', 'נהגי לילה', 'תיירות VIP',
  'הסעות שבת', 'מוניות פתח תקווה', 'נסיעות בין עירוניות', 'קבוצת מבצעים', 'חדשות התחנה',
];
const DEMO_NUMBER = '972501234567';

class DemoArm {
  constructor() {
    this.state = 'online';
    this.groups = new Map();
    NAMES.forEach((name, i) => {
      const members = new Set(Array.from({ length: 20 + ((i * 37) % 180) }, (_, k) => `9725${String(10000000 + i * 1000 + k)}`));
      if (i % 3 !== 1) members.add(DEMO_NUMBER);
      this.groups.set(`demo${i}@g.us`, { id: `demo${i}@g.us`, name, members, admin: i % 5 !== 4 });
    });
    this.groupsAt = new Date().toISOString();
  }

  async start() {}

  status() {
    return {
      state: this.state,
      qr: null,
      phone: '972500000000',
      groups: this.groups.size,
      adminOf: [...this.groups.values()].filter((g) => g.admin).length,
      groupsAt: this.groupsAt,
      lastError: null,
      demo: true,
    };
  }

  async refreshGroups() {
    this.groupsAt = new Date().toISOString();
  }

  async lookup(raw) {
    const intl = toIntl(raw);
    if (!intl) throw new Error('מספר לא תקין');
    const inGroups = [];
    const notIn = [];
    for (const g of this.groups.values()) {
      const row = { id: g.id, name: g.name, size: g.members.size, iAmAdmin: g.admin };
      if (g.members.has(intl)) inGroups.push({ ...row, memberId: intl, memberAdmin: false });
      else notIn.push(row);
    }
    return { number: intl, onWhatsApp: true, inGroups, notIn };
  }

  async change(action, groupId, intl) {
    await new Promise((r) => setTimeout(r, 300));
    const g = this.groups.get(groupId);
    if (!g) return { ok: false, code: 'nogroup', message: 'הזרוע כבר לא בקבוצה' };
    if (!g.admin) return { ok: false, code: 'notadmin', message: 'הזרוע לא מנהלת בקבוצה' };
    if (action === 'add' && g.name.includes('VIP')) return { ok: false, code: '403', message: 'הגדרות הפרטיות של המספר חוסמות צירוף – צריך לשלוח לו קישור הזמנה' };
    if (action === 'promote') return { ok: true, code: '200', message: 'הוגדר כמנהל' };
    if (action === 'remove') g.members.delete(intl);
    else g.members.add(intl);
    return { ok: true, code: '200', message: action === 'remove' ? 'הוסר' : 'צורף' };
  }

  async logout() {}
}

module.exports = { DemoArm };
