// Builds the BotiX demo as ONE self-contained file: demo/dist/index.html (inline JS + CSS).
// Uses the real pages / components from web/ (whatever exists at build time) with small Next.js shims.
//   node demo/build.mjs            (from the repo root)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const DEMO = path.join(ROOT, 'demo');
const NM = process.env.DEMO_NODE_MODULES || '/opt/npm-tools/node_modules';
const req = createRequire(path.join(NM, 'noop.js'));
const esbuild = req('esbuild');
const tw = await import(pathToFileURL(path.join(NM, 'tailwindcss/dist/lib.mjs')).href);

// ---------------------------------------------------------------- routes from web/app/**/page.tsx
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'api' || e.name.startsWith('_') || e.name === 'node_modules') continue;
      walk(p, out);
    } else if (/^page\.(t|j)sx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const APP = path.join(WEB, 'app');
const pages = walk(APP);
const routes = pages.map((file) => {
  const relDir = path.relative(APP, path.dirname(file));
  const segs = relDir ? relDir.split(path.sep) : [];
  const keys = [];
  const urlSegs = [];
  let re = '';
  for (const s of segs) {
    if (/^\(.*\)$/.test(s) || s.startsWith('@')) continue; // route groups / parallel slots
    urlSegs.push(s);
    let m;
    if ((m = /^\[\[?\.\.\.(\w+)\]\]?$/.exec(s))) {
      keys.push(m[1]);
      re += '/(.+)';
    } else if ((m = /^\[(\w+)\]$/.exec(s))) {
      keys.push(m[1]);
      re += '/([^/]+)';
    } else re += '/' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // layouts between app/ (root layout excluded – index.html + main.tsx play its part) and the page
  const layouts = [];
  let d = APP;
  for (const s of segs) {
    d = path.join(d, s);
    for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
      const lf = path.join(d, 'layout.' + ext);
      if (fs.existsSync(lf)) layouts.push(lf);
    }
  }
  return { file, pattern: '/' + urlSegs.join('/'), re: '^' + (re || '/') + '/?$', keys, layouts, dynamic: keys.length };
});
routes.sort((a, b) => a.dynamic - b.dynamic || b.pattern.length - a.pattern.length);
const allLayouts = [...new Set(routes.flatMap((r) => r.layouts))];
const routesModule =
  routes.map((r, i) => `import P${i} from ${JSON.stringify(r.file)};`).join('\n') +
  '\n' +
  allLayouts.map((l, i) => `import L${i} from ${JSON.stringify(l)};`).join('\n') +
  `\nexport default [\n` +
  routes
    .map(
      (r, i) =>
        `  { pattern: ${JSON.stringify(r.pattern)}, re: new RegExp(${JSON.stringify(r.re)}), keys: ${JSON.stringify(r.keys)}, Page: P${i}, layouts: [${r.layouts
          .map((l) => 'L' + allLayouts.indexOf(l))
          .join(', ')}] },`,
    )
    .join('\n') +
  '\n];\n';
console.log('routes:', routes.map((r) => r.pattern).join('  '));

// ---------------------------------------------------------------- JS bundle
const SHIM = (f) => path.join(DEMO, 'shims', f);
const ALIAS = {
  'next/link': SHIM('next-link.tsx'),
  'next/navigation': SHIM('next-navigation.ts'),
  'next/font/google': SHIM('next-font.ts'),
  'next/font/local': SHIM('next-font.ts'),
  next: SHIM('next.ts'),
  'qrcode.react': SHIM('qrcode.tsx'),
  '@supabase/supabase-js': SHIM('supabase-js.ts'),
  'lucide-react': path.join(DEMO, 'vendor', 'lucide.jsx'),
};
const resolveTs = (p) => {
  for (const c of [p, p + '.tsx', p + '.ts', p + '.jsx', p + '.js', path.join(p, 'index.tsx'), path.join(p, 'index.ts')])
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
};
const demoPlugin = {
  name: 'botix-demo',
  setup(b) {
    b.onResolve({ filter: /^demo-routes$/ }, () => ({ path: 'demo-routes', namespace: 'demo-routes' }));
    b.onLoad({ filter: /.*/, namespace: 'demo-routes' }, () => ({ contents: routesModule, loader: 'js', resolveDir: ROOT }));
    b.onResolve({ filter: /^@\// }, (a) => {
      const p = resolveTs(path.join(WEB, a.path.slice(2)));
      return p ? { path: p } : { errors: [{ text: 'not found: ' + a.path }] };
    });
    b.onResolve({ filter: /^(next(\/.*)?|qrcode\.react|@supabase\/supabase-js|lucide-react)$/ }, (a) => (ALIAS[a.path] ? { path: ALIAS[a.path] } : undefined));
    b.onResolve({ filter: /^(react|react-dom|scheduler)(\/.*)?$/ }, (a) => ({ path: req.resolve(a.path) }));
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'empty-css' }));
    b.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'js' }));
    // pages read / assign window.location (href = '/x', search, pathname, origin): point them at the hash router
    b.onLoad({ filter: /[\\/]web[\\/].*\.(tsx?|jsx?)$/ }, (a) => {
      let src = fs.readFileSync(a.path, 'utf8');
      src = src.replace(/\bwindow\.location\.(href|pathname|search|origin|hostname)\b/g, 'window.__demoLoc.$1');
      return { contents: src, loader: a.path.endsWith('x') ? 'tsx' : 'ts' };
    });
  },
};
const t0 = Date.now();
const js = await esbuild.build({
  entryPoints: [path.join(DEMO, 'main.tsx')],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  jsx: 'automatic',
  legalComments: 'none',
  charset: 'utf8',
  define: {
    'process.env.NEXT_PUBLIC_DEMO': '"1"',
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_SUPABASE_URL': '"https://demo.invalid"',
    'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': '"demo"',
    'process.env': '{}',
  },
  nodePaths: [NM],
  plugins: [demoPlugin],
  logLevel: 'warning',
});
const jsText = js.outputFiles[0].text;

// ---------------------------------------------------------------- CSS (tailwind v4)
function scanCandidates() {
  const set = new Set();
  const files = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.next', 'dist', 'shots', 'vendor', 'public'].includes(e.name)) continue;
        scan(p);
      } else if (/\.(tsx?|jsx?|mjs)$/.test(e.name)) files.push(p);
    }
  };
  scan(WEB);
  scan(DEMO);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const tok of src.split(/[\s"'`{}<>=;,()]+/)) {
      const t = tok.replace(/^[\\]+|[\\]+$/g, '');
      if (t && t.length < 120 && /^[!\-a-z@\[]/.test(t) && /[a-z0-9\]%)]$/i.test(t)) set.add(t);
    }
    // arbitrary values with spaces inside quotes are split above; also keep [..] groups whole
    for (const m of src.matchAll(/[!\-a-z@:]*\[[^\]\s"'`]+\][^\s"'`]*/gi)) set.add(m[0]);
  }
  return [...set];
}
async function loadStylesheet(id, base) {
  let file;
  if (id === 'tailwindcss') file = path.join(NM, 'tailwindcss', 'index.css');
  else if (id.startsWith('tailwindcss/')) file = path.join(NM, id.endsWith('.css') ? id : id + '.css');
  else file = path.resolve(base, id);
  return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
}
const globals = fs.readFileSync(path.join(WEB, 'app', 'globals.css'), 'utf8');
const compiler = await tw.compile(globals, { base: path.join(WEB, 'app'), loadStylesheet, loadModule: async () => ({ module: {}, base: ROOT }) });
const candidates = scanCandidates();
let css = compiler.build(candidates);
const min = await esbuild.transform(css, { loader: 'css', minify: true, target: ['safari15', 'chrome100'] });
css = min.code;

// ---------------------------------------------------------------- one HTML file
const THEME_INIT = `try{var t=localStorage.getItem('botix-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}`;
const ICON =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#151920"/><rect x="18" y="14" width="28" height="9" rx="3" fill="#FFC21A"/><text x="32" y="47" font-family="Arial" font-size="22" font-weight="800" text-anchor="middle" fill="#fff">B</text></svg>');
const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f1f3f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1217" media="(prefers-color-scheme: dark)">
<title>BotiX – הדגמה</title>
<link rel="icon" href="${ICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Hebrew:wght@400;500;600;700&family=Rubik:wght@400;500;600;700&display=swap">
<script>${THEME_INIT}</script>
<style>:root{--font-plex:'IBM Plex Sans Hebrew';--font-rubik:'Rubik'}</style>
<style>${css}</style>
</head>
<body class="font-sans antialiased">
<div id="root"></div>
<script>${jsText.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
fs.mkdirSync(path.join(DEMO, 'dist'), { recursive: true });
const out = path.join(DEMO, 'dist', 'index.html');
fs.writeFileSync(out, html);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`built ${path.relative(ROOT, out)}: ${kb(Buffer.byteLength(html))} (js ${kb(jsText.length)}, css ${kb(css.length)}, ${routes.length} screens) in ${Date.now() - t0} ms`);
