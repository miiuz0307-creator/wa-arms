// Remove / add jobs: run one at a time, one group at a time, with a pause between actions
// so WhatsApp doesn't see a burst of admin actions from the number.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toIntl } = require('./phone');

const KEEP = 200; // jobs kept in history

class Jobs {
  constructor(arm, dataDir) {
    this.arm = arm;
    this.file = path.join(dataDir, 'jobs.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.list = load(this.file, []);
    this.settings = { delayMin: 3, delayMax: 7, ...load(this.settingsFile, {}) };
    // a job cut off by a restart: what wasn't done stays undone
    for (const j of this.list) {
      if (!j.finishedAt) {
        for (const it of j.items) if (it.status === 'pending' || it.status === 'running') {
          it.status = 'skipped';
          it.message = 'השרת הופעל מחדש לפני הפעולה';
        }
        j.finishedAt = new Date().toISOString();
        j.stopped = true;
      }
    }
    this.running = false;
    this.save();
  }

  save() {
    save(this.file, this.list.slice(0, KEEP));
  }

  setSettings(s) {
    const min = clamp(Number(s.delayMin), 1, 120);
    const max = clamp(Number(s.delayMax), min, 300);
    this.settings = { delayMin: min, delayMax: max };
    save(this.settingsFile, this.settings);
    return this.settings;
  }

  create({ action, number, groups, makeAdmin, by, byId }) {
    if (!['remove', 'add', 'promote', 'demote'].includes(action)) throw new Error('פעולה לא מוכרת');
    const intl = toIntl(number);
    if (!intl) throw new Error('מספר לא תקין');
    const uniq = [...new Map((groups || []).map((g) => [g.id, g])).values()];
    if (!uniq.length) throw new Error('לא נבחרו קבוצות');
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      action,
      makeAdmin: action === 'add' && makeAdmin === true,
      by: by || null,
      byId: byId || null,
      number: intl,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      stopped: false,
      items: uniq.map((g) => ({ groupId: String(g.id), name: String(g.name || g.id).slice(0, 200), status: 'pending', message: '' })),
    };
    this.list.unshift(job);
    this.save();
    this.kick();
    return job;
  }

  stop(id) {
    const j = this.list.find((x) => x.id === id);
    if (!j || j.finishedAt) return false;
    j.stopped = true;
    for (const it of j.items) if (it.status === 'pending') {
      it.status = 'skipped';
      it.message = 'נעצר';
    }
    this.save();
    return true;
  }

  async kick() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = [...this.list].reverse().find((j) => !j.finishedAt);
        if (!job) break;
        let first = true;
        for (const it of job.items) {
          if (job.stopped || it.status !== 'pending') continue;
          if (!first) await sleep(1000 * rand(this.settings.delayMin, this.settings.delayMax));
          if (job.stopped) break;
          first = false;
          it.status = 'running';
          const r = await this.arm.change(job.action, it.groupId, job.number);
          it.status = r.ok ? 'ok' : 'fail';
          it.message = r.message;
          if (r.ok && job.makeAdmin && !job.stopped) {
            await sleep(1500); // WhatsApp needs a moment before the new member can be promoted
            const p = await this.arm.change('promote', it.groupId, job.number);
            it.admin = p.ok;
            it.message = p.ok ? `${r.message} והוגדר כמנהל` : `${r.message}, אבל לא הוגדר כמנהל: ${p.message}`;
            if (!p.ok) it.status = 'fail';
          }
          it.at = new Date().toISOString();
          this.save();
        }
        job.finishedAt = new Date().toISOString();
        this.save();
      }
    } finally {
      this.running = false;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * Math.max(0, b - a);
const clamp = (v, a, b) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a);

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function save(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

module.exports = { Jobs };
