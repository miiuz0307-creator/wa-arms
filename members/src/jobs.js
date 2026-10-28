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
    this.settings = { delayMin: 10, delayMax: 20, ...load(this.settingsFile, {}) };
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
    // one-time move to a safer pace: 3–7 s between group actions led WhatsApp to rate-limit the number
    if (!this.settings.paced) {
      if (this.settings.delayMin < 10) this.settings = { ...this.settings, delayMin: 10, delayMax: Math.max(20, this.settings.delayMax) };
      this.settings.paced = true;
      save(this.settingsFile, this.settings);
    }
    this.save();
  }

  save() {
    save(this.file, this.list.slice(0, KEEP));
  }

  setSettings(s) {
    const min = clamp(Number(s.delayMin), 1, 120);
    const max = clamp(Number(s.delayMax), min, 300);
    this.settings = { delayMin: min, delayMax: max, paced: true };
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
          // after a rate limit the pace slows down (x2, x4) until the job ends
          if (!first) await sleep(1000 * rand(this.settings.delayMin, this.settings.delayMax) * (this.slow || 1));
          if (job.stopped) break;
          first = false;
          it.status = 'running';
          let r = await this.arm.change(job.action, it.groupId, job.number);
          // WhatsApp rate limit: pause (2, 5, then 10 minutes), retry the same group, and go slower afterwards
          for (const wait of [2, 5, 10]) {
            if (r.code !== 'rate' || job.stopped) break;
            it.message = `וואטסאפ הגביל זמנית – ממתין ${wait} דקות וממשיך לבד`;
            job.pausedUntil = new Date(Date.now() + wait * 60_000).toISOString();
            this.save();
            await sleep(wait * 60_000);
            job.pausedUntil = null;
            this.slow = Math.min(4, (this.slow || 1) * 2);
            if (job.stopped) break;
            r = await this.arm.change(job.action, it.groupId, job.number);
          }
          if (r.code === 'rate') r.message = 'וואטסאפ הגביל את קצב הפעולות – נסה שוב מאוחר יותר';
          // the arm got disconnected mid-job: stop instead of failing every remaining group
          if (r.code === 'offline') {
            it.status = 'fail'; it.message = r.message;
            for (const rest of job.items) if (rest.status === 'pending') { rest.status = 'skipped'; rest.message = 'נעצר – הזרוע התנתקה'; }
            job.stopped = true;
            this.save();
            break;
          }
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
        this.slow = 1;
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
