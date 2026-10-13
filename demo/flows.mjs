// Clicks through the main demo flows in Chromium and checks the results in the demo data:
// station-code login (active + ended subscription), manual send → history, a new arm (QR → online),
// payment request by a station → owner approves → subscription extended + WhatsApp messages, footer, reset.
//   node demo/flows.mjs
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = process.env.DEMO_NODE_MODULES || '/opt/npm-tools/node_modules';
const { chromium } = createRequire(path.join(NM, 'noop.js'))('playwright');
const FILE = pathToFileURL(path.join(ROOT, 'demo', 'dist', 'index.html')).href;
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
await ctx.route(/^https?:\/\//, (r) => r.abort());
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
page.on('pageerror', (e) => errs.push(e.message));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' – ' + extra : ''));
  if (!ok) failed++;
};
const rpc = (fn, args) => page.evaluate(async ([f, a]) => { const r = await window.__botixDemo.sb().rpc(f, a); return { data: r.data, error: r.error }; }, [fn, args]);
const q = (fnSrc) => page.evaluate(`(async () => { const sb = window.__botixDemo.sb(); ${fnSrc} })()`);
const go = async (hash) => {
  await page.goto(FILE + '#' + hash);
  await page.waitForTimeout(900);
};
const persona = async (p) => {
  await page.evaluate((x) => window.__botixDemo.setPersona(x), p);
  await page.waitForLoadState('load');
  await page.waitForTimeout(1200);
};

await page.goto(FILE + '#/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(1500);
check('first visit logs in as the owner', (await page.evaluate(() => location.hash)) === '#/' && (await page.textContent('body')).includes('מאיר'));

// ---- station code login
await page.evaluate(() => window.__botixDemo.sb().auth.signOut());
await go('/login');
await page.reload();
await page.waitForTimeout(1200);
await page.fill('input[placeholder="XXXXXXXX"]', 'SHARON26');
await page.click('button[type=submit]');
await page.waitForTimeout(2500);
check('code login SHARON26 → station home', (await page.textContent('body')).includes('מוניות השרון'), await page.evaluate(() => location.hash));

await page.evaluate(() => {
  localStorage.removeItem('wa-station-token');
});
await go('/login');
await page.reload();
await page.waitForTimeout(1200);
await page.fill('input[placeholder="XXXXXXXX"]', 'SOUTH555');
await page.click('button[type=submit]');
await page.waitForTimeout(3000);
const h = await page.evaluate(() => location.hash);
check('code login of an ended subscription → only the subscription page', h.startsWith('#/subscription'), h);
await go('/groups');
await page.waitForTimeout(800);
check('ended subscription cannot open other screens', (await page.evaluate(() => location.hash)).startsWith('#/subscription'));
const me = await rpc('station_me');
const bill = await rpc('station_billing');
check('ended: station_me null, station_billing works', me.data === null && bill.data?.name === 'אורות הדרום');

// ---- payment request from the active station, owner approves
await persona('station');
const before = (await rpc('station_billing')).data;
const sub = await rpc('station_payment_submit', { p_amount: 349, p_months: 1, p_method: 'bit', p_proof: 'data:image/png;base64,iVBORw0KGgo=', p_note: 'בדיקה' });
check('station submits a payment proof', !sub.error && sub.data?.token, JSON.stringify(sub.error));
const dup = await rpc('station_payment_submit', { p_amount: 349, p_months: 1, p_method: 'bit', p_proof: null });
check('a second pending request is blocked', dup.error?.message === 'כבר קיימת בקשה ממתינה');
await persona('owner');
await go('/pay?r=' + sub.data.token);
await page.reload();
await page.waitForTimeout(1500);
check('owner opens the WhatsApp approval link', (await page.textContent('body')).includes('מוניות השרון'));
const dec = await rpc('owner_payment_decide', { p_id: sub.data.id, p_approve: true });
check('owner approves', dec.data?.status === 'approved', JSON.stringify(dec));
const again = await rpc('owner_payment_decide', { p_id: sub.data.id, p_approve: true });
check('double approve blocked', again.error?.message === 'הבקשה כבר טופלה');
await persona('station');
const after = (await rpc('station_billing')).data;
check('subscription extended by a month', after.sub_end > before.sub_end, before.sub_end + ' → ' + after.sub_end);
await page.waitForTimeout(3500);
const out = await q(`return JSON.parse(localStorage.getItem('botix-demo-db')) && null`);
void out;

// ---- manual send → history
await persona('operator');
const lists = await q(`const { data } = await sb.from('distribution_lists').select('id,name, list_groups(count)').order('name'); return data;`);
check('operator sees the station lists (with embedded count)', lists?.length >= 6 && lists[0].list_groups?.[0]?.count >= 0, String(lists?.length));
const vip = lists.find((l) => l.name === 'VIP');
const camp = await rpc('create_manual_campaign', { p_message: 'בדיקת הדגמה 🚕', p_arm_ids: null, p_group_ids: null, p_list_id: vip.id });
check('manual send creates a ride', typeof camp.data === 'string', JSON.stringify(camp.error));
await go('/history/' + camp.data);
await page.reload();
await page.waitForTimeout(9000);
const prog = await q(`const { data } = await sb.from('campaign_targets').select('status').eq('campaign_id', '${camp.data}'); return data.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});`);
check('ride targets progress to sent', (prog.sent || 0) > 0, JSON.stringify(prog));

// ---- paging: 1000-row cap and range
const g1 = await q(`const r = await sb.from('groups').select('id', { count: 'exact' }).order('id'); return [r.data.length, r.count];`);
const g2 = await q(`const r = await sb.from('groups').select('id').order('id').range(1000, 1999); return r.data.length;`);
check('1000-row cap with exact count', g1[0] === 1000 && g1[1] > 1000, JSON.stringify(g1) + ' / page2 ' + g2);

// ---- viewer cannot write
await persona('viewer');
const w = await q(`const r = await sb.from('distribution_lists').insert({ name: 'x' }); return r.error;`);
check('viewer insert blocked by RLS', w?.code === '42501', JSON.stringify(w));

// ---- new arm: QR → online
await persona('station');
const arm = await q(`const r = await sb.from('arms').insert({ name: 'זרוע בדיקה' }).select().single(); return r;`);
check('station adds an arm', !arm.error && arm.data?.id, JSON.stringify(arm.error));
await go('/arms');
await page.reload();
await page.waitForTimeout(4500);
const st1 = await q(`const r = await sb.from('arms').select('status').eq('id', '${arm.data?.id}').single(); return r.data?.status;`);
check('new arm shows a QR', st1 === 'qr', st1);
await page.waitForTimeout(9000);
const st2 = await q(`const r = await sb.from('arms').select('status').eq('id', '${arm.data?.id}').single(); return r.data?.status;`);
check('…then connects', st2 === 'online', st2);

// ---- footer
await persona('owner');
const f = await rpc('owner_footer_set', { p_stations: null, p_text: '🚕 BotiX – הפצה חכמה', p_enabled: true });
const fl = await rpc('owner_footers');
check('owner sets the footer for all stations', f.data === fl.data.length && fl.data.every((x) => x.footer_text === '🚕 BotiX – הפצה חכמה'));

// ---- owner enters a station
await go('/stations');
await page.reload();
await page.waitForTimeout(1200);
await page.evaluate(() => {
  localStorage.setItem('wa-act-station', '0b07a1f0-0000-4000-8000-000000000003');
});
await page.reload();
await page.waitForTimeout(1500);
const acting = await rpc('station_me');
check('owner acting inside קסטל', acting.data?.acting === true && acting.data?.name === 'קסטל מוניות ירושלים');
await page.evaluate(() => localStorage.removeItem('wa-act-station'));

// ---- WhatsApp drawer
await page.reload();
await page.waitForTimeout(1500);
await page.click('[aria-label="וואטסאפ (הדמיה)"]');
await page.waitForTimeout(600);
const wa = await page.textContent('body');
check('WhatsApp drawer lists the approval message', wa.includes('התשלום של מוניות השרון'));
await page.click('text=נסיעות שהופצו לקבוצות');
await page.waitForTimeout(400);
check('ride texts carry the footer', (await page.textContent('body')).includes('BotiX'));
await page.screenshot({ path: path.join(ROOT, 'demo', 'shots', 'flow-whatsapp.png') });

check('no console / page errors', errs.length === 0, errs.slice(0, 5).join(' | '));
await browser.close();
console.log(failed ? `${failed} checks failed` : 'all flows passed');
process.exit(failed ? 1 : 0);
