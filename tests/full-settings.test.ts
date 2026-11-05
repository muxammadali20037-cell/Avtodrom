/**
 * Kengaytirilgan panel (admin/full.html) → Sozlamalar: sodda paneldagi
 * «Narxlar va ish vaqti» da o'zgaradigan HAMMA sozlama shu yerda ham bor
 * (masalan, test drive narxi). Yangi sozlama faqat bitta panelga qo'shilib
 * qolmasin.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const full = fs.readFileSync('admin/full.html', 'utf8');
const simple = fs.readFileSync('admin/index.html', 'utf8');

describe('Kengaytirilgan panel sozlamalari', () => {
  it('sodda panel saqlaydigan har bir kalit kengaytirilgan panelda ham saqlanadi', () => {
    const save = /ACT\.prsave = async[\s\S]*?\n\};/.exec(simple)![0];
    const keys = new Set<string>();
    for (const m of save.matchAll(/vals\.([a-z0-9_]+)\s*=/g)) keys.add(m[1]);
    for (const m of save.matchAll(/vals\['(half|rate|tarif3)_' \+/g)) for (const c of ['a', 'b', 'c']) keys.add(`${m[1]}_${c}`);
    expect([...keys]).toEqual(expect.arrayContaining(['test_drive_price', 'krug_price', 'krug_min', 'tarif3_b', 'reminder_minutes', 'late_cancel_min', 'booking_auto_confirm']));
    const missing = [...keys].filter((k) => !new RegExp(`put\\('${k}'`).test(full));
    expect(missing).toEqual([]);
  });

  it('test drive maydoni, standarti va kassadagi narx izohi bor', () => {
    expect(full).toMatch(/id="tdPrice"/);
    expect(full).toMatch(/numOr\('test_drive_price',50000\)/);
    expect(full).toMatch(/function tdHintPaint/);
  });

  it('«Barcha sozlamalar (texnik)»: istalgan sozlamani JSON bilan o‘zgartirish', () => {
    expect(full).toMatch(/Barcha sozlamalar \(texnik\)/);
    expect(full).toMatch(/function rawEdit/);
    expect(full).toMatch(/JSON\.parse\(\$\('rawVal'\)\.value\)/);
  });
});
