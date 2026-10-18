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
  // most tests talk inside an open conversation; `raw: true` sends without one
  const say = (phone, text, extra = {}) => (extra.raw ? null : intake.touch(phone), intake.handle({ jid: `${phone}@s.whatsapp.net`, phone, lid: null, name: "", text, image: null, ...extra }));
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

test('strangers are never answered; their "עזרה" is logged', async () => {
  const s = await setup();
  await s.say('972509999999', 'ההפצה לא עובדת');
  await s.say('972509999999', 'עזרה');
  assert.equal(s.wa.textsTo('972509999999@s.whatsapp.net').length, 0);
  assert.equal((await s.store.listTickets()).length, 0);
  const ev = await s.store.listEvents();
  assert.equal(ev.filter((e) => e.type === 'rejected_sender').length, 1);
});

test('only "עזרה" opens a conversation; other messages are ignored until then', async () => {
  const s = await setup();
  const J = `${ASKER}@s.whatsapp.net`;
  await s.say(ASKER, 'ההפצה לא עובדת', { raw: true });
  await s.say(ASKER, 'סטטוס', { raw: true });
  assert.equal(s.wa.textsTo(J).length, 0, 'silent before עזרה');
  assert.equal((await s.store.listTickets()).length, 0);
  await s.say(ASKER, 'עזרה', { raw: true });
  assert.ok(s.wa.textsTo(J)[0].includes('BotiX AI Repair'));
  await s.say(ASKER, 'ההפצה לא עובדת', { raw: true });
  assert.equal((await s.store.listTickets()).length, 1, 'inside the conversation a description opens a ticket');
});

test('"עזרה <description>" opens a ticket in one message', async () => {
  const s = await setup();
  await s.say(ASKER, 'עזרה ההפצה לא עובדת מהבוקר', { raw: true });
  const t = (await s.store.listTickets())[0];
  assert.equal(t.description, 'ההפצה לא עובדת מהבוקר');
});

test('an approval code works without an open conversation', async () => {
  const s = await setup();
  await s.say(ASKER, 'עזרה ההפצה לא עובדת', { raw: true });
  await s.runNext();
  const code = codeFrom(s.wa.textsTo(OWNER));
  await s.say(OWNER, `אשר ${code}`, { raw: true });
  await h.waitFor(async () => (await s.store.getTicket(1)).status === 'deployed');
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

test('command group: everything goes to the group, chatter is ignored, approver still required', async () => {
  const s = await setup();
  const G = '120363000000000000@g.us';
  s.wa.commandGroup = () => G;
  const inGroup = (phone, text) => (s.intake.touch(phone), s.intake.handle({ jid: G, phone, lid: null, name: '', text, image: null }));
  await inGroup(ASKER, 'תודה');
  assert.equal((await s.store.listTickets()).length, 0, 'short chatter in the group opens nothing');
  await inGroup(ASKER, 'ההפצה לא עובדת מהבוקר');
  await s.runNext();
  const toGroup = s.wa.textsTo(G);
  const code = codeFrom(toGroup);
  assert.match(code, /^\d{6}$/);
  assert.equal(s.wa.textsTo(OWNER).length, 0, 'nothing sent privately');
  await inGroup(ASKER, `אשר ${code}`);
  assert.equal((await s.store.getTicket(1)).status, 'awaiting_approval', 'a requester cannot approve');
  await inGroup(OWNER, `אשר ${code}`);
  await h.waitFor(async () => (await s.store.getTicket(1)).status === 'deployed');
});

test('"עזרה" shows the menu with buttons; "דבר עם נציג" silences the bot and tells the approvers', async () => {
  const s = await setup();
  const J = `${ASKER}@s.whatsapp.net`;
  await s.say(ASKER, 'עזרה', { raw: true });
  const menu = s.wa.sent.find((m) => m.to === J);
  assert.ok(['menu:report', 'menu:ask', 'menu:human'].every((id) => menu.buttons.some((b) => b.id === id)));
  await s.say(ASKER, 'menu:human', { raw: true });
  assert.ok(s.wa.textsTo(J).at(-1).includes('נציג'));
  assert.ok(s.wa.textsTo(OWNER).some((t) => t.includes('ביקש לדבר עם נציג')));
  const before = s.wa.textsTo(J).length;
  await s.say(ASKER, 'ההפצה לא עובדת', { raw: true });
  assert.equal(s.wa.textsTo(J).length, before, 'bot stays silent after handing over');
  assert.equal((await s.store.listTickets()).length, 0);
});

test('"1" after the menu asks for the problem, then the description opens a ticket', async () => {
  const s = await setup();
  const J = `${ASKER}@s.whatsapp.net`;
  await s.say(ASKER, 'עזרה', { raw: true });
  await s.say(ASKER, '1', { raw: true });
  assert.ok(s.wa.textsTo(J).at(-1).includes('מה לא עובד'));
  await s.say(ASKER, 'ההפצה לא עובדת', { raw: true });
  assert.equal((await s.store.listTickets()).length, 1);
  await s.say('972503333333', '1', { raw: true }); // stranger: still nothing
  assert.equal(s.wa.textsTo('972503333333@s.whatsapp.net').length, 0);
});

test('menu test: approvers only; a tapped choice is confirmed with its kind', async () => {
  const s = await setup();
  await s.say(ASKER, 'בדיקת תפריט', { raw: true });
  assert.equal(s.wa.menuTests.length, 0, 'requester cannot run it');
  await s.say(OWNER, 'בדיקת תפריט', { raw: true });
  assert.deepEqual(s.wa.menuTests, [`${OWNER}@s.whatsapp.net`]);
  assert.ok(s.wa.textsTo(`${OWNER}@s.whatsapp.net`).some((t) => t.includes('לא נשלחו: B')));
  await s.say(OWNER, 'בדיקת תפריט 052-123-4567', { raw: true });
  assert.equal(s.wa.menuTests[1], '972521234567');
  await s.intake.handle({ jid: `${OWNER}@s.whatsapp.net`, phone: OWNER, lid: null, name: '', text: 'test:A2', kind: 'native_flow', image: null });
  assert.ok(s.wa.textsTo(`${OWNER}@s.whatsapp.net`).at(-1).includes('A2'));
  assert.equal((await s.store.listTickets()).length, 0);
  await s.intake.handle({ jid: '972509999999@s.whatsapp.net', phone: '972509999999', lid: null, name: '', text: 'test:A1', kind: 'native_flow', image: null });
  assert.equal(s.wa.textsTo('972509999999@s.whatsapp.net').length, 0, 'strangers still ignored');
});

test('group-only mode: private chats are ignored, the group is answered', async () => {
  const s = await setup({ cfg: { groupOnly: true } });
  await s.say(OWNER, 'עזרה', { raw: true });
  assert.equal(s.wa.sent.length, 0);
  const G = '120363000000000000@g.us';
  await s.intake.handle({ jid: G, phone: OWNER, lid: null, name: '', text: 'עזרה', image: null });
  assert.ok(s.wa.textsTo(G).length > 0);
});

test('in the group: menu, then "report" and a description opens a ticket; status button works', async () => {
  const s = await setup();
  const G = '120363000000000001@g.us';
  const g = (text) => s.intake.handle({ jid: G, phone: ASKER, lid: null, name: '', text, image: null });
  await g('עזרה');
  assert.equal(s.wa.sent.at(-1).buttons.length, 6);
  await g('menu:report');
  assert.ok(s.wa.textsTo(G).at(-1).includes('מה לא עובד'));
  await g('ההפצה לא עובדת מהבוקר');
  assert.equal((await s.store.listTickets()).length, 1);
  await g('menu:status');
  assert.ok(s.wa.textsTo(G).at(-1).includes('פניות פתוחות'));
});

test('a question gets a read-only answer, no ticket; secrets in the answer are masked', async () => {
  const s = await setup();
  const J = `${ASKER}@s.whatsapp.net`;
  await s.say(ASKER, 'עזרה', { raw: true });
  await s.say(ASKER, 'menu:ask', { raw: true });
  await s.say(ASKER, 'כמה זרועות פעולות יש כרגע');
  assert.equal((await s.store.listTickets()).length, 0, 'a question is not a ticket');
  const tick = s.pipeline.start(1e9);
  await tick();
  s.pipeline.stop();
  assert.equal(s.claude.asked[0].question, 'כמה זרועות פעולות יש כרגע');
  const last = s.wa.textsTo(J).at(-1);
  assert.ok(last.includes('3 זרועות'));
  assert.ok(!last.includes('abcdef1234567890'), 'secret masked');
  await s.say(ASKER, 'שאלה איך עובדת ההפצה?', { raw: true });
  assert.equal((await s.store.listTickets()).length, 0);
});
