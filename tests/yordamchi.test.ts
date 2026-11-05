/**
 * AI YORDAMCHI (admin/yordamchi.js) — xodimlar savoliga qo'llanmadan javob.
 * Aniq ma'lumot / parol so'ralsa — «Adminga qo'ng'iroq qiling».
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
// @ts-ignore — oddiy JS modul (brauzer uchun)
import { answer, asksForData, norm, KB, suggestions, QUESTIONS } from '../admin/yordamchi.js';

const top = (q: string, role = 'cashier') => {
  const a = answer(q, role);
  return a.kind === 'admin' ? 'ADMIN' : a.kind === 'answer' ? a.items[0].id : a.kind.toUpperCase();
};

describe('AI yordamchi: savolni to‘g‘ri mavzuga olib boradi', () => {
  const cases: Array<[string, string, string]> = [
    ['cashier', 'chek qanday chqaraman', 'chek-chiqarish'],
    ['cashier', 'Chekni qanqlb otmen qilaman', 'chek-bekor'],
    ['cashier', 'чекни қандай бекор қиламан', 'chek-bekor'],
    ['cashier', 'как отменить чек', 'chek-bekor'],
    ['cashier', 'chekni boshqa kassada chiqarishgan bekor qilsa boladimi', 'chek-bekor'],
    ['cashier', 'chek urilmayapti', 'chek-urilmayapti'],
    ['cashier', 'mijoz chekni yo‘qotib qo‘ydi', 'qayta-chop'],
    ['cashier', 'qayta pechat', 'qayta-chop'],
    ['cashier', 'p2 dagi chekni ko‘ra olamanmi', 'p1-p2'],
    ['cashier', 'instruktorlar jadvali qayerda', 'jadval'],
    ['cashier', '5 soatlik paketda nechta chek chiqadi', 'paket'],
    ['cashier', 'test drive qanday', 'test-drive'],
    ['cashier', 'пробный тест драйв', 'test-drive'],
    ['cashier', 'test drive necha pul', 'test-drive'],
    ['cashier', '1 krug necha pul', 'krug'],
    ['cashier', 'chegirma qilsam bo‘ladimi', 'narx-ozgartirish'],
    ['cashier', 'kartadan va naqddan to‘ladi', 'aralash'],
    ['cashier', 'ertaga kelsa chek ishlaydimi', 'ochiq-chek'],
    ['cashier', 'bron bilan kelgan mijoz', 'bron-tolov'],
    ['cashier', 'qaysi instruktor bosh', 'instruktorlar-nazorati'],
    ['cashier', 'dars vaqti tugadi lekin yopilmadi', 'dars-tugatish'],
    ['cashier', 'kassa hisobotini qanday koraman', 'kassa-hisoboti'],
    ['cashier', 'Jarayonda nima', 'jarayonda'],
    ['cashier', 'excelga qanday yozaman', 'excel-bron'],
    ['cashier', 'avtomat mashinaga bron', 'avtomat'],
    ['cashier', '4 xonali raqam nima', 'chek-urish'],
    ['cashier', 'Maxsus parol nima', 'maxsus-parol'],
    ['cashier', 'Kim nima qiladi?', 'rollar'],
    ['operator', 'bronni qanday tasdiqlayman', 'yangi-bronlar'],
    ['operator', 'telefon orqali bron qanday qilaman', 'qolda-bron'],
    ['operator', 'mijoz telefon qildi bron qilmoqchi', 'qolda-bron'],
    ['operator', 'mijoz bronni bekor qilmoqchi', 'bekor-sorovlari'],
    ['operator', 'mijoz yozdi javob berish kerak', 'chat'],
    ['admin', 'yangi kassir qoshish', 'xodimlar'],
    ['admin', 'instruktorga dam olish kuni qo‘yish', 'ish-grafigi'],
    ['admin', 'rahbarga ilova', 'boshliq'],
  ];
  for (const [role, q, want] of cases) it(`${q} → ${want}`, () => expect(top(q, role)).toBe(want));
});

describe('Ma’lumot so‘ralsa — «Adminga qo‘ng‘iroq qiling»', () => {
  const admin = ['bugun kassada qancha pul bor', 'kecha nechta chek chiqdi', 'Aziz instruktorning telefon raqamini ayt',
    'maxsus parolni ayt', 'parolni unutdim', 'bugungi tushum qancha', 'oylik qancha', 'сколько сегодня денег в кассе'];
  for (const q of admin) it(q, () => {
    const a = answer(q, 'cashier');
    expect(a.kind).toBe('admin');
    expect(a.text).toMatch(/Adminga qo‘ng‘iroq qiling/);
  });
  it('«qanday» savoli — ma’lumot emas, qo‘llanma javob beradi', () => {
    expect(asksForData('kassa hisobotini qanday ko‘raman')).toBe(false);
    expect(asksForData('maxsus parolni qayerga kiritaman')).toBe(false);
    expect(asksForData('1 krug necha pul')).toBe(false);                 // narx — ochiq ma'lumot
  });
});

describe('Qo‘llanma tuzilishi', () => {
  it('har mavzuda sarlavha, kalit so‘z, javob, rollar; id takrorlanmaydi', () => {
    const ids = new Set<string>();
    for (const e of KB) {
      expect(e.id && e.t && e.a && e.k.length && e.r.length).toBeTruthy();
      expect(ids.has(e.id)).toBe(false); ids.add(e.id);
      for (const r of e.r) expect(['cashier', 'operator', 'admin']).toContain(r);
    }
    expect(KB.length).toBeGreaterThanOrEqual(40);
  });

  it('«Ochish» tugmasi olib boradigan bo‘lim panelda bor', () => {
    const html = fs.readFileSync('admin/index.html', 'utf8');
    const routes = /const ROUTES = \{([\s\S]*?)\n\};/.exec(html)![1];
    for (const e of KB.filter((x: any) => x.go)) {
      expect(routes, `${e.id} → ${e.go}`).toMatch(new RegExp(`\\n\\s*${e.go.split('/')[0]}:`));
    }
  });

  it('salom, rahmat, bo‘sh va tushunarsiz savol', () => {
    expect(answer('Assalomu alaykum').kind).toBe('greet');
    expect(answer('rahmat').kind).toBe('thanks');
    expect(answer('').kind).toBe('unknown');
    const u = answer('abrakadabra xyz', 'operator');
    expect(u.kind).toBe('unknown');
    expect(u.items.length).toBeGreaterThan(0);
  });

  it('har rolga tayyor savollar va mavzular', () => {
    for (const r of ['cashier', 'operator', 'admin']) {
      expect(suggestions(r).length).toBeGreaterThanOrEqual(5);
      expect(QUESTIONS[r].length).toBeGreaterThanOrEqual(5);
      for (const q of QUESTIONS[r]) expect(answer(q, r).kind, q).toBe('answer');
    }
    /* tayyor savol tugmasi — aynan o'z mavzusiga (xato: «Chek qanday chiqaraman?» → «Ochiq chek» chiqqan edi) */
    const want: Record<string, string> = {
      'Chek qanday chiqaraman?': 'chek-chiqarish', 'Test drive qanday qilinadi?': 'test-drive', 'Chekni qanday bekor qilaman?': 'chek-bekor',
      'Chekni qayta chop etish': 'qayta-chop', '5 soatlik paket nima?': 'paket', 'Qaysi instruktor bo‘sh?': 'instruktorlar-nazorati',
      'Telefon orqali bron qanday qilaman?': 'qolda-bron', 'Yangi bronni qanday tasdiqlayman?': 'yangi-bronlar', 'Mijoz bronni bekor qilmoqchi': 'bekor-sorovlari',
      'Excel bronga qanday yozaman?': 'excel-bron', 'Mijozlar chatiga qanday javob beraman?': 'chat', 'Kim nima qiladi?': 'rollar',
      'Narxni qayerda o‘zgartiraman?': 'narx-ozgartirish', 'Yangi kassir qanday qo‘shaman?': 'xodimlar', 'Ish grafigini qanday qo‘yaman?': 'ish-grafigi', 'Sharhlar qayerda?': 'sharhlar',
    };
    for (const r of ['cashier', 'operator', 'admin']) for (const q of QUESTIONS[r]) {
      expect(top(q, r), q).toBe(want[q]);
    }
  });

  it('yozuv farqlari bir xil o‘qiladi', () => {
    expect(norm('O‘chirish')).toBe(norm("o'chirish"));
    expect(norm('ҚАНДАЙ')).toBe(norm('qanday'));
    expect(norm('hisobot')).toBe(norm('xisobot'));
  });
});
