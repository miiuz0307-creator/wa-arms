// Turns demo/dist/index.html into the page body expected by the Artifact host (it adds its own
// doctype/html/head/body skeleton): title first, RTL set by script, viewer theme respected.
import fs from 'fs';
const src = fs.readFileSync('demo/dist/index.html', 'utf8');
let h = src
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '')
  .replace(/<\/?head>\s*/gi, '')
  .replace(/<body[^>]*>/i, '')
  .replace(/<\/body>\s*<\/html>\s*$/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .replace(/<title>[^<]*<\/title>\s*/i, '');
const theme = `try{var r=document.documentElement;r.lang='he';r.dir='rtl';var t=null;try{t=localStorage.getItem('botix-theme')}catch(e){}var a=r.getAttribute('data-theme');var d=t==='dark'||(t!=='light'&&(a==='dark'||(a!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches)));r.classList.toggle('dark',d)}catch(e){}`;
h = `<title>BotiX v2</title>\n<script>${theme}</script>\n<style>html,body{background:var(--bg,#f1f3f5)}</style>\n` + h;
fs.writeFileSync('demo/dist/botix-v2.html', h);
console.log('demo/dist/botix-v2.html', Math.round(h.length / 1024), 'KB');
