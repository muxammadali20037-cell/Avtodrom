/* INSTRUKTOR PANELI — XABAR (TOAST)
   Muammo: ekran pastida o'rtada qora nuqta doim turardi, xabar
   chiqqandan keyin esa yozuv yo'qolmasdi.

   Sabab: CSS da `.toast{ animation: toastIn .3s both }` turardi.
   `both` to'ldirish rejimi animatsiyaning oxirgi holatini (opacity:1)
   DOIMIY qoldiradi va u oddiy `opacity:0` qoidasidan kuchliroq.
   Ya'ni toast sahifa ochilishidanoq ko'rinib turardi — bo'sh bo'lgani
   uchun kichik qora quticha bo'lib, xabar chiqqach esa o'chmasdi.

   Tekshiramiz:
     1) sahifa ochilganda toast KO'RINMAYDI (qora nuqta yo'q)
     2) xabar chiqadi va 2.8 soniyada yo'qoladi
     3) bo'sh matn umuman chiqmaydi
     4) bosilsa yopiladi                                                */
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import http from 'node:http';
import fs from 'node:fs';

const FILE = process.argv[2] || '../instructor/index.html';
const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync(FILE));
});
await new Promise(r => server.listen(0, r));
const P = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
await page.route('**', r => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
page.setDefaultTimeout(9000);
const errs = []; page.on('pageerror', e => errs.push(e.message));

await page.goto(`http://localhost:${P}/`);
await page.waitForTimeout(1500);

/** Ko'zga ko'rinadimi — opacity va o'lchov bo'yicha */
const st = () => page.evaluate(() => {
  const x = document.getElementById('toast');
  if (!x) return { yoq: true };
  const c = getComputedStyle(x), r = x.getBoundingClientRect();
  return {
    on: x.classList.contains('on'),
    text: x.textContent,
    opacity: Number(c.opacity).toFixed(2),
    visibility: c.visibility,
    w: Math.round(r.width), h: Math.round(r.height),
    cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top),
    korinadi: Number(c.opacity) > 0.05 && c.visibility !== 'hidden' && r.width > 0,
  };
});

console.log('=== 1) SAHIFA OCHILGANDA (qora nuqta) ===');
let v = await st();
console.log('  holat:', JSON.stringify(v));
console.log('  ko‘rinmaydi:', v.korinadi ? `❌ ${v.w}x${v.h} quticha turibdi` : '✅');

console.log('\n=== 2) XABAR CHIQDI ===');
await page.evaluate(() => toast('Dars boshlandi'));
await page.waitForTimeout(350);
v = await st();
console.log('  chiqdi:', v.korinadi ? '✅' : '❌', '|', JSON.stringify(v.text));
await page.waitForTimeout(3000);
v = await st();
console.log('  2.8s dan keyin yo‘qoldi:', v.korinadi ? '❌ qotib qoldi' : '✅');

console.log('\n=== 3) BO‘SH MATN ===');
for (const bad of ['', '  ', null, undefined]) {
  await page.evaluate(b => toast(b), bad);
  await page.waitForTimeout(200);
  v = await st();
  console.log(`  toast(${JSON.stringify(bad)}) →`, v.korinadi ? `❌ ${v.w}x${v.h}` : '✅ chiqmadi');
}

console.log('\n=== 4) BOSIB YOPISH ===');
await page.evaluate(() => toast('Bosib yopiladi'));
await page.waitForTimeout(300);
await page.click('#toast');
await page.waitForTimeout(300);
v = await st();
console.log('  yopildi:', v.korinadi ? '❌' : '✅');

console.log('\n=== JS XATOLAR ===');
console.log(errs.length ? [...new Set(errs)].slice(0, 4).join('\n') : "  yo'q ✅");
await browser.close(); server.close();
