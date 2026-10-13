// Builds demo/vendor/lucide.jsx (a lucide-react compatible module) from the lucide icon SVGs.
import fs from 'fs'; import path from 'path';
const dir = process.argv[2]; const out = process.argv[3];
const pascal = (k) => k.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
const lines = [`import { createElement as h, forwardRef } from 'react';`,
`const mk = (name, nodes) => { const C = forwardRef(({ size = 24, strokeWidth = 2, className, color = 'currentColor', ...rest }, ref) => h('svg', { ref, xmlns: 'http://www.w3.org/2000/svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', className: ['lucide', className].filter(Boolean).join(' '), 'aria-hidden': rest['aria-label'] ? undefined : true, ...rest }, ...nodes.map(([t, a], i) => h(t, { key: i, ...a })))); C.displayName = name; return C; };`];
const seen = new Set();
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).sort()) {
  const key = f.slice(0, -4);
  const svg = fs.readFileSync(path.join(dir, f), 'utf8');
  const nodes = [...svg.matchAll(/<(path|circle|rect|line|polyline|polygon|ellipse)\s([^>]*?)\/?>/g)].map(([, t, a]) => {
    const o = {}; for (const [, k, v] of a.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) o[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; return [t, o];
  });
  const names = [pascal(key)];
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, key + '.json'), 'utf8')); for (const a of j.aliases || []) names.push(pascal(typeof a === 'string' ? a : a.name)); } catch {}
  const id = 'I_' + key.replace(/-/g, '_');
  lines.push(`const ${id} = /* @__PURE__ */ mk(${JSON.stringify(names[0])}, ${JSON.stringify(nodes)});`);
  for (const n of names) for (const v of [n, n + 'Icon', 'Lucide' + n]) if (!seen.has(v)) { seen.add(v); lines.push(`export { ${id} as ${v} };`); }
}
fs.writeFileSync(out, lines.join('\n'));
console.log('icons', seen.size);
