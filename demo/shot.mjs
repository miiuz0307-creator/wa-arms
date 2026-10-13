// Opens demo/dist/index.html in Chromium and visits every screen as every persona, on a phone (390×844) and
// a desktop (1366×900), light and dark. Saves screenshots to demo/shots/ and FAILS on console errors,
// page errors or a crashed screen.
//   node demo/shot.mjs [--quick]      (--quick: light theme only)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = process.env.DEMO_NODE_MODULES || '/opt/npm-tools/node_modules';
const { chromium } = createRequire(path.join(NM, 'noop.js'))('playwright');
const FILE = pathToFileURL(path.join(ROOT, 'demo', 'dist', 'index.html')).href;
const OUT = path.join(ROOT, 'demo', 'shots');
const quick = process.argv.includes('--quick');
const only = process.argv.find((a) => a.startsWith('--persona='))?.split('=')[1];

// screens from the build (web/app/**/page.tsx); dynamic ones get a real id from the demo data
function screens() {
  const out = [];
  const walk = (dir, segs) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === 'api') continue;
        walk(path.join(dir, e.name), [...segs, e.name]);
      } else if (/^page\.(t|j)sx?$/.test(e.name)) out.push('/' + segs.filter((s) => !/^\(.*\)$/.test(s)).join('/'));
    }
  };
  walk(path.join(ROOT, 'web', 'app'), []);
  return out.sort();
}
const PERSONAS = ['owner', 'station', 'expired', 'operator', 'viewer'].filter((p) => !only || p === only);
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1366, height: 900 },
];
const THEMES = quick ? ['light'] : ['light', 'dark'];

const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const routes = screens();
const results = [];
let failures = 0;

for (const persona of PERSONAS) {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
      // no network: the Google font may not load here (fallback font is fine)
      await ctx.route(/^https?:\/\//, (r) => r.abort());
      const page = await ctx.newPage();
      let errs = [];
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/fonts\.(googleapis|gstatic)\.com|net::ERR_FAILED|ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(t)) return;
        errs.push('console: ' + t);
      });
      page.on('pageerror', (e) => errs.push('pageerror: ' + (e.stack || e.message)));
      await page.goto(FILE + '#/');
      await page.evaluate(
        ([p, th]) => {
          localStorage.clear();
          localStorage.setItem('botix-demo-started', '1');
          if (th === 'dark') localStorage.setItem('botix-theme', 'dark');
          else localStorage.setItem('botix-theme', 'light');
          localStorage.setItem('botix-demo-ribbon', 'closed');
          window.__persona = p;
        },
        [persona, theme],
      );
      // log in as the persona through the demo's own switch
      await page.goto(FILE + '#/');
      await page.waitForFunction(() => !!document.querySelector('#root')?.children.length, null, { timeout: 15000 });
      await page.evaluate((p) => {
        const keys = { owner: ['botix-demo-auth', '0b07a1f0-0000-4000-8000-0000000000a1'], operator: ['botix-demo-auth', '0b07a1f0-0000-4000-8000-0000000000a2'], viewer: ['botix-demo-auth', '0b07a1f0-0000-4000-8000-0000000000a3'], station: ['wa-station-token', 'demo-station-token-sharon'], expired: ['wa-station-token', 'demo-station-token-south'] };
        localStorage.removeItem('botix-demo-auth');
        localStorage.removeItem('wa-station-token');
        localStorage.removeItem('wa-act-station');
        localStorage.setItem(keys[p][0], keys[p][1]);
        localStorage.setItem('wa-remember-until', String(Date.now() + 1e9));
      }, persona);

      // a real ride id for /history/[id]
      let rideId = null;
      for (const r of routes) {
        let url = r;
        if (r.includes('[id]')) {
          if (!rideId) {
            await page.goto(FILE + '#/history');
            await page.reload();
            await page.waitForTimeout(1200);
            rideId = await page.evaluate(() => {
              const a = [...document.querySelectorAll('a[href*="#/history/"]')][0];
              return a ? a.getAttribute('href').split('/').pop() : null;
            });
          }
          if (!rideId) {
            results.push({ persona, vp: vp.name, theme, route: r, ok: true, note: 'no ride link visible (skipped)' });
            continue;
          }
          url = r.replace('[id]', rideId);
        }
        if (r === '/pay') url = '/pay?r=' + (await page.evaluate(() => {
          try {
            const raw = JSON.parse(localStorage.getItem('botix-demo-db'));
            const t = raw.t.payment_requests;
            const i = t.c.indexOf('token');
            const s = t.c.indexOf('status');
            return (t.r.find((x) => x[s] === 'pending') || t.r[0])[i];
          } catch {
            return '00000000-0000-4000-8000-000000000000';
          }
        }));
        errs = [];
        await page.goto(FILE + '#' + url);
        await page.reload();
        await page.waitForTimeout(1500);
        const state = await page.evaluate(() => ({
          crashed: !!document.querySelector('[data-demo-error]'),
          crashText: document.querySelector('[data-demo-error]')?.textContent || '',
          hash: location.hash,
          text: document.body.innerText.slice(0, 120).replace(/\s+/g, ' '),
        }));
        const name = `${persona}-${vp.name}-${theme}-${(r.replace(/\//g, '_').replace(/[\[\]]/g, '') || '_home').replace(/^_/, '') || 'home'}.png`;
        await page.screenshot({ path: path.join(OUT, name), fullPage: false });
        const ok = !state.crashed && errs.length === 0;
        if (!ok) failures++;
        results.push({ persona, vp: vp.name, theme, route: url, landed: state.hash, ok, errs: [...errs, ...(state.crashed ? ['crash: ' + state.crashText] : [])] });
        process.stdout.write(ok ? '.' : 'X');
      }
      await ctx.close();
    }
  }
}
await browser.close();
console.log();
for (const r of results.filter((x) => !x.ok)) console.log('FAIL', r.persona, r.vp, r.theme, r.route, '\n   ' + r.errs.join('\n   '));
const ok = results.filter((x) => x.ok).length;
console.log(`${ok}/${results.length} screen visits passed (${PERSONAS.length} personas × ${VIEWPORTS.length} sizes × ${THEMES.length} themes × ${routes.length} routes). Screenshots: demo/shots/`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
process.exit(failures ? 1 : 0);
