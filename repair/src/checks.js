// Automated checks on a ticket's sandbox: the project's own tests, run as the unprivileged runner
// with no secrets in the environment. Every runner process is killed after each step.
const fs = require('fs');
const path = require('path');
const { redact } = require('./secure');

function plan(files) {
  const steps = [];
  const touches = (prefix) => files.some((f) => f.startsWith(prefix));
  // engine tests always run: they are fast and catch most breakage
  steps.push({ name: 'בדיקות המנוע', dir: 'engine', install: true, cmd: 'npm', args: ['test'] });
  if (touches('web/')) {
    steps.push({ name: 'בדיקת קוד הממשק (TypeScript)', dir: 'web', install: true, cmd: 'npx', args: ['--no-install', 'tsc', '--noEmit'] });
  }
  return steps;
}

function warningsFor(files, diff) {
  const w = [];
  if (files.some((f) => f.startsWith('supabase/migrations/'))) {
    w.push('התיקון כולל שינוי במסד הנתונים. אחרי האישור צריך להחיל אותו על Supabase (ההעלאה לשרת לא עושה את זה לבד).');
  }
  if (files.some((f) => /(^|\/)package(-lock)?\.json$/.test(f))) w.push('התיקון משנה חבילות (package.json).');
  if (/^[+-].*\b(delete|drop|truncate)\b/im.test(diff || '')) w.push('השינוי כולל פעולות מחיקה. כדאי לעבור עליו לפני האישור.');
  return w;
}

async function runChecks(ws, w, files) {
  const results = [];
  try {
    for (const step of plan(files)) {
      const cwd = path.join(w.sandbox, step.dir);
      if (!fs.existsSync(cwd)) continue;
      if (step.install && !fs.existsSync(path.join(cwd, 'node_modules'))) {
        const hasLock = fs.existsSync(path.join(cwd, 'package-lock.json'));
        const inst = await ws.run('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd, env: ws.runnerEnv(w), timeoutMs: 10 * 60_000 });
        ws.killRunner();
        if (inst.code !== 0) {
          results.push({ name: `התקנת חבילות (${step.dir})`, ok: false, output: tail(inst.stderr || inst.stdout) });
          break;
        }
      }
      const r = await ws.run(step.cmd, step.args, { cwd, env: ws.runnerEnv(w, { NODE_ENV: 'test' }), timeoutMs: 10 * 60_000 });
      ws.killRunner();
      results.push({ name: step.name, ok: r.code === 0, output: tail(r.stdout + '\n' + r.stderr) });
      if (r.code !== 0) break;
    }
  } finally {
    ws.killRunner();
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), steps: results };
}

const tail = (s, n = 3000) => redact(String(s || '').slice(-n));

module.exports = { runChecks, plan, warningsFor };
