/* AVTOSHKOLA KO'PRIGI — TASHXIS
   Instruktor AVS-chekni skanerlaganda «hali sozlanmagan» chiqdi.
   Sabab har doim bitta: Vercel'da AVTODROM12_URL / RECEIPT_SHARED_KEY yo'q
   yoki ikkala loyihadagi kalit boshqa-boshqa.

   Endi administrator Sozlamalar bo'limidan o'zi ko'radi. Tekshiramiz:
     1) Sozlamalar ochilganda tashxis o'zi ishga tushadi
     2) Hammasi joyida bo'lsa — yashil «ishlayapti»
     3) URL yo'q bo'lsa — qaysi o'zgaruvchi yetishmayotgani yoziladi
     4) Kalitlar mos kelmasa — shu aytiladi
     5) Ko'rsatma (nima qilish kerak) faqat xato holatda chiqadi        */
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import http from 'node:http';
import fs from 'node:fs';

const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync('../admin/index.html'));
});
await new Promise(r => server.listen(0, r));
const P = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
await page.route('**', r => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
page.setDefaultTimeout(9000);

await page.addInitScript(() => {
  const J = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const me = { ok: true, login: 'Adminn', role: 'admin', full_name: 'Bosh Administrator' };
  /* Holatni test o'zi almashtiradi */
  window.__bridge = {
    ok: true, url_set: true, key_set: true, url: 'https://avtodrom12-five.vercel.app',
    reachable: true, status: 404, detail: 'Ulanish va kalit joyida',
  };
  window.fetch = async (url) => {
    const u = String(url).split('?')[0];
    if (u === '/api/admin/me') return J(me);
    if (u === '/api/admin/login') return J(me);
    if (u === '/api/admin/school-bridge/status') return J({ ok: true, bridge: window.__bridge });
    return J({ ok: true, rows: [], items: [], bookings: [], list: [], data: [], registers: [], instructors: [], summary: {}, totals: {}, stats: {} });
  };
});
const errs = []; page.on('pageerror', e => errs.push(e.message));

const read = () => page.evaluate(() => ({
  badge: document.getElementById('sbBadge')?.textContent.trim(),
  cls: document.getElementById('sbBadge')?.className,
  body: document.getElementById('sbBody')?.innerText.replace(/\s+/g, ' ').trim(),
  hasHelp: !!document.querySelector('#sbBody .warn'),
}));

await page.goto(`http://localhost:${P}/`);
await page.waitForTimeout(1300);
await page.click('.rolebtn[data-role="admin"]');
await page.waitForTimeout(300);
await page.fill('#loginUser', 'Adminn');
await page.fill('#loginPass', '12345678');
await page.click('#loginBtn');
await page.waitForTimeout(1900);

console.log('=== 1) SOZLAMALAR OCHILDI — O‘ZI TEKSHIRDI ===');
await page.click('.nav[data-p="settings"]');
await page.waitForTimeout(1000);
let v = await read();
console.log('  belgi:', v.badge, v.badge === 'ishlayapti' ? '✅' : '❌');
console.log('  yashil:', /\bok\b/.test(v.cls) ? '✅' : '❌');
console.log('  ko‘rsatma chiqmadi (kerak emas):', v.hasHelp ? '❌' : '✅');
console.log(' ', v.body.slice(0, 120));

console.log('\n=== 2) URL QO‘YILMAGAN ===');
await page.evaluate(() => {
  window.__bridge = { ok: false, url_set: false, key_set: true, url: '', reachable: false, status: null,
    detail: 'Vercel sozlamasida AVTODROM12_URL yo‘q' };
});
await page.click('#sbCheck');
await page.waitForTimeout(700);
v = await read();
console.log('  belgi:', v.badge, v.badge === 'ishlamayapti' ? '✅' : '❌');
console.log('  qizil:', /\bbad\b/.test(v.cls) ? '✅' : '❌');
console.log('  sabab yozildi:', /AVTODROM12_URL/.test(v.body) ? '✅' : '❌');
console.log('  ko‘rsatma chiqdi:', v.hasHelp ? '✅' : '❌');

console.log('\n=== 3) KALITLAR MOS EMAS ===');
await page.evaluate(() => {
  window.__bridge = { ok: false, url_set: true, key_set: true, url: 'https://avtodrom12-five.vercel.app',
    reachable: true, status: 401, detail: 'Kalitlar bir xil emas — ikkala loyihada RECEIPT_SHARED_KEY aynan bir xil bo‘lsin' };
});
await page.click('#sbCheck');
await page.waitForTimeout(700);
v = await read();
console.log('  belgi:', v.badge, v.badge === 'ishlamayapti' ? '✅' : '❌');
console.log('  ulanish bor deb ko‘rsatdi:', /ulanish — bor/i.test(v.body) ? '✅' : '❌');
console.log('  sabab:', /Kalitlar bir xil emas/.test(v.body) ? '✅' : '❌');

console.log('\n=== 4) avtodrom12 TOMONIDA KALIT YO‘Q ===');
await page.evaluate(() => {
  window.__bridge = { ok: false, url_set: true, key_set: true, url: 'https://avtodrom12-five.vercel.app',
    reachable: true, status: 503, detail: 'avtodrom12 tomonida RECEIPT_SHARED_KEY qo‘yilmagan' };
});
await page.click('#sbCheck');
await page.waitForTimeout(700);
v = await read();
console.log('  sabab:', /avtodrom12 tomonida/.test(v.body) ? '✅' : '❌');
console.log('  javob kodi ko‘rindi (503):', /503/.test(v.body) ? '✅' : '❌');

console.log('\n=== 5) SERVER JAVOB BERMADI ===');
await page.evaluate(() => {
  window.__bridge = { ok: false, url_set: true, key_set: true, url: 'https://avtodrom12-five.vercel.app',
    reachable: false, status: null, detail: 'avtodrom12 javob bermadi (10 soniya)' };
});
await page.click('#sbCheck');
await page.waitForTimeout(700);
v = await read();
console.log('  sabab:', /javob bermadi/.test(v.body) ? '✅' : '❌');

console.log('\n=== JS XATOLAR ===');
console.log(errs.length ? [...new Set(errs)].slice(0, 6).join('\n') : "  yo'q ✅");
await browser.close(); server.close();
