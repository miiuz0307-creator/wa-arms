const test = require('node:test');
const assert = require('node:assert');
const { createPipeline } = require('../src/pipeline');
const { createIntake } = require('../src/intake');
const h = require('./helpers');

const OWNER = '972501111111';
const ASKER = '972502222222';
const ok = { ok: true, steps: [{ name: 'בדיקות המנוע', ok: true, output: 'pass' }] };
const bad = { ok: false, steps: [{ name: 'בדיקות המנוע', ok: false, output: 'AssertionError: expected 1' }] };
const parsed = { changed: true, summary: 'תוקן תור השליחה', rootCause: 'שאילתה בלי catch', risk: 'low', files: ['engine/src/arm.js'], notes: '' };

async function setup({ files = ['engine/src/arm.js'], checks = [ok], claudeResults = [{ parsed }], railway = {}, cfg = {}, diff, sticky = false } = {}) {
  const store = h.createMemoryStore();
  await store.addNumber({ phone: OWNER, name: 'מיכאל', role: 'approver' });
  await store.addNumber({ phone: ASKER, name: 'דני', role: 'requester' });
  const scenario = { files, diff, sticky };
  const deps = {
    cfg: h.makeCfg(cfg),
    store,
    wa: h.fakeWa(),
    railway: h.fakeRailway(railway),
    github: h.fakeGitHub(),
    ws: h.fakeWs(scenario),
    claude: h.fakeClaude(claudeResults),
    log: h.silentLog,
    healthCheck: async () => ({ ok: true, results: [] }),
  };
  let i = 0;
  deps.runChecks = async () => checks[Math.min(i++, checks.length - 1)];
  const pipeline = createPipeline(deps);
  const intake = createIntake({ cfg: deps.cfg, store, wa: deps.wa, pipeline, log: h.silentLog });
  const say = (phone, text, extra = {}) => intake.handle({ jid: `${phone}@s.whatsapp.net`, phone, lid: null, name: '', text, image: null, ...extra });
  const runNext = async () => {
    const t = await store.claimNextTicket();
    await pipeline.processTicket(t);
    return store.getTicket(t.id);
  };
  return { ...deps, scenario, pipeline, intake, say, runNext };
}

const codeFrom = (texts) => {
  const m = texts.join('\n').match(/אשר (\d{6})/);
  return m && m[1];
};

test('stranger is refused, logged, answered only once', async () => {
  const s = await setup();
  await s.say('972509999999', 'ההפצה לא עובדת');
  await s.say('972509999999', 'שוב');
  assert.equal(s.wa.textsTo('972509999999@s.whatsapp.net').length, 1);
  assert.equal((await s.store.listTickets()).length, 0);
  const ev = await s.store.listEvents();
  assert.equal(ev.filter((e) => e.type === 'rejected_sender').length, 2);
});

test('full happy path: ticket → fix → tests → staging → approval → production', async () => {
  const s = await setup();
  await s.say(ASKER, 'ההפצה לא עובדת, נתקע על שולח');
  const t0 = (await s.store.listTickets())[0];
  assert.equal(t0.status, 'queued');

  const t = await s.runNext();
  assert.equal(t.status, 'awaiting_approval');
  assert.equal(t.area, 'distribution');
  assert.equal(t.branch, 'fix/ticket-1-distribution');
  assert.equal(s.ws.calls.stagingPush, 1);
  assert.ok(t.pr_url);
  assert.equal(s.github.calls.merged.length, 0, 'nothing merged before approval');

  // logs went to Claude redacted
  assert.ok(!s.ws.calls.context['logs.txt'].includes('abcdef1234567890'));
  assert.ok(!s.ws.calls.context['logs.txt'].includes('0521234567'));

  // the code goes to the approver only, not to the requester
  const code = codeFrom(s.wa.textsTo(OWNER));
  assert.match(code, /^\d{6}$/);
  assert.equal(codeFrom(s.wa.textsTo(ASKER)), null);

  // requester cannot approve
  await s.say(ASKER, `אשר ${code}`);
  assert.equal((await s.store.getTicket(1)).status, 'awaiting_approval');

  // wrong code
  await s.say(OWNER, 'אשר 000000');
  assert.ok(s.wa.textsTo(`${OWNER}@s.whatsapp.net`).some((x) => x.includes('הקוד לא נכון')));
  assert.equal((await s.store.getTicket(1)).status, 'awaiting_approval');

  await s.say(OWNER, `אשר ${code}`);
  await h.waitFor(async () => (await s.store.getTicket(1)).status === 'deployed');
  const done = await s.store.getTicket(1);
  assert.equal(s.github.calls.merged[0], done.pr_number);
  assert.deepEqual(done.deploy.prev, { engine: 'production-engine-prev', web: 'production-web-prev' });
  assert.equal(s.ws.calls.restage, 0, 'staging still had this fix – no re-stage needed');

  // a code works once
  await s.say(OWNER, `אשר ${code}`);
  assert.equal(s.github.calls.merged.length, 1);

  const types = (await s.store.listEvents({ ticketId: 1 })).map((e) => e.type);
  for (const x of ['ticket_created', 'started', 'logs_read', 'tests_passed', 'branch_pushed', 'staging_passed', 'approval_requested', 'approved', 'merged', 'deployed']) {
    assert.ok(types.includes(x), `missing audit event ${x}`);
  }
});

test('no code change → no_fix, nothing pushed', async () => {
  const s = await setup({ files: [], claudeResults: [{ parsed: { ...parsed, changed: false, summary: 'הבעיה בהגדרות הטלפון' } }] });
  await s.say(ASKER, 'זרוע 2 מנותקת');
  const t = await s.runNext();
  assert.equal(t.status, 'no_fix');
  assert.equal(s.ws.calls.pushed.length, 0);
  assert.ok(s.wa.textsTo(ASKER).some((x) => x.includes('הבעיה בהגדרות הטלפון')));
});

test('staging missing → blocked, never asks for approval', async () => {
  const s = await setup({ railway: { staging: false } });
  await s.say(ASKER, 'ההפצה לא עובדת');
  const t = await s.runNext();
  assert.equal(t.status, 'blocked');
  assert.equal(codeFrom(s.wa.sent.map((x) => x.text)), null);
  assert.equal(s.github.calls.merged.length, 0);
});

test('tests fail twice → failed, branch kept for review, no staging', async () => {
  const s = await setup({ checks: [bad, bad] });
  await s.say(ASKER, 'ההפצה לא עובדת');
  const t = await s.runNext();
  assert.equal(t.status, 'failed');
  assert.equal(s.claude.calls.length, 2, 'Claude got a second try with the failure');
  assert.ok(s.claude.calls[1].previousFailure.includes('AssertionError'));
  assert.equal(s.ws.calls.stagingPush, 0);
  assert.ok(s.github.calls.opened[0].title.startsWith('[לא עבר בדיקות]'));
});

test('tests fail then pass on retry → continues', async () => {
  const s = await setup({ checks: [bad, ok] });
  await s.say(ASKER, 'ההפצה לא עובדת');
  const t = await s.runNext();
  assert.equal(t.status, 'awaiting_approval');
});

test('changes to forbidden paths are reverted and reported', async () => {
  const s = await setup({ files: ['engine/src/arm.js', 'repair/src/pipeline.js'] });
  await s.say(ASKER, 'ההפצה לא עובדת');
  const t = await s.runNext();
  assert.equal(t.status, 'awaiting_approval');
  assert.deepEqual(t.files, ['engine/src/arm.js']);
  assert.ok(t.warnings.some((w) => w.includes('repair/src/pipeline.js')));
});

test('a diff that adds a secret is stopped before any push', async () => {
  const s = await setup({ diff: '+const key = "sk-ant-api03-abcdefghijklmnopqrstuvwx";' });
  await s.say(ASKER, 'ההפצה לא עובדת');
  const t = await s.runNext();
  assert.equal(t.status, 'failed');
  assert.equal(s.ws.calls.pushed.length, 0);
});

test('production crash → automatic rollback + revert PR', async () => {
  const s = await setup({ railway: { prodResult: 'CRASHED' } });
  await s.say(ASKER, 'ההפצה לא עובדת');
  await s.runNext();
  const code = codeFrom(s.wa.textsTo(OWNER));
  await s.say(OWNER, `אשר ${code}`);
  await h.waitFor(async () => ['rolled_back', 'failed'].includes((await s.store.getTicket(1)).status));
  const t = await s.store.getTicket(1);
  assert.equal(t.status, 'rolled_back');
  assert.deepEqual(s.railway.calls.rollback, [{ env: 'production', id: 'production-engine-prev' }]);
  assert.ok(s.github.calls.opened.some((p) => p.head === 'revert/ticket-1'));
  assert.ok(s.wa.textsTo(OWNER).some((x) => x.includes('החזרתי אוטומטית')));
});

test('manual rollback by approver only', async () => {
  const s = await setup();
  await s.say(ASKER, 'ההפצה לא עובדת');
  await s.runNext();
  await s.say(OWNER, `אשר ${codeFrom(s.wa.textsTo(OWNER))}`);
  await h.waitFor(async () => (await s.store.getTicket(1)).status === 'deployed');

  await s.say(ASKER, 'החזר 1');
  assert.equal(s.railway.calls.rollback.length, 0);
  await s.say(OWNER, 'החזר 1');
  assert.equal((await s.store.getTicket(1)).status, 'rolled_back');
  assert.equal(s.railway.calls.rollback.length, 1);
});

test('reject closes the PR and invalidates the code', async () => {
  const s = await setup();
  await s.say(ASKER, 'ההפצה לא עובדת');
  await s.runNext();
  const code = codeFrom(s.wa.textsTo(OWNER));
  await s.say(OWNER, 'דחה 1');
  assert.equal((await s.store.getTicket(1)).status, 'rejected');
  assert.equal(s.github.calls.closed.length, 1);
  await s.say(OWNER, `אשר ${code}`);
  assert.equal(s.github.calls.merged.length, 0);
});

test('screenshot after the description is attached to the same ticket', async () => {
  const s = await setup();
  await s.say(ASKER, 'המסך של ההפצה לבן');
  await s.say(ASKER, '', { image: { buffer: Buffer.from('png'), mimetype: 'image/png' } });
  const list = await s.store.listTickets();
  assert.equal(list.length, 1);
  assert.equal(list[0].images.length, 1);
});

test('requester can cancel own queued ticket, not others', async () => {
  const s = await setup();
  await s.say(OWNER, 'ההפצה לא עובדת');
  await s.say(ASKER, 'בטל 1');
  assert.equal((await s.store.getTicket(1)).status, 'queued');
  await s.say(OWNER, 'בטל 1');
  assert.equal((await s.store.getTicket(1)).status, 'cancelled');
});

test('Claude error → failed with a clear reason, requester told', async () => {
  const s = await setup({ claudeResults: [new Error('Claude נעצר: Invalid API key')] });
  await s.say(ASKER, 'ההפצה לא עובדת');
  const t = await s.runNext();
  assert.equal(t.status, 'failed');
  assert.ok(s.wa.textsTo(ASKER).some((x) => x.includes('Invalid API key')));
});


test('two approvals with the same code at the same moment → one deploy only', async () => {
  const s = await setup();
  await s.store.addNumber({ phone: '972503333333', name: 'שני', role: 'approver' });
  await s.say(ASKER, 'ההפצה לא עובדת');
  await s.runNext();
  const code = codeFrom(s.wa.textsTo(OWNER));
  await Promise.all([s.say(OWNER, `אשר ${code}`), s.say('972503333333', `אשר ${code}`)]);
  await h.waitFor(async () => (await s.store.getTicket(1)).status === 'deployed');
  assert.equal(s.github.calls.merged.length, 1);
});

test('a later ticket overwrote staging → this fix is re-staged before production', async () => {
  const s = await setup();
  await s.say(ASKER, 'ההפצה לא עובדת');
  await s.runNext();
  s.scenario.stagingSha = 'other-ticket-sha';
  await s.say(OWNER, `אשר ${codeFrom(s.wa.textsTo(OWNER))}`);
  await h.waitFor(async () => (await s.store.getTicket(1)).status === 'deployed');
  assert.equal(s.ws.calls.restage, 1);
  const types = (await s.store.listEvents({ ticketId: 1 })).map((e) => e.type);
  assert.ok(types.indexOf('restage') < types.indexOf('merged'));
});

test('rollback of an old ticket is refused once a newer deploy is running', async () => {
  const s = await setup();
  for (const id of [1, 2]) {
    await s.say(ASKER, `ההפצה לא עובדת ${id}`);
    await s.runNext();
    const code = codeFrom(s.wa.textsTo(OWNER).slice(-1));
    await s.say(OWNER, `אשר ${code}`);
    await h.waitFor(async () => (await s.store.getTicket(id)).status === 'deployed');
  }
  await s.say(OWNER, 'החזר 1');
  assert.equal(s.railway.calls.rollback.length, 0);
  assert.equal((await s.store.getTicket(1)).status, 'deployed');
  assert.ok(s.wa.textsTo(`${OWNER}@s.whatsapp.net`).some((x) => x.includes('גרסה חדשה יותר')));
  await s.say(OWNER, 'החזר 2');
  assert.equal((await s.store.getTicket(2)).status, 'rolled_back');
});

test('approval while another deploy runs is postponed, code kept', async () => {
  const s = await setup();
  await s.say(ASKER, 'ההפצה לא עובדת');
  await s.runNext();
  const code = codeFrom(s.wa.textsTo(OWNER));
  // simulate a production action in progress
  const slow = new Promise((r) => setTimeout(r, 200));
  const origLatest = s.railway.latest;
  s.railway.latest = async (...a) => (await slow, origLatest(...a));
  await s.say(OWNER, `אשר ${code}`);
  await s.say(OWNER, 'החזר 1');
  assert.ok(s.wa.textsTo(`${OWNER}@s.whatsapp.net`).some((x) => x.includes('מועלית או מוחזרת כרגע')));
  await h.waitFor(async () => (await s.store.getTicket(1)).status === 'deployed');
});

test('a forbidden path that cannot be undone → fail closed, nothing pushed', async () => {
  const s = await setup({ files: ['engine/src/arm.js', '.github/workflows/x.yml'], sticky: true });
  await s.say(ASKER, 'ההפצה לא עובדת');
  const t = await s.runNext();
  assert.equal(t.status, 'failed');
  assert.match(t.error, /קבצים אסורים/);
  assert.equal(s.ws.calls.pushed.length, 0);
});

test('non-approver approval attempts are audited', async () => {
  const s = await setup();
  await s.say(ASKER, 'אשר 123456');
  await s.say(ASKER, 'החזר 1');
  const ev = (await s.store.listEvents()).filter((e) => e.type === 'unauthorized_command');
  assert.equal(ev.length, 2);
});

test('no approvers → blocked, not "awaiting approval"', async () => {
  const s = await setup();
  const owner = (await s.store.listNumbers()).find((n) => n.role === 'approver');
  await s.store.updateNumber(owner.id, { role: 'requester' });
  await s.say(ASKER, 'ההפצה לא עובדת');
  const t = await s.runNext();
  assert.equal(t.status, 'blocked');
});

test('images from strangers are never downloaded', async () => {
  const s = await setup();
  let loaded = false;
  await s.say('972509999999', '', { image: { mimetype: 'image/png', load: async () => ((loaded = true), { buffer: Buffer.from('x'), mimetype: 'image/png' }) } });
  assert.equal(loaded, false);
  await s.say(ASKER, 'המסך לבן');
  await s.say(ASKER, '', { image: { mimetype: 'image/png', load: async () => ((loaded = true), { buffer: Buffer.from('x'), mimetype: 'image/png' }) } });
  assert.equal(loaded, true);
});


test('main moved since the fix was tested → not merged, a fresh ticket is opened', async () => {
  const s = await setup();
  await s.say(ASKER, 'ההפצה לא עובדת');
  await s.runNext();
  s.scenario.mainSha = 'main2';
  await s.say(OWNER, `אשר ${codeFrom(s.wa.textsTo(OWNER))}`);
  await h.waitFor(async () => (await s.store.getTicket(1)).status === 'failed');
  assert.equal(s.github.calls.merged.length, 0);
  assert.equal(s.github.calls.closed.length, 1);
  const fresh = await s.store.getTicket(2);
  assert.equal(fresh.status, 'queued');
  assert.equal(fresh.description, 'ההפצה לא עובדת');
});
