// The life of a ticket: investigate → fix → tests → staging → approval → production → (rollback).
//
// Production is touched in exactly two places, and never at the same time (one production lock):
//   deploy()   – only after a valid one-time approval code, consumed atomically
//   rollback() – on an approver's explicit request (only while the ticket's own deployment is the
//                one running), or automatically when a deploy crashes
const fs = require('fs');
const path = require('path');
const { classify } = require('./classify');
const { redact, diffAddsSecret, newCode, hashCode } = require('./secure');
const { runChecks, warningsFor } = require('./checks');
const { healthCheck } = require('./railway');
const { isForbidden } = require('./workspace');
const M = require('./messages');

const ACTIVE = ['investigating', 'testing', 'staging', 'deploying'];
const MAX_ATTEMPTS = 2;

class Cancelled extends Error {}

function servicesFor(files, all) {
  const out = new Set();
  if (files.some((f) => f.startsWith('engine/'))) out.add('engine');
  if (files.some((f) => f.startsWith('web/'))) out.add('web');
  return [...out].filter((s) => all.includes(s));
}

const maskPhone = (p) => (p ? `${String(p).slice(0, 5)}*****${String(p).slice(-2)}` : '');

function createPipeline(deps) {
  const { cfg, store, wa, railway, github, ws, claude, log } = deps;
  const health = deps.healthCheck || healthCheck;
  const checksRunner = deps.runChecks || runChecks;
  const allServices = Object.keys(cfg.railway.services || {});
  const secrets = [cfg.github.token, cfg.railway.prodToken, cfg.railway.stagingToken, cfg.claudeOauthToken, cfg.anthropicApiKey, cfg.adminPassword, cfg.sessionSecret].filter(Boolean);
  const clean = (s) => redact(s, secrets);
  const cancelRequested = new Set();
  let running = null;
  let prodBusy = null; // ticket id holding the production lock
  let timer = null;
  // one user of the staging branch at a time (a ticket being tested, or a re-stage before production)
  let stagingChain = Promise.resolve();
  const withStagingLock = (fn) => {
    const p = stagingChain.then(fn, fn);
    stagingChain = p.catch(() => {});
    return p;
  };

  // ---------- audit + notifications ----------
  async function audit(ticketId, actor, type, message, data) {
    try {
      await store.addEvent({ ticket_id: ticketId, actor, type, message: clean(message), data: data ? JSON.parse(clean(JSON.stringify(data))) : null });
    } catch (e) {
      log.error({ err: e.message, type, ticketId }, 'AUDIT WRITE FAILED');
    }
  }

  async function sendTo(phone, text, ticketId) {
    try {
      await wa.send(phone, clean(text));
    } catch (e) {
      await audit(ticketId, 'system', 'notify_failed', `לא נשלחה הודעה ל-${maskPhone(phone)}: ${e.message}`);
    }
  }

  async function approvers() {
    return (await store.listNumbers()).filter((n) => n.active && n.role === 'approver');
  }

  /** Requester always; approvers too when `toApprovers`. Each number once. */
  async function notify(t, text, { toApprovers = false } = {}) {
    const to = new Set([t.requester_phone]);
    if (toApprovers) for (const a of await approvers()) to.add(a.phone);
    for (const p of to) await sendTo(p, text, t.id);
  }

  const update = (id, patch) => store.updateTicket(id, patch);

  function checkCancel(id) {
    if (cancelRequested.has(Number(id))) throw new Cancelled();
  }

  // ---------- worker ----------
  function start(intervalMs = 5000) {
    const tick = async () => {
      if (running || prodBusy) return;
      try {
        const t = await store.claimNextTicket();
        if (!t) return;
        running = t.id;
        await processTicket(t);
      } catch (e) {
        log.error({ err: e.message }, 'worker tick failed');
      } finally {
        running = null;
      }
    };
    timer = setInterval(tick, intervalMs);
    return tick;
  }
  const stop = () => clearInterval(timer);

  // ---------- investigate + fix ----------
  async function processTicket(t) {
    let w = null;
    try {
      const area = classify(t.description);
      t = await update(t.id, { area: area.id, status: 'investigating' });
      await audit(t.id, 'system', 'started', `התחלת טיפול (${area.label})`);
      await notify(t, M.started(t));

      if (!claude.ready()) throw new Error('חסרה הגדרה: חיבור ל-Claude (CLAUDE_CODE_OAUTH_TOKEN)');
      if (!github.ready()) throw new Error('חסרה הגדרה: גישה ל-GitHub (GITHUB_TOKEN)');

      const branch = `fix/ticket-${t.id}-${area.id}`;
      w = await ws.prepare(t.id, branch);
      t = await update(t.id, { branch, base_sha: w.baseSha || null });
      checkCancel(t.id);

      const logsFile = await collectLogs(t, area, w);
      const images = copyImages(t, w);

      let previousFailure = null;
      let result = null;
      let checks = null;
      let files = [];
      let cost = 0;
      const warnings = new Set();

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        checkCancel(t.id);
        t = await update(t.id, { status: 'investigating' });
        await audit(t.id, 'claude', 'claude_run', attempt === 1 ? 'Claude בודק את הקוד' : 'Claude מתקן אחרי כישלון בדיקות');
        const r = await claude.investigate({ w, ticket: t, area, logsFile, images, previousFailure });
        cost += r.cost;
        if (r.parsed) result = r.parsed;
        if (r.denials) await audit(t.id, 'claude', 'tool_denied', `נחסמו ${r.denials} ניסיונות של Claude להשתמש בכלים לא מורשים`);

        const { refused } = await ws.sync(w);
        if (refused.length) {
          warnings.add(`קישורים או קבצים חריגים לא הועתקו: ${refused.slice(0, 5).join(', ')}`);
          await audit(t.id, 'system', 'files_refused', 'קבצים חריגים (קישורים) לא הועתקו מהעותק', { files: refused.slice(0, 20) });
        }
        files = await ws.changedFiles(w);
        const dropped = await ws.dropForbidden(w, files);
        if (dropped.length) {
          warnings.add(`בוטלו שינויים בקבצים אסורים: ${dropped.join(', ')}`);
          await audit(t.id, 'system', 'forbidden_reverted', 'בוטלו שינויים בקבצים אסורים', { files: dropped });
          files = await ws.changedFiles(w);
        }
        if (!files.length) break;

        checkCancel(t.id);
        t = await update(t.id, { status: 'testing' });
        checks = await checksRunner(ws, w, files);
        await audit(t.id, 'system', checks.ok ? 'tests_passed' : 'tests_failed', checks.ok ? 'הבדיקות האוטומטיות עברו' : 'הבדיקות האוטומטיות נכשלו', {
          steps: checks.steps.map((s) => ({ name: s.name, ok: s.ok })),
        });
        if (checks.ok) break;
        previousFailure = clean(checks.steps.filter((s) => !s.ok).map((s) => `${s.name}:\n${s.output}`).join('\n\n')).slice(-3000);
      }

      const base = { summary: result?.summary || null, root_cause: result?.rootCause || null, risk: result?.risk || null, cost_usd: cost };

      if (!files.length) {
        t = await update(t.id, { ...base, status: 'no_fix' });
        await audit(t.id, 'claude', 'no_fix', 'לא בוצע שינוי בקוד', { notes: result?.notes });
        await notify(t, M.noFix(t));
        return;
      }

      const { diff, stat, names } = await ws.stageAll(w);
      // fail closed: nothing that touches a forbidden path is ever committed
      const stillForbidden = names.filter(isForbidden);
      if (stillForbidden.length) {
        await ws.unstage(w);
        throw new Error(`השינוי נוגע בקבצים אסורים (${stillForbidden.join(', ')}). עצרתי בלי לשמור אותו.`);
      }
      if (diffAddsSecret(diff)) {
        await ws.unstage(w);
        throw new Error('השינוי נראה כאילו הוא מוסיף סיסמה או מפתח לקוד. עצרתי בלי לשמור אותו.');
      }
      for (const x of warningsFor(names, diff)) warnings.add(x);
      const warningList = [...warnings];
      const testResult = { ok: checks.ok, steps: checks.steps.map((s) => ({ name: s.name, ok: s.ok, output: clean(s.output || '').slice(-1500) })) };

      // save the change on its own branch + PR (also when tests failed, for review only)
      const title = `BotiX Repair #${t.id}: ${(result?.summary || t.description).slice(0, 70)}`;
      const sha = await ws.commitAndPush(w, branch, `${title}\n\nפנייה #${t.id} מ-${t.requester_name || ''} (${maskPhone(t.requester_phone)})`);
      const pr = await github.openPr({ head: branch, title: checks.ok ? title : `[לא עבר בדיקות] ${title}`, body: clean(prBody(t, result, testResult, warningList)) });
      t = await update(t.id, { ...base, files: names, diff_stat: hebStat(stat, names.length), warnings: warningList, test_result: testResult, pr_url: pr.html_url, pr_number: pr.number });
      await audit(t.id, 'system', 'branch_pushed', `התיקון נשמר בענף ${branch}`, { pr: pr.html_url, files: names, sha });

      if (!checks.ok) {
        const firstFail = checks.steps.find((s) => !s.ok);
        t = await update(t.id, { status: 'failed', error: `הבדיקות נכשלו: ${firstFail?.name || ''}` });
        await notify(t, M.testsFailed(t, clean(firstFail?.output || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)));
        return;
      }

      // ---------- staging: mandatory ----------
      checkCancel(t.id);
      if (!railway.ready('staging')) {
        t = await update(t.id, { status: 'blocked', staging_result: { ok: false, skipped: true, reason: 'not_configured', sha } });
        await audit(t.id, 'system', 'blocked', 'סביבת הבדיקה לא מוגדרת – אין העלאה לייצור');
        await notify(t, M.blocked(t, 'סביבת הבדיקה (staging) עוד לא הוגדרה, ולכן לא אבקש אישור להעלאה לשרת הפעיל.'), { toApprovers: true });
        return;
      }
      t = await update(t.id, { status: 'staging' });
      const staging = await withStagingLock(() => runStaging(t, names, () => ws.pushTo(w, cfg.github.stagingBranch, { force: true })));
      staging.sha = sha;
      t = await update(t.id, { staging_result: staging });
      if (!staging.ok) {
        t = await update(t.id, { status: 'failed', error: `סביבת הבדיקה נכשלה: ${staging.reason}` });
        await notify(t, M.failed(t, `התיקון לא עלה תקין בסביבת הבדיקה (${staging.reason}).`), { toApprovers: true });
        return;
      }

      checkCancel(t.id);
      await requestApproval(t);
    } catch (e) {
      if (e instanceof Cancelled) {
        t = await update(t.id, { status: 'cancelled' });
        await audit(t.id, 'system', 'cancelled', 'הטיפול בוטל לפי בקשה');
        await notify(t, `🛑 פנייה *#${t.id}* בוטלה. שום דבר לא הועלה לשרת.`);
      } else {
        const msg = clean(e.message).slice(0, 500);
        log.error({ ticket: t.id, err: msg }, 'ticket failed');
        t = await update(t.id, { status: 'failed', error: msg });
        await audit(t.id, 'system', 'failed', msg);
        await notify(t, M.failed(t, msg));
      }
    } finally {
      cancelRequested.delete(Number(t.id));
      if (w) ws.cleanup(w);
    }
  }

  async function collectLogs(t, area, w) {
    if (!railway.ready('production')) {
      await audit(t.id, 'system', 'logs_skipped', 'אין גישה ללוגים של Railway (RAILWAY_PROD_TOKEN חסר)');
      return null;
    }
    const parts = [];
    for (const svc of area.services.filter((s) => allServices.includes(s))) {
      try {
        let lines = area.logFilter ? await railway.logs('production', svc, { limit: 300, filter: area.logFilter }) : [];
        if (lines.length < 20) lines = await railway.logs('production', svc, { limit: 300 });
        parts.push(`===== ${svc} (${lines.length} lines) =====`);
        for (const l of lines) parts.push(`${l.timestamp} [${l.severity || ''}] ${l.message}`);
      } catch (e) {
        parts.push(`===== ${svc}: logs unavailable (${e.message}) =====`);
      }
    }
    await audit(t.id, 'system', 'logs_read', `נקראו לוגים מ-${area.services.join(', ')}`);
    return ws.writeContext(w, 'logs.txt', clean(parts.join('\n')));
  }

  function copyImages(t, w) {
    const out = [];
    (t.images || []).forEach((img, i) => {
      try {
        const src = path.join(cfg.dataDir, 'media', path.basename(img.file));
        if (!fs.existsSync(src)) return;
        out.push(ws.writeContext(w, `screenshot-${i + 1}${path.extname(img.file) || '.jpg'}`, fs.readFileSync(src)));
      } catch {}
    });
    return out;
  }

  /** Push to the staging branch (via `push`), wait for Railway, health-check. */
  async function runStaging(t, files, push) {
    const touched = servicesFor(files, allServices);
    const since = new Date();
    await push();
    await audit(t.id, 'system', 'staging_push', `התיקון נדחף לענף ${cfg.github.stagingBranch}`);
    const waits = await Promise.all(
      allServices.map(async (svc) => {
        const must = touched.includes(svc) || touched.length === 0;
        const d = await railway.waitForNew('staging', svc, since, must ? cfg.deployWaitMin : 3);
        return { service: svc, must, status: d.status, id: d.id || null };
      }),
    );
    const bad = waits.find((x) => x.status !== 'SUCCESS' && (x.must || x.status !== 'TIMEOUT'));
    let result;
    if (bad) result = { ok: false, reason: `${bad.service}: ${bad.status}`, services: waits };
    else {
      const h = cfg.stagingHealthUrls.length ? await health(cfg.stagingHealthUrls) : { ok: true, results: [] };
      result = h.ok ? { ok: true, services: waits, health: h.results } : { ok: false, reason: 'בדיקת תקינות נכשלה', services: waits, health: h.results };
    }
    await audit(t.id, 'system', result.ok ? 'staging_passed' : 'staging_failed', result.ok ? 'סביבת הבדיקה עלתה ותקינה' : `סביבת הבדיקה נכשלה: ${result.reason}`, result);
    return result;
  }

  // ---------- approval ----------
  async function pendingRevertWarning() {
    const rolled = await store.listTickets(20, ['rolled_back']);
    for (const r of rolled) {
      const n = r.deploy?.rollback?.revertPrNumber;
      if (!n || !github.getPr) continue;
      const pr = await github.getPr(n).catch(() => null);
      if (pr && pr.state === 'open' && !pr.merged) {
        return `פנייה #${r.id} הוחזרה, אבל בקשת הביטול שלה בקוד עוד לא אושרה (${pr.html_url}). אישור עכשיו יחזיר גם את השינוי של #${r.id}.`;
      }
    }
    return null;
  }

  async function requestApproval(t) {
    const list = await approvers();
    if (!list.length) {
      t = await update(t.id, { status: 'blocked' });
      await audit(t.id, 'system', 'blocked', 'אין מספר עם הרשאת מאשר');
      await notify(t, M.blocked(t, 'אין אף מספר עם הרשאת "מאשר". הוסיפו מאשר בממשק הניהול.'));
      return;
    }
    const revertWarn = await pendingRevertWarning();
    if (revertWarn && !(t.warnings || []).includes(revertWarn)) t = await update(t.id, { warnings: [...(t.warnings || []), revertWarn] });

    const code = newCode();
    const expires = new Date(Date.now() + cfg.approvalMinutes * 60_000);
    await store.createApproval({ ticket_id: t.id, code_hash: hashCode(cfg.sessionSecret, t.id, code), expires_at: expires.toISOString() });
    t = await update(t.id, { status: 'awaiting_approval' });
    await audit(t.id, 'system', 'approval_requested', `נשלחה בקשת אישור (תקפה עד ${expires.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' })})`);
    const text = M.approvalRequest(t, code, cfg.approvalMinutes);
    // the code goes to approvers only
    for (const a of list) await sendTo(a.phone, text, t.id);
    if (!list.some((a) => a.phone === t.requester_phone)) {
      await sendTo(t.requester_phone, `✅ פנייה *#${t.id}*: התיקון מוכן ועבר בדיקות. נשלח למאשר לאישור.`, t.id);
    }
  }

  /** "אשר 123456" from an approver. Returns a reply text, or null when deploy() reports itself. */
  async function approve(phone, code, byName) {
    if (prodBusy) return `⏳ פנייה #${prodBusy} מועלית או מוחזרת כרגע. נסו שוב בעוד כמה דקות (הקוד עדיין תקף).`;
    const waiting = await store.listTickets(20, ['awaiting_approval']);
    for (const t of waiting) {
      const a = await store.activeApproval(t.id);
      if (!a || a.code_hash !== hashCode(cfg.sessionSecret, t.id, code)) continue;
      if (prodBusy) return `⏳ פנייה #${prodBusy} מועלית כרגע. נסו שוב בעוד כמה דקות.`;
      prodBusy = t.id; // taken before the next await, so a parallel approval waits
      const used = await store.consumeApproval(a.id, phone);
      if (!used) {
        prodBusy = null;
        return M.badCode;
      }
      const moved = await store.transitionTicket(t.id, ['awaiting_approval'], { status: 'deploying' });
      if (!moved) {
        prodBusy = null;
        return `פנייה #${t.id} כבר לא ממתינה לאישור.`;
      }
      await audit(t.id, phone, 'approved', `אושר להעלאה על ידי ${byName || maskPhone(phone)}`);
      deploy(moved, byName || maskPhone(phone))
        .catch((e) => log.error({ err: e.message }, 'deploy crashed'))
        .finally(() => {
          if (prodBusy === t.id) prodBusy = null;
        });
      return null;
    }
    // wrong code: count attempts; after 5, all open codes are cancelled
    for (const t of waiting) {
      const a = await store.activeApproval(t.id);
      if (!a) continue;
      const attempts = (a.attempts || 0) + 1;
      await store.updateApproval(a.id, { attempts, ...(attempts >= 5 ? { expires_at: new Date().toISOString() } : {}) });
      if (attempts >= 5) await audit(t.id, phone, 'approval_locked', 'יותר מדי קודים שגויים – קוד האישור בוטל');
    }
    await audit(null, phone, 'approval_bad_code', 'נשלח קוד אישור שגוי או שפג תוקפו');
    return M.badCode;
  }

  /** Re-send the approval request with a fresh code (approver asked for the ticket). */
  async function reissueApproval(id) {
    const t = await store.getTicket(id);
    if (t?.status !== 'awaiting_approval') return;
    const a = await store.activeApproval(id);
    if (a) await store.updateApproval(a.id, { expires_at: new Date().toISOString() });
    await requestApproval(t);
  }

  /** main moved since this fix was built and tested: never merge an untested combination. */
  async function requeueStale(t) {
    if (t.pr_number) await github.closePr(t.pr_number).catch(() => {});
    t = await update(t.id, { status: 'failed', error: 'הענף הראשי השתנה מאז שהתיקון נבדק – לא הועלה. נפתחה פנייה חדשה שתבנה ותבדוק אותו מחדש.' });
    const fresh = await store.createTicket({ requester_phone: t.requester_phone, requester_name: t.requester_name, description: t.description, images: t.images || [], graceSec: 0 });
    await audit(t.id, 'system', 'stale_base', `הענף הראשי השתנה מאז הבדיקה. לא הועלה; נפתחה פנייה #${fresh.id} במקומה`);
    await audit(fresh.id, 'system', 'ticket_created', `נפתחה מחדש במקום פנייה #${t.id} (הענף הראשי השתנה)`);
    await notify(t, `🔁 *פנייה #${t.id}* לא הועלתה: מאז שהתיקון נבדק עלה לשרת שינוי אחר, והשילוב ביניהם לא נבדק.\nפתחתי את פנייה *#${fresh.id}* שתבנה ותבדוק את התיקון מחדש, ותבקש אישור שוב.`, { toApprovers: true });
  }

  // ---------- production (called with the production lock held) ----------
  async function deploy(t, by) {
    await notify(t, M.deploying(t, by), { toApprovers: true });
    const files = t.files || [];
    const touched = servicesFor(files, allServices);
    const prev = {};
    try {
      if (!railway.ready('production')) throw new Error('חסר RAILWAY_PROD_TOKEN – אי אפשר לעקוב אחרי ההעלאה ולחזור אחורה');

      // the code that goes to production must be exactly the code that passed staging:
      // same fix commit, built on the same main
      const stagedSha = t.staging_result?.sha;
      if (!stagedSha) throw new Error('לא נמצאה גרסה שעברה את סביבת הבדיקה');
      const mainNow = await ws.remoteSha(cfg.github.baseBranch);
      if (t.base_sha && mainNow && mainNow !== t.base_sha) {
        await requeueStale(t);
        return;
      }
      await withStagingLock(async () => {
        const stagingNow = await ws.remoteSha(cfg.github.stagingBranch);
        if (stagingNow === stagedSha) return;
        await audit(t.id, 'system', 'restage', 'סביבת הבדיקה הכילה גרסה אחרת – מעלה אליה שוב את התיקון הזה לפני הייצור');
        const again = await runStaging(t, files, () => ws.pushBranchTo(t.id, t.branch, cfg.github.stagingBranch));
        again.sha = stagedSha;
        t = await update(t.id, { staging_result: again });
        if (!again.ok) throw new Error(`הבדיקה החוזרת בסביבת הבדיקה נכשלה: ${again.reason}`);
      });

      for (const svc of allServices) {
        const d = await railway.latest('production', svc, { successfulOnly: true });
        if (d) prev[svc] = d.id;
      }
      const since = new Date();
      const merged = await github.mergePr(t.pr_number, `BotiX Repair #${t.id} (אושר על ידי ${by})`, stagedSha);
      const deployInfo = { by, at: since.toISOString(), prev, mergeSha: merged.sha, services: [] };
      t = await update(t.id, { deploy: deployInfo });
      await audit(t.id, 'system', 'merged', 'התיקון מוזג לענף הראשי – Railway מעלה גרסה חדשה', { sha: merged.sha });

      const waits = await Promise.all(
        allServices.map(async (svc) => {
          const must = touched.includes(svc) || touched.length === 0;
          const d = await railway.waitForNew('production', svc, since, must ? cfg.deployWaitMin : 3);
          return { service: svc, must, status: d.status, id: d.id || null };
        }),
      );
      deployInfo.services = waits;
      const bad = waits.find((x) => x.status !== 'SUCCESS' && (x.must || x.status !== 'TIMEOUT'));
      let reason = bad ? `${bad.service}: ${bad.status}` : null;
      if (!reason && cfg.prodHealthUrls.length) {
        const h = await health(cfg.prodHealthUrls);
        deployInfo.health = h.results;
        if (!h.ok) reason = 'בדיקת תקינות נכשלה אחרי ההעלאה';
      }
      t = await update(t.id, { deploy: deployInfo });

      if (!reason) {
        t = await update(t.id, { status: 'deployed' });
        await audit(t.id, 'system', 'deployed', 'ההעלאה לשרת הפעיל הצליחה', { services: waits });
        await notify(t, M.deployed(t), { toApprovers: true });
        return;
      }

      await audit(t.id, 'system', 'deploy_failed', `ההעלאה נכשלה: ${reason}`, { services: waits });
      if (cfg.autoRollback) {
        await doRollback('system', t, { reason, auto: true });
        t = await store.getTicket(t.id);
        await notify(t, M.deployFailed(t, reason, t.status === 'rolled_back'), { toApprovers: true });
      } else {
        t = await update(t.id, { status: 'failed', error: reason });
        await notify(t, M.deployFailed(t, reason, false), { toApprovers: true });
      }
    } catch (e) {
      const msg = clean(e.message);
      t = await update(t.id, { status: 'failed', error: msg });
      await audit(t.id, 'system', 'deploy_failed', msg);
      await notify(t, M.deployFailed(t, msg, false), { toApprovers: true });
    }
  }

  /** Approver/admin request. Refused while another production action runs, or when a newer deploy replaced this one. */
  async function rollback(actor, id) {
    if (prodBusy) return `⏳ פנייה #${prodBusy} מועלית או מוחזרת כרגע. נסו שוב בעוד כמה דקות.`;
    const lock = `rollback-${id}`;
    prodBusy = lock; // taken with no await before it
    try {
      const t = await store.getTicket(id);
      if (!t) return M.notFound(id);
      if (!['deployed', 'failed'].includes(t.status) || !t.deploy?.prev || !Object.keys(t.deploy.prev).length) {
        return `אי אפשר להחזיר את פנייה #${id} במצב "${M.statusLabel(t.status)}".`;
      }
      // only while this ticket's deployment is still the one running – never jump back over newer deploys.
      // For a service whose new deployment failed, production must still be on the "before" version.
      const mine = Object.fromEntries((t.deploy.services || []).filter((s) => s.status === 'SUCCESS').map((s) => [s.service, s.id]));
      for (const svc of targetsFor(t)) {
        const expected = mine[svc] || t.deploy.prev[svc];
        const current = await railway.latest('production', svc, { successfulOnly: true });
        if (current && current.id !== expected) {
          await audit(t.id, actor, 'rollback_refused', `החזרה נדחתה: ב-${svc} רצה כבר גרסה חדשה יותר`);
          return `לא החזרתי: ב-${svc} רצה כבר גרסה חדשה יותר מפנייה #${id}. חזרה עכשיו הייתה מוחקת גם את מה שעלה אחריה. בחרו את הפנייה האחרונה שהועלתה.`;
        }
      }
      await doRollback(actor, t, {});
      return null;
    } finally {
      if (prodBusy === lock) prodBusy = null;
    }
  }

  function targetsFor(t) {
    const prev = t.deploy?.prev || {};
    const touched = servicesFor(t.files || [], Object.keys(prev));
    return touched.length ? touched : Object.keys(prev);
  }

  async function doRollback(actor, t, { reason, auto = false }) {
    const prev = t.deploy?.prev || {};
    const targets = targetsFor(t);
    const done = [];
    const errors = [];
    for (const svc of targets) {
      try {
        await railway.rollback('production', prev[svc]);
        done.push(svc);
      } catch (e) {
        errors.push(`${svc}: ${e.message}`);
      }
    }
    let revertPr = null;
    let revertPrNumber = null;
    if (t.deploy?.mergeSha) {
      try {
        const branch = await ws.revertBranch(t.id, t.deploy.mergeSha);
        const pr = await github.openPr({
          head: branch,
          title: `ביטול BotiX Repair #${t.id}`,
          body: `השרת הפעיל הוחזר לגרסה הקודמת${reason ? ` (${clean(reason)})` : ''}.\nהבקשה הזו מבטלת את השינוי גם בקוד, כדי שהעלאה הבאה לא תחזיר אותו.\n\n🤖 BotiX AI Repair`,
        });
        revertPr = pr.html_url;
        revertPrNumber = pr.number;
      } catch (e) {
        errors.push(`revert: ${e.message}`);
      }
    }
    const ok = targets.length > 0 && done.length === targets.length;
    t = await update(t.id, {
      status: ok ? 'rolled_back' : 'failed',
      error: errors.length ? clean(errors.join(' | ')) : t.error,
      deploy: { ...t.deploy, rollback: { by: actor, at: new Date().toISOString(), services: done, revertPr, revertPrNumber, errors: errors.map(clean) } },
    });
    await audit(t.id, actor, ok ? 'rolled_back' : 'rollback_failed', ok ? `השרת הוחזר לגרסה הקודמת (${done.join(', ')})` : `החזרה חלקית: ${errors.join(' | ')}`);
    if (!auto) await notify(t, ok ? M.rolledBack(t, revertPr) : M.failed(t, `החזרה לגרסה הקודמת נכשלה: ${errors.join(' | ')}. כדאי לבדוק ב-Railway.`), { toApprovers: true });
  }

  async function reject(actor, id) {
    const t = await store.transitionTicket(id, ['awaiting_approval', 'blocked'], { status: 'rejected' });
    if (!t) {
      const cur = await store.getTicket(id);
      return cur ? `אי אפשר לדחות את פנייה #${id} במצב "${M.statusLabel(cur.status)}".` : M.notFound(id);
    }
    const a = await store.activeApproval(id);
    if (a) await store.updateApproval(a.id, { expires_at: new Date().toISOString() });
    if (t.pr_number) await github.closePr(t.pr_number).catch(() => {});
    await audit(t.id, actor, 'rejected', 'התיקון נדחה');
    return `👍 פנייה #${id} נדחתה. שום דבר לא הועלה לשרת.`;
  }

  async function cancel(actor, id, { isApprover }) {
    const t = await store.getTicket(id);
    if (!t) return M.notFound(id);
    if (!isApprover && t.requester_phone !== actor) return M.approverOnly;
    if (await store.transitionTicket(id, ['queued'], { status: 'cancelled' })) {
      await audit(t.id, actor, 'cancelled', 'הפנייה בוטלה לפני תחילת הטיפול');
      return `🛑 פנייה #${id} בוטלה.`;
    }
    const now = await store.getTicket(id);
    if (['investigating', 'testing', 'staging'].includes(now.status)) {
      cancelRequested.add(Number(id));
      await audit(t.id, actor, 'cancel_requested', 'התבקש ביטול – ייעצר בשלב הבא');
      return `🛑 עוצר את פנייה #${id} בשלב הבא.`;
    }
    if (['awaiting_approval', 'blocked'].includes(now.status)) return reject(actor, id);
    return `אי אפשר לבטל את פנייה #${id} במצב "${M.statusLabel(now.status)}".`;
  }

  return {
    start,
    stop,
    processTicket,
    approve,
    reissueApproval,
    rollback,
    reject,
    cancel,
    audit,
    isRunning: () => running,
    prodBusy: () => prodBusy,
    ACTIVE,
  };
}

function hebStat(stat, n) {
  const ins = /(\d+) insertion/.exec(stat)?.[1] || 0;
  const del = /(\d+) deletion/.exec(stat)?.[1] || 0;
  return `${n} קבצים, ${ins} שורות נוספו, ${del} נמחקו`;
}

function prBody(t, result, checks, warnings) {
  return [
    `## פנייה #${t.id}`,
    `**ביקש:** ${t.requester_name || ''} (${maskPhone(t.requester_phone)})`,
    `**התיאור:** ${t.description.slice(0, 500)}`,
    '',
    `**מה נמצא:** ${result?.summary || '-'}`,
    `**הסיבה:** ${result?.rootCause || '-'}`,
    `**רמת סיכון:** ${result?.risk || '-'}`,
    '',
    '### בדיקות',
    ...(checks?.steps || []).map((s) => `- ${s.ok ? '✅' : '❌'} ${s.name}`),
    ...(warnings.length ? ['', '### אזהרות', ...warnings.map((w) => `- ⚠️ ${w}`)] : []),
    '',
    'הבקשה נוצרה אוטומטית. היא תמוזג רק אחרי אישור מפורש בוואטסאפ, ואחרי שעברה את סביבת הבדיקה.',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

module.exports = { createPipeline, servicesFor };
