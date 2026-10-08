import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * INSTRUKTORNING KUNLIK JADVALI — RASM (Excel ko'rinishida)
 *
 * Adminlar guruhga Excel jadvalning skrinshotini tashlashardi; instruktor
 * undan o'z ustunini topib, raqamlarni qo'lda terib qo'ng'iroq qilardi.
 * Endi bot har instruktorga FAQAT uning ustunini rasm qilib yuboradi
 * (raqamlar esa rasm ostida bosib qo'ng'iroq qilinadigan ro'yxat).
 *
 * SVG chiziladi va @resvg/resvg-js bilan PNG qilinadi. Shrift — Carlito
 * (Excel'dagi Calibri bilan bir xil o'lchamli, OFL), backend/assets/fonts.
 * Rasm chizib bo'lmasa (kutubxona yoki shrift yo'q) — null; bot shunda
 * faqat matnli ro'yxat yuboradi.
 */

export type DayRowKind = 'bron' | 'band' | 'app' | 'off' | 'own' | 'free';
export type DayRow = { h: number; main: string; sub: string; tag: string; kind: DayRowKind; past: boolean };
export type DayImage = { title: string; insName: string; insPhone: string; rows: DayRow[]; footer: string };

const xml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);
const cut = (v: string, n: number) => (v.length > n ? v.slice(0, n - 1) + '…' : v);

const KIND: Record<DayRowKind, { bg: string; fg: string; tagBg: string; tagFg: string }> = {
  bron: { bg: '#fff7c2', fg: '#141833', tagBg: '#2b2f8f', tagFg: '#ffffff' },
  band: { bg: '#eef0f4', fg: '#30364f', tagBg: '#8a90a2', tagFg: '#ffffff' },
  app: { bg: '#fde2e4', fg: '#8a1c24', tagBg: '#c62f35', tagFg: '#ffffff' },
  off: { bg: '#f1eefa', fg: '#6b5a97', tagBg: '#ddd5f0', tagFg: '#4b3c78' },
  own: { bg: '#e4e7ee', fg: '#555d70', tagBg: '#c9cfdb', tagFg: '#30364f' },
  free: { bg: '#ffffff', fg: '#9aa1b2', tagBg: '#ffffff', tagFg: '#9aa1b2' },
};

/** Jadval SVG'si (testlar ham shuni tekshiradi). */
export function dayImageSvg(d: DayImage): string {
  const W = 720, TITLE = 58, HEAD = 64, ROW = 46, FOOT = 44, HC = 96, TAGW = 190;
  const H = TITLE + HEAD + d.rows.length * ROW + FOOT;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Carlito">`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  /* sarlavha */
  out.push(`<rect width="${W}" height="${TITLE}" fill="#2b2f8f"/>`);
  out.push(`<text x="18" y="37" font-size="24" font-weight="700" fill="#ffffff">${xml(cut(d.title, 44))}</text>`);
  out.push(`<text x="${W - 18}" y="36" font-size="15" font-weight="700" fill="#c9caf8" text-anchor="end" letter-spacing="1">TASH INDEX AVTODROM</text>`);
  /* ustun boshi — Excel'dagidek: soat (qizil) va instruktor (sariq) */
  const y0 = TITLE;
  out.push(`<rect x="0" y="${y0}" width="${HC}" height="${HEAD}" fill="#c62f35"/>`);
  out.push(`<text x="${HC / 2}" y="${y0 + 39}" font-size="18" font-weight="700" fill="#ffffff" text-anchor="middle">Soat</text>`);
  out.push(`<rect x="${HC}" y="${y0}" width="${W - HC}" height="${HEAD}" fill="#fde047"/>`);
  out.push(`<text x="${HC + 16}" y="${y0 + 30}" font-size="24" font-weight="700" fill="#141833">${xml(cut(d.insName.toUpperCase(), 34))}</text>`);
  out.push(`<text x="${HC + 16}" y="${y0 + 52}" font-size="17" fill="#30364f">${xml(d.insPhone)}</text>`);
  /* qatorlar */
  d.rows.forEach((r, i) => {
    const y = TITLE + HEAD + i * ROW, k = KIND[r.kind];
    const op = r.past ? ' opacity="0.55"' : '';
    out.push(`<g${op}>`);
    out.push(`<rect x="0" y="${y}" width="${HC}" height="${ROW}" fill="${r.past ? '#f0a6a8' : '#e5484d'}"/>`);
    out.push(`<text x="${HC / 2}" y="${y + 30}" font-size="21" font-weight="700" fill="#ffffff" text-anchor="middle">${r.h}:00</text>`);
    out.push(`<rect x="${HC}" y="${y}" width="${W - HC}" height="${ROW}" fill="${k.bg}"/>`);
    if (r.kind === 'off') {
      /* chiziqlar faqat katak ichida (soat ustuniga chiqmasin) */
      out.push(`<clipPath id="off${i}"><rect x="${HC}" y="${y}" width="${W - HC}" height="${ROW}"/></clipPath><g clip-path="url(#off${i})">`);
      for (let x = HC - ROW; x < W; x += 14) out.push(`<line x1="${x}" y1="${y + ROW}" x2="${x + ROW}" y2="${y}" stroke="#e4ddf5" stroke-width="5"/>`);
      out.push('</g>');
    }
    if (r.main) {
      const twoLines = !!r.sub;
      out.push(`<text x="${HC + 16}" y="${y + (twoLines ? 21 : 30)}" font-size="${twoLines ? 20 : 21}" font-weight="700" fill="${k.fg}">${xml(cut(r.main, 30))}</text>`);
      if (twoLines) out.push(`<text x="${HC + 16}" y="${y + 39}" font-size="15" fill="${k.fg}" fill-opacity="0.8">${xml(cut(r.sub, 40))}</text>`);
    }
    if (r.tag) {
      const tw = Math.min(TAGW - 16, 18 + r.tag.length * 9.2);
      const tx = W - 12 - tw;
      out.push(`<rect x="${tx}" y="${y + 10}" width="${tw}" height="26" rx="7" fill="${k.tagBg}"/>`);
      out.push(`<text x="${tx + tw / 2}" y="${y + 28}" font-size="15" font-weight="700" fill="${k.tagFg}" text-anchor="middle">${xml(cut(r.tag, 18))}</text>`);
    }
    out.push(`<line x1="0" y1="${y + ROW}" x2="${W}" y2="${y + ROW}" stroke="#cfd5e1" stroke-width="1"/>`);
    out.push('</g>');
  });
  out.push(`<line x1="${HC}" y1="${TITLE}" x2="${HC}" y2="${H - FOOT}" stroke="#cfd5e1" stroke-width="1"/>`);
  /* izoh */
  const fy = H - FOOT;
  out.push(`<rect x="0" y="${fy}" width="${W}" height="${FOOT}" fill="#f4f5fa"/>`);
  out.push(`<text x="18" y="${fy + 28}" font-size="16" fill="#6b7188">${xml(cut(d.footer, 80))}</text>`);
  out.push('</svg>');
  return out.join('');
}

let fontFiles: string[] | null = null;
function fonts(): string[] {
  if (fontFiles) return fontFiles;
  const dir = new URL('../assets/fonts/', import.meta.url);
  fontFiles = ['Carlito-Regular.ttf', 'Carlito-Bold.ttf'].map((f) => fileURLToPath(new URL(f, dir)));
  for (const f of fontFiles) readFileSync(f);           // yo'q bo'lsa — xato (rasm o'rniga matn)
  return fontFiles;
}

/** PNG (1080 px eni). Chizib bo'lmasa — null. */
export async function renderDayPng(d: DayImage): Promise<Uint8Array | null> {
  try {
    const mod: any = await import('@resvg/resvg-js');
    const Resvg = mod.Resvg || mod.default?.Resvg;
    if (!Resvg) return null;
    const r = new Resvg(dayImageSvg(d), {
      font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: 'Carlito' },
      fitTo: { mode: 'width', value: 1080 },
    });
    return r.render().asPng();
  } catch (e) {
    console.warn('day image render failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
