// A fresh copy of the BotiX code for each ticket, and the safe way to run things in it.
//
// Layout per ticket (under DATA_DIR/work/ticket-<id>/):
//   repo/     git clone – owned by the server (root). The runner user can never touch it.
//   sandbox/  plain copy of the files, NO .git – owned by the runner. Claude edits here,
//             the project's tests run here.
//   ctx/      task, logs, screenshots for Claude – owned by root, read-only for the runner.
//   home/     a fresh, empty HOME for the runner, deleted afterwards.
//
// After Claude and the tests finish, every runner process is killed and the changed files are
// copied back into repo/ by the server (regular files only – symlinks are refused). Git only ever
// runs in repo/, with hooks and all user/system git config disabled, and the GitHub token is
// passed through the environment (never on a command line, never in a file).
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_OUT = 200_000;
const MAX_FILE = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next']);

// Paths a fix may never change: the repair bot itself, CI/build/deploy config, git plumbing,
// Claude settings, secret files.
const FORBIDDEN = [
  /^repair(\/|$)/,
  /^\.github(\/|$)/,
  /^\.husky(\/|$)/,
  /(^|\/)\.claude(\/|$)/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.gitmodules$/,
  /(^|\/)railway\.(json|toml)$/,
  /(^|\/)nixpacks\.toml$/,
  /(^|\/)Dockerfile$/,
  /(^|\/)Procfile$/,
];
const isForbidden = (f) => FORBIDDEN.some((re) => re.test(f));

function resolveRunner(userName) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null; // not root: run as ourselves
  try {
    const opts = { stdio: ['ignore', 'pipe', 'ignore'] };
    const uid = Number(execFileSync('id', ['-u', userName], opts).toString().trim());
    const gid = Number(execFileSync('id', ['-g', userName], opts).toString().trim());
    return { uid, gid, name: userName };
  } catch {
    return null;
  }
}

/** Run a program without a shell, in its own process group so a timeout kills everything it started. */
function run(cmd, args, { cwd, env, timeoutMs = 10 * 60_000, runner = null, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], ...(runner ? { uid: runner.uid, gid: runner.gid } : {}) });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let backstop = null;
    const add = (buf, chunk) => (buf.length < MAX_OUT ? buf + chunk.toString() : buf);
    child.stdout.on('data', (c) => (stdout = add(stdout, c)));
    child.stderr.on('data', (c) => (stderr = add(stderr, c)));
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      killGroup(); // leftovers (servers the tests started, etc.)
      resolve({ code: timedOut ? -1 : code, stdout, stderr, timedOut });
    };
    child.on('error', (e) => {
      stderr += e.message;
      finish(-1);
    });
    // 'close' waits for every holder of stdout; a grandchild could hold it forever – so also
    // finish shortly after the main process exits.
    child.on('exit', (code) => {
      backstop = setTimeout(() => finish(code), 2000);
    });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Parse `git status --porcelain=v1 -z` → changed paths (both sides of a rename). */
function parseStatusZ(out) {
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    files.push(e.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') files.push(parts[++i]); // the original path follows
  }
  return [...new Set(files.filter(Boolean))];
}

/** Parse `git diff --name-status -z` → all paths involved. */
function parseNameStatusZ(out) {
  const parts = out.split('\0').filter((p) => p !== '');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    if (/^[RC]/.test(parts[i])) files.push(parts[++i], parts[++i]);
    else files.push(parts[++i]);
  }
  return [...new Set(files.filter(Boolean))];
}

function createWorkspace(cfg, { root, runnerUser } = {}) {
  const base = root || path.join(cfg.dataDir, 'work');
  const runner = resolveRunner(runnerUser || cfg.runnerUser);
  const gitHome = path.join(base, '.git-home'); // root only
  fs.mkdirSync(gitHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o711); // runner may pass through to its sandbox, not list or write

  const chownToRunner = (p) => {
    if (runner) execFileSync('chown', ['-R', '--no-dereference', `${runner.uid}:${runner.gid}`, p]);
  };

  function killRunner() {
    if (runner) spawnSync('pkill', ['-KILL', '-u', String(runner.uid)], { stdio: 'ignore' });
  }

  // environment for anything we run as the runner: no secrets at all
  function runnerEnv(w, extra = {}) {
    return {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: w.home,
      LANG: 'C.UTF-8',
      CI: '1',
      npm_config_cache: path.join(w.home, '.npm'),
      npm_config_update_notifier: 'false',
      ...extra,
    };
  }

  const repoUrl = () => cfg.github.remoteUrl || `https://github.com/${cfg.github.repo}.git`;

  function gitEnv(auth) {
    const env = {
      PATH: process.env.PATH,
      HOME: gitHome,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C.UTF-8',
    };
    for (const k of ['SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'HTTPS_PROXY', 'https_proxy']) if (process.env[k]) env[k] = process.env[k];
    if (auth && cfg.github.token) {
      const basic = Buffer.from(`x-access-token:${cfg.github.token}`).toString('base64');
      Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
    }
    return env;
  }

  async function git(dir, args, opts = {}) {
    const r = await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd: dir,
      env: gitEnv(opts.auth),
      timeoutMs: opts.timeoutMs || 5 * 60_000,
    });
    if (r.code !== 0 && !opts.allowFail) {
      const msg = (r.stderr || r.stdout).replace(/AUTHORIZATION: basic \S+/gi, '[הוסתר]').slice(-800);
      throw new Error(`git ${args[0]} נכשל: ${msg}`);
    }
    return r;
  }

  async function prepare(ticketId, branch) {
    const dir = path.join(base, `ticket-${ticketId}`);
    killRunner();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { mode: 0o711 });
    const w = { id: ticketId, dir, repo: path.join(dir, 'repo'), sandbox: path.join(dir, 'sandbox'), ctx: path.join(dir, 'ctx'), home: path.join(dir, 'home'), branch };
    await git(dir, ['clone', '-q', '--depth', '50', '--branch', cfg.github.baseBranch, repoUrl(), w.repo], { auth: true, timeoutMs: 10 * 60_000 });
    fs.chmodSync(w.repo, 0o700);
    w.baseSha = (await git(w.repo, ['rev-parse', 'HEAD'])).stdout.trim(); // the main the fix is built on
    await git(w.repo, ['checkout', '-q', '-b', branch]);
    fs.cpSync(w.repo, w.sandbox, { recursive: true, verbatimSymlinks: true, filter: (src) => path.basename(src) !== '.git' });
    fs.mkdirSync(w.ctx, { mode: 0o755 });
    fs.mkdirSync(w.home, { mode: 0o700 });
    chownToRunner(w.sandbox);
    chownToRunner(w.home);
    return w;
  }

  /** A brand-new empty HOME for the runner (nothing left over from an earlier step). */
  function resetHome(w) {
    killRunner();
    fs.rmSync(w.home, { recursive: true, force: true });
    fs.mkdirSync(w.home, { mode: 0o700 });
    chownToRunner(w.home);
  }

  /** Write a file for Claude into ctx/ (root-owned: the runner cannot plant links there). */
  function writeContext(w, name, content) {
    const p = path.join(w.ctx, path.basename(name));
    fs.writeFileSync(p, content, { mode: 0o644 });
    return p;
  }

  /**
   * Copy the sandbox state back into repo/. Kills runner processes first, so nothing can swap
   * files during the copy. Returns symlinks / odd entries that were refused.
   */
  async function sync(w) {
    killRunner();
    const refused = [];
    const seen = new Set();
    const repoReal = fs.realpathSync(w.repo);
    const walk = (rel) => {
      const abs = path.join(w.sandbox, rel);
      for (const name of fs.readdirSync(abs)) {
        if (SKIP_DIRS.has(name)) continue;
        const r = rel ? `${rel}/${name}` : name;
        const st = fs.lstatSync(path.join(abs, name));
        if (st.isSymbolicLink()) {
          refused.push(r);
          continue;
        }
        if (st.isDirectory()) {
          walk(r);
          continue;
        }
        if (!st.isFile() || st.size > MAX_FILE) continue;
        seen.add(r);
        const dest = path.join(w.repo, r);
        const dst = fs.lstatSync(dest, { throwIfNoEntry: false });
        if (dst && !dst.isFile()) {
          refused.push(r);
          continue;
        }
        const data = fs.readFileSync(path.join(abs, name));
        if (dst && dst.size === data.length && fs.readFileSync(dest).equals(data)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // never write through a link that already exists in the repo
        const realDir = fs.realpathSync(path.dirname(dest));
        if (realDir !== repoReal && !realDir.startsWith(repoReal + path.sep)) {
          refused.push(r);
          continue;
        }
        fs.writeFileSync(dest, data, { mode: st.mode & 0o755 });
      }
    };
    walk('');
    // tracked files the sandbox no longer has were deleted
    const tracked = (await git(w.repo, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
    for (const f of tracked) {
      if (seen.has(f) || refused.includes(f) || f.split('/').some((p) => SKIP_DIRS.has(p))) continue;
      if (!fs.lstatSync(path.join(w.sandbox, f), { throwIfNoEntry: false })) fs.rmSync(path.join(w.repo, f), { force: true });
    }
    return { refused };
  }

  async function changedFiles(w) {
    const r = await git(w.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return parseStatusZ(r.stdout);
  }

  /** Undo changes to forbidden paths in repo/. Returns the paths that were undone. */
  async function dropForbidden(w, files) {
    const bad = files.filter(isForbidden);
    for (const f of bad) {
      const tracked = (await git(w.repo, ['ls-files', '--error-unmatch', '--', f], { allowFail: true })).code === 0;
      if (tracked) await git(w.repo, ['checkout', 'HEAD', '--', f], { allowFail: true });
      else fs.rmSync(path.join(w.repo, f), { force: true, recursive: true });
    }
    return bad;
  }

  async function stageAll(w) {
    await git(w.repo, ['add', '-A']);
    const diff = (await git(w.repo, ['diff', '--cached'])).stdout;
    const stat = (await git(w.repo, ['diff', '--cached', '--shortstat'])).stdout.trim();
    const names = parseNameStatusZ((await git(w.repo, ['diff', '--cached', '--name-status', '-z'])).stdout);
    return { diff, stat, names };
  }

  async function unstage(w) {
    await git(w.repo, ['reset', '-q'], { allowFail: true });
  }

  async function commitAndPush(w, branch, message) {
    await git(w.repo, ['-c', 'user.name=BotiX Repair', '-c', 'user.email=botix-repair@users.noreply.github.com', 'commit', '-q', '-m', message]);
    await git(w.repo, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${branch}`], { auth: true });
    return (await git(w.repo, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  async function pushTo(w, remoteBranch, { force = false } = {}) {
    await git(w.repo, ['push', '-q', ...(force ? ['--force'] : []), 'origin', `HEAD:refs/heads/${remoteBranch}`], { auth: true });
  }

  /** Current commit of a remote branch (null if it does not exist or cannot be read). */
  async function remoteSha(branch) {
    const r = await git(base, ['ls-remote', repoUrl(), `refs/heads/${branch}`], { auth: true, allowFail: true });
    return r.code === 0 ? r.stdout.split(/\s/)[0] || null : null;
  }

  /** Point a branch at the tip of another branch (used to re-stage a ticket before deploy). */
  async function pushBranchTo(ticketId, branch, targetBranch) {
    const dir = path.join(base, `restage-${ticketId}`);
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      await git(base, ['clone', '-q', '--depth', '1', '--branch', branch, repoUrl(), dir], { auth: true });
      await git(dir, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${targetBranch}`], { auth: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Prepare a branch that undoes a merged commit, for a PR back to main. */
  async function revertBranch(ticketId, sha) {
    const dir = path.join(base, `revert-${ticketId}`);
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      await git(base, ['clone', '-q', '--depth', '50', '--branch', cfg.github.baseBranch, repoUrl(), dir], { auth: true });
      const branch = `revert/ticket-${ticketId}`;
      await git(dir, ['checkout', '-q', '-b', branch]);
      await git(dir, ['-c', 'user.name=BotiX Repair', '-c', 'user.email=botix-repair@users.noreply.github.com', 'revert', '--no-edit', sha]);
      await git(dir, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${branch}`], { auth: true });
      return branch;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function cleanup(w) {
    killRunner();
    try {
      fs.rmSync(w.dir, { recursive: true, force: true });
    } catch {}
  }

  return {
    base,
    runner,
    runnerEnv,
    killRunner,
    run: (cmd, args, o = {}) => run(cmd, args, { runner, ...o }),
    git,
    prepare,
    resetHome,
    writeContext,
    sync,
    changedFiles,
    dropForbidden,
    stageAll,
    unstage,
    commitAndPush,
    pushTo,
    remoteSha,
    pushBranchTo,
    revertBranch,
    cleanup,
  };
}

module.exports = { createWorkspace, run, FORBIDDEN, isForbidden, parseStatusZ, parseNameStatusZ };
