// Fakes shared by the tests: no network, no WhatsApp, no Claude, no Railway.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require('../src/store/memory');

function makeCfg(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botix-repair-'));
  return {
    port: 0,
    dataDir,
    adminPassword: 'correct-horse-battery',
    sessionSecret: 'x'.repeat(40),
    claudeOauthToken: 'oauth-token-secret-123456',
    anthropicApiKey: '',
    claudeModel: '',
    claudeMaxTurns: 10,
    claudeTimeoutMin: 1,
    github: { token: 'ghp_' + 'a'.repeat(36), repo: 'owner/wa-arms', baseBranch: 'main', stagingBranch: 'staging' },
    railway: {
      api: 'http://railway.invalid',
      projectId: 'p1',
      prodEnvId: 'prod',
      stagingEnvId: 'stg',
      prodToken: 'prod-token-123456',
      stagingToken: 'stg-token-123456',
      services: { engine: 'svc-engine', web: 'svc-web' },
      stagingServices: null,
    },
    prodHealthUrls: [],
    stagingHealthUrls: [],
    requireStaging: true,
    approvalMinutes: 30,
    deployWaitMin: 1,
    autoRollback: true,
    intakeGraceSec: 0,
    runnerUser: 'runner',
    ...over,
  };
}

function fakeWa() {
  const sent = [];
  return {
    sent,
    send: async (to, text) => sent.push({ to, text }),
    sendButtons: async (to, text, buttons) => sent.push({ to, text, buttons }),
    status: () => ({ state: 'connected', qr: null, me: '972500000000', error: null }),
    connect: async () => {},
    disconnect: async () => {},
    textsTo: (to) => sent.filter((s) => s.to === to).map((s) => s.text),
  };
}

function fakeRailway({ staging = true, prodResult = 'SUCCESS', stagingResult = 'SUCCESS' } = {}) {
  const calls = { rollback: [], waits: [] };
  const current = {}; // `${env}-${svc}` -> running deployment id
  let n = 0;
  return {
    calls,
    current,
    ready: (env) => (env === 'staging' ? staging : true),
    latest: async (env, svc) => ({ id: current[`${env}-${svc}`] || `${env}-${svc}-prev`, status: 'SUCCESS' }),
    logs: async () => [{ timestamp: 't', severity: 'error', message: 'campaign 7 stuck, token=abcdef1234567890 phone 0521234567' }],
    waitForNew: async (env, svc) => {
      calls.waits.push({ env, svc });
      const st = svc === 'engine' ? (env === 'staging' ? stagingResult : prodResult) : 'SUCCESS';
      const id = `${env}-${svc}-new${++n}`;
      if (st === 'SUCCESS') current[`${env}-${svc}`] = id;
      return { id, status: st };
    },
    rollback: async (env, id) => {
      calls.rollback.push({ env, id });
      const svc = id.split('-')[1];
      current[`${env}-${svc}`] = id;
      return { id, status: 'DEPLOYING' };
    },
  };
}

function fakeGitHub() {
  const calls = { opened: [], merged: [], closed: [] };
  let n = 0;
  return {
    calls,
    ready: () => true,
    openPr: async (p) => {
      calls.opened.push(p);
      n++;
      return { number: n, html_url: `https://github.com/owner/wa-arms/pull/${n}` };
    },
    mergePr: async (num) => {
      calls.merged.push(num);
      return { sha: 'abc123' };
    },
    closePr: async (num) => calls.closed.push(num),
  };
}

/** A workspace whose "repository" is just a list of changed files the scenario sets. */
function fakeWs(scenario) {
  const { isForbidden } = require('../src/workspace');
  const calls = { pushed: [], committed: [], stagingPush: 0, restage: 0, cleaned: 0, killed: 0, context: {} };
  return {
    calls,
    runner: { uid: 1, gid: 1 },
    prepare: async (id, branch) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ticket-${id}-`));
      calls.branch = branch;
      return { id, dir, repo: dir + '/repo', sandbox: dir + '/sandbox', ctx: dir + '/ctx', home: dir + '/home', branch, baseSha: 'main1' };
    },
    writeContext: (w, name, content) => {
      calls.context[name] = String(content);
      return `${w.ctx}/${name}`;
    },
    sync: async () => ({ refused: scenario.refused || [] }),
    changedFiles: async () => scenario.files.slice(),
    dropForbidden: async (w, files) => {
      const bad = files.filter(isForbidden);
      if (!scenario.sticky) scenario.files = scenario.files.filter((f) => !bad.includes(f));
      return bad;
    },
    stageAll: async () => ({ diff: scenario.diff || '+ const x = 1;', stat: ' 1 file changed, 3 insertions(+), 1 deletion(-)', names: scenario.files.slice() }),
    unstage: async () => {},
    commitAndPush: async (w, branch, msg) => {
      calls.committed.push(msg);
      calls.pushed.push(branch);
      return 'sha1';
    },
    pushTo: async (w, branch) => {
      if (branch === 'staging') calls.stagingPush++;
    },
    remoteSha: async (branch) => (branch === 'main' ? scenario.mainSha || 'main1' : scenario.stagingSha === undefined ? 'sha1' : scenario.stagingSha),
    pushBranchTo: async () => {
      calls.restage++;
      scenario.stagingSha = 'sha1';
    },
    revertBranch: async (id) => `revert/ticket-${id}`,
    cleanup: () => calls.cleaned++,
    killRunner: () => calls.killed++,
    runnerEnv: (w, x = {}) => ({ PATH: process.env.PATH, ...x }),
  };
}

function fakeClaude(results) {
  const calls = [];
  return {
    calls,
    ready: () => true,
    investigate: async (args) => {
      calls.push(args);
      const r = results[Math.min(calls.length - 1, results.length - 1)];
      if (r instanceof Error) throw r;
      if (typeof r.onRun === 'function') r.onRun();
      return { parsed: r.parsed, raw: '', cost: 0.12, denials: 0 };
    },
  };
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise((r) => setImmediate(r));

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout waiting for condition');
}

module.exports = { makeCfg, fakeWa, fakeRailway, fakeGitHub, fakeWs, fakeClaude, silentLog, tick, waitFor, createMemoryStore };
