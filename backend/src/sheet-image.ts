import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * EXCEL BRON — GURUH UCHUN TINIQ RASM
 *
 * Adminlar Excel’ning skrinshotini guruhga tashlardi — mayda, xira, telefonda
 * o'qib bo'lmasdi. Endi bot jadvalni O'ZI chizadi:
 *   · faqat yozuvi bor instruktorlar (bron, BAND, ism) — bo'sh ustun yo'q;
 *   · faqat yozuvli soatlar oralig'i (birinchisidan oxirgisigacha);
 *   · katta, qalin shrift (Carlito Bold), keskin ranglar, ikki barobar
 *     o'lchamda (retina) — kattalashtirsa ham xiralashmaydi;
 *   · ketma-ket soatlardagi bitta bron — bitta katta katak (08:00–10:00);
 *   · instruktor ko'p bo'lsa — bir nechta rasm (har birida ko'pi bilan 5
 *     ustun), Telegram’da albom bo'lib boradi.
 *
 * SVG chiziladi, @resvg/resvg-js bilan PNG qilinadi (instruktor rasmi bilan
 * bir xil yo'l). Chizib bo'lmasa — bo'sh ro'yxat; bot shunda matn yuboradi.
 */

/* publicSheetData() natijasidan kerakli qismi */
export type SheetCell = { k: string; t?: string; name?: string | null; phone?: string | null; code?: string | null; status?: string | null; min?: number | null; paid?: boolean; src?: string | null; cat?: string | null };
export type SheetData = {
  date: string; hours: number[];
  instructors: Array<{ id: string; name: string; phone: string | null; group: string }>;
  cells: Record<string, SheetCell>;
  stats: { instructors: number; busy_instructors: number; bron: number; band: number };
};

export type BlockKind = 'bron' | 'app' | 'band' | 'own' | 'off';
export type SheetBlock = { col: number; h0: number; h1: number; kind: BlockKind; main: string; sub: string; paid: boolean; live: boolean };
export type SheetPart = {
  title: string; line: string; part: string; footer: string;
  cols: Array<{ name: string; phone: string; color: string; group: string }>;
  hours: number[]; past: number[]; blocks: SheetBlock[];
};

/* Admin paneldagi Excel bron ustun ranglari bilan bir xil */
const PAL = ['#fde047', '#86efac', '#cbd5e1', '#fdba74', '#93c5fd', '#a5b4fc', '#f9a8d4', '#5eead4', '#c4b5fd', '#fcd34d', '#7dd3fc', '#bef264'];
const SRC: Record<string, string> = { app: 'App', admin: 'Qo‘lda', walk_in: 'Kassa', school: 'Maktab' };
export const MAX_COLS = 4;          // telefonda o'qilishi uchun: har rasmda ko'pi bilan 4 instruktor

const xml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);
/** Taxminiy en (Carlito Bold): sig'masa «…» bilan qisqartiradi */
function fit(v: string, px: number, size: number, k = 0.54): string {
  const n = Math.max(3, Math.floor(px / (size * k)));
  return v.length > n ? v.slice(0, n - 1).trimEnd() + '…' : v;
}
/** Toifa guruhi rangi: A — to'q sariq, B — ko'k, C — yashil, aralash — binafsha (admin panel va Excel faylda ham shunday) */
export function groupColor(g: string): string {
  const s = String(g || '').toUpperCase().replace(/\s+/g, '');
  return s === 'A' ? '#c2410c' : s === 'B' ? '#2b2f8f' : s === 'C' ? '#047857' : '#6d28d9';
}
const tint = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1), 16), mix = (c: number) => Math.round(c * k + 255 * (1 - k));
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
};
const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
/** «+998901234567» → «90 123 45 67» */
export function shortPhone(p: string | null | undefined): string {
  const m = /(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(String(p || '').replace(/\D/g, ''));
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(p || '');
}

function label(c: SheetCell): { kind: BlockKind; id: string; main: string; sub: string; paid: boolean; live: boolean } | null {
  if (c.k === 'sheet' || c.k === 'bk') {
    const nm = c.name && !/^Mijoz\b/i.test(c.name) ? c.name : '';
    const main = c.phone ? shortPhone(c.phone) : nm || c.t || 'Bron';
    /* toifa va 30 daqiqa — birinchi o'rinda (qisqarsa ham ko'rinsin), keyin kod va ism */
    const sub = [c.cat ? `${c.cat} toifa` : '', c.min && c.min < 60 ? `${c.min} daq` : '', c.k === 'bk' ? SRC[c.src || ''] || '' : '', c.code || '', c.phone ? nm : '']
      .filter(Boolean).join(' · ');
    return { kind: c.k === 'sheet' ? 'bron' : 'app', id: `b:${c.code || c.phone || c.t || ''}`, main, sub, paid: !!c.paid, live: c.status === 'in_progress' };
  }
  if (c.k === 'note') return { kind: 'band', id: `n:${c.t || ''}`, main: String(c.t || 'BAND'), sub: '', paid: false, live: false };
  if (c.k === 'own') return { kind: 'own', id: 'own', main: 'yopiq', sub: '', paid: false, live: false };
  if (c.k === 'off') return { kind: 'off', id: 'off', main: 'dam', sub: '', paid: false, live: false };
  return null;
}

/**
 * Jadval → rasm qismlari. Yozuvi yo'q kun — [] (bot matn yuboradi).
 * nowMs — bugungi o'tgan soatlar och rangda.
 */
export function buildSheetParts(d: SheetData, o: { title: string; line: string; at: string; nowMs?: number; maxCols?: number }): SheetPart[] {
  const maxCols = o.maxCols || MAX_COLS;
  /* har instruktor uchun bloklar (ketma-ket bir xil yozuv — bitta blok) */
  const perIns = d.instructors.map((ins, idx) => {
    const blocks: Array<Omit<SheetBlock, 'col'> & { id: string }> = [];
    for (const h of d.hours) {
      const c = d.cells[`${ins.id}|${String(h).padStart(2, '0')}`];
      const l = c ? label(c) : null;
      if (!l) continue;
      const last = blocks[blocks.length - 1];
      if (last && last.id === l.id && last.h1 === h) { last.h1 = h + 1; last.paid = last.paid || l.paid; last.live = last.live || l.live; continue; }
      blocks.push({ h0: h, h1: h + 1, ...l });
    }
    const real = blocks.filter((b) => b.kind === 'bron' || b.kind === 'app' || b.kind === 'band');
    return { ins, color: PAL[idx % PAL.length], blocks, real };
  }).filter((x) => x.real.length);
  if (!perIns.length) return [];

  /* soatlar: birinchi yozuvdan oxirgisigacha (hamma rasmda bir xil) */
  const h0 = Math.min(...perIns.flatMap((x) => x.real.map((b) => b.h0)));
  const h1 = Math.max(...perIns.flatMap((x) => x.real.map((b) => b.h1)));
  const hours = d.hours.filter((h) => h >= h0 && h < h1);
  const nowMs = o.nowMs ?? Date.now();
  const past = hours.filter((h) => h < 23 && Date.parse(`${d.date}T${pad(h + 1)}:00+05:00`) <= nowMs);

  /* A toifa (mototsikl) ustunlari alohida rasmda; qolganlari birga.
     Har bo'lak teng bo'linadi: 7 ta → 4+3 (5+2 emas) */
  const isA = (g: string) => String(g || '').toUpperCase().startsWith('A');
  const chunks: Array<typeof perIns> = [];
  for (const seg of [perIns.filter((x) => isA(x.ins.group)), perIns.filter((x) => !isA(x.ins.group))]) {
    if (!seg.length) continue;
    const k = Math.ceil(seg.length / maxCols), per = Math.ceil(seg.length / k);
    for (let i = 0; i < k; i++) { const c = seg.slice(i * per, (i + 1) * per); if (c.length) chunks.push(c); }
  }
  const k = chunks.length;
  const parts: SheetPart[] = [];
  for (let i = 0; i < k; i++) {
    const chunk = chunks[i];
    parts.push({
      title: o.title, line: o.line, part: k > 1 ? `${i + 1}/${k}` : '',
      footer: o.at,
      cols: chunk.map((x) => ({ name: x.ins.name, phone: x.ins.phone ? shortPhone(x.ins.phone) : '', color: x.color, group: x.ins.group })),
      hours, past,
      blocks: chunk.flatMap((x, col) => x.blocks
        .map((b) => ({ ...b, h0: Math.max(b.h0, h0), h1: Math.min(b.h1, h1) }))
        .filter((b) => b.h1 > b.h0)
        .map(({ id: _id, ...b }) => ({ ...b, col }))),
    });
  }
  /* bronsiz instruktorlar — oxirgi rasm ostida */
  const free = d.instructors.filter((i) => !perIns.some((x) => x.ins.id === i.id)).map((i) => i.name.split(/\s+/)[0]);
  if (free.length) parts[parts.length - 1].footer = `${o.at} · Bronsiz: ${free.join(', ')}`;
  return parts;
}

const KIND: Record<BlockKind, { bg: string; bar: string; fg: string; sub: string }> = {
  /* bron va Mini App — instruktor ustuni rangining to'q tusida (Excel fayldagidek); chap chiziq manbani ko'rsatadi */
  bron: { bg: '#fff1a6', bar: '#2b2f8f', fg: '#05081a', sub: '#1f2440' },
  app: { bg: '#ffd3da', bar: '#d92d35', fg: '#05081a', sub: '#7a0f18' },
  band: { bg: '#dfe3ec', bar: '#5b6378', fg: '#141a33', sub: '#3a4056' },
  own: { bg: '#e9ebf1', bar: '#9aa1b2', fg: '#4b5368', sub: '#4b5368' },
  off: { bg: '#f1edfa', bar: '#c4b5fd', fg: '#5e4d8f', sub: '#5e4d8f' },
};

/** Bitta rasm SVG'si (testlar ham tekshiradi) */
export function sheetPartSvg(p: SheetPart): string {
  const n = p.cols.length;
  const HC = 116, TITLE = 100, GRP = 36, HEAD = 84, ROW = 74, FOOT = 58;
  const CW = n <= 2 ? 360 : n === 3 ? 310 : n === 4 ? 262 : 232;
  const W = HC + n * CW, top = TITLE + GRP + HEAD, H = top + p.hours.length * ROW + FOOT;
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Carlito">`);
  o.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  /* sarlavha */
  o.push(`<rect width="${W}" height="${TITLE}" fill="#23277a"/>`);
  o.push(`<text x="26" y="52" font-size="38" font-weight="700" fill="#ffffff">${xml(fit(p.title, W - 260, 38, 0.5))}</text>`);
  o.push(`<text x="26" y="84" font-size="23" font-weight="700" fill="#dfe1ff">${xml(fit(p.line, W - 200, 23, 0.5))}</text>`);
  o.push(`<text x="${W - 24}" y="40" font-size="17" font-weight="700" fill="#b9bcf5" text-anchor="end" letter-spacing="1.5">TASH INDEX AVTODROM</text>`);
  if (p.part) {
    o.push(`<rect x="${W - 24 - 92}" y="54" width="92" height="36" rx="18" fill="#fde047"/>`);
    o.push(`<text x="${W - 24 - 46}" y="80" font-size="23" font-weight="700" fill="#141833" text-anchor="middle">${xml(p.part)}</text>`);
  }

  /* burchak + toifa qatori + ism/telefon */
  o.push(`<rect x="0" y="${TITLE}" width="${HC}" height="${GRP + HEAD}" fill="#c62f35"/>`);
  o.push(`<text x="${HC / 2}" y="${TITLE + (GRP + HEAD) / 2 + 9}" font-size="24" font-weight="700" fill="#ffffff" text-anchor="middle">SOAT</text>`);
  let gx = 0;
  while (gx < n) {
    let gn = 1;
    while (gx + gn < n && p.cols[gx + gn].group === p.cols[gx].group) gn++;
    const x = HC + gx * CW;
    o.push(`<rect x="${x}" y="${TITLE}" width="${gn * CW}" height="${GRP}" fill="${groupColor(p.cols[gx].group)}"/>`);
    o.push(`<text x="${x + 14}" y="${TITLE + 25}" font-size="18" font-weight="700" fill="#ffffff" letter-spacing="1.5">${xml(fit(`${p.cols[gx].group} TOIFA`.toUpperCase(), gn * CW - 24, 18, 0.62))}</text>`);
    if (gx) o.push(`<line x1="${x}" y1="${TITLE}" x2="${x}" y2="${TITLE + GRP}" stroke="#ffffff" stroke-opacity="0.5" stroke-width="2"/>`);
    gx += gn;
  }
  p.cols.forEach((c, i) => {
    const x = HC + i * CW, y = TITLE + GRP;
    o.push(`<rect x="${x}" y="${y}" width="${CW}" height="${HEAD}" fill="${c.color}"/>`);
    /* uzun ism — shrift kichrayadi (19 gacha), keyin «…» */
    const nm = c.name.toUpperCase(), ns = Math.max(19, Math.min(25, Math.floor((CW - 20) / (nm.length * 0.6))));
    o.push(`<text x="${x + CW / 2}" y="${y + 36}" font-size="${ns}" font-weight="700" fill="#05081a" text-anchor="middle">${xml(fit(nm, CW - 20, ns, 0.6))}</text>`);
    if (c.phone) o.push(`<text x="${x + CW / 2}" y="${y + 68}" font-size="22" font-weight="700" fill="#1a1f3d" text-anchor="middle">${xml(c.phone)}</text>`);
  });

  /* qatorlar: soat ustuni va bo'sh kataklar (ustun rangida och) */
  p.hours.forEach((h, r) => {
    const y = top + r * ROW, past = p.past.includes(h);
    o.push(`<rect x="0" y="${y}" width="${HC}" height="${ROW}" fill="${past ? '#ec9a9d' : '#e5484d'}"/>`);
    o.push(`<text x="${HC / 2}" y="${y + 47}" font-size="29" font-weight="700" fill="#ffffff" text-anchor="middle">${pad(h)}</text>`);
    p.cols.forEach((c, i) => o.push(`<rect x="${HC + i * CW}" y="${y}" width="${CW}" height="${ROW}" fill="${tint(c.color, past ? 0.06 : 0.13)}"/>`));
  });

  /* panjara */
  for (let r = 0; r <= p.hours.length; r++) o.push(`<line x1="${HC}" y1="${top + r * ROW}" x2="${W}" y2="${top + r * ROW}" stroke="#9ea7ba" stroke-width="1.2"/>`);
  for (let i = 0; i <= n; i++) o.push(`<line x1="${HC + i * CW}" y1="${TITLE + GRP}" x2="${HC + i * CW}" y2="${top + p.hours.length * ROW}" stroke="#6f7890" stroke-width="${i === 0 ? 2 : 1.5}"/>`);
  for (let r = 1; r < p.hours.length; r++) o.push(`<line x1="0" y1="${top + r * ROW}" x2="${HC}" y2="${top + r * ROW}" stroke="#ffffff" stroke-opacity="0.45" stroke-width="1.2"/>`);

  /* bloklar — panjara ustidan */
  p.blocks.forEach((b, bi) => {
    const k = KIND[b.kind], r0 = p.hours.indexOf(b.h0);
    if (r0 < 0) return;
    const x = HC + b.col * CW, y = top + r0 * ROW, h = (b.h1 - b.h0) * ROW, tall = b.h1 - b.h0 > 1;
    const dim = p.past.includes(b.h1 - 1);
    o.push(`<g${dim ? ' opacity="0.72"' : ''}>`);
    const bg = b.kind === 'bron' || b.kind === 'app' ? tint(p.cols[b.col].color, 0.9) : k.bg;
    o.push(`<rect x="${x + 1}" y="${y + 1}" width="${CW - 2}" height="${h - 2}" fill="${bg}"/>`);
    if (b.kind === 'off') {
      o.push(`<clipPath id="c${bi}"><rect x="${x}" y="${y}" width="${CW}" height="${h}"/></clipPath><g clip-path="url(#c${bi})">`);
      for (let lx = x - h; lx < x + CW; lx += 16) o.push(`<line x1="${lx}" y1="${y + h}" x2="${lx + h}" y2="${y}" stroke="#e2daf6" stroke-width="6"/>`);
      o.push('</g>');
    }
    o.push(`<rect x="${x}" y="${y}" width="8" height="${h}" fill="${k.bar}"/>`);
    const tx = x + 20, room = CW - 30 - (b.paid || b.live ? 34 : 0);
    const big = b.kind === 'bron' || b.kind === 'app' ? 30 : b.kind === 'band' ? 28 : 22;
    /* uzun raqam/yozuv — shrift kichrayadi (24 gacha), keyin «…» */
    const ms = Math.max(24, Math.min(big, Math.floor(room / (Math.max(1, b.main.length) * 0.53))));
    const lines: Array<[string, number, string]> = [[b.main, ms, k.fg]];
    if (b.sub) lines.push([b.sub, 19, k.sub]);
    if (tall && (b.kind === 'bron' || b.kind === 'app' || b.kind === 'band')) lines.push([`${pad(b.h0)}–${pad(b.h1)} · ${b.h1 - b.h0} soat`, 19, k.sub]);
    /* bir soatlik katakka ikki qator sig'adi */
    const shown = tall ? lines : lines.slice(0, 2);
    const block = shown.reduce((a, [, s], i) => a + s + (i ? 6 : 0), 0);
    let ty = y + Math.max(8, (Math.min(h, tall ? h : ROW) - block) / 2);
    shown.forEach(([t, s, fill]) => {
      ty += s;
      o.push(`<text x="${tx}" y="${ty - 3}" font-size="${s}" font-weight="700" fill="${fill}">${xml(fit(t, room, s, s >= 28 ? 0.53 : 0.5))}</text>`);
      ty += 6;
    });
    if (b.paid) {
      const cx = x + CW - 24, cy = y + 24;
      o.push(`<circle cx="${cx}" cy="${cy}" r="14" fill="#16a34a"/><path d="M${cx - 7} ${cy} l5 5 l9 -10" fill="none" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else if (b.live) {
      const cx = x + CW - 24, cy = y + 24;
      o.push(`<circle cx="${cx}" cy="${cy}" r="14" fill="#2563eb"/><path d="M${cx - 4} ${cy - 7} l10 7 l-10 7 z" fill="#ffffff"/>`);
    }
    o.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${CW - 1}" height="${h - 1}" fill="none" stroke="#7d869c" stroke-width="1.5"/>`);
    o.push('</g>');
  });

  /* toifa guruhlari orasida qalin chiziq — A, B, C ustunlari alohida ko'rinadi */
  for (let i = 1; i < n; i++) if (p.cols[i].group !== p.cols[i - 1].group) {
    o.push(`<rect x="${HC + i * CW - 3}" y="${TITLE}" width="6" height="${GRP + HEAD + p.hours.length * ROW}" fill="#05081a"/>`);
  }

  /* izoh */
  const fy = H - FOOT;
  o.push(`<rect x="0" y="${fy}" width="${W}" height="${FOOT}" fill="#eef0f6"/>`);
  o.push(`<line x1="0" y1="${fy}" x2="${W}" y2="${fy}" stroke="#6f7890" stroke-width="1.5"/>`);
  /* rang izohi (keng rasmda) */
  const legend: Array<[string, string, string]> = [['#ffffff', KIND.bron.bar, 'Excel bron'], ['#ffffff', KIND.app.bar, 'Mini App'], [KIND.band.bg, KIND.band.bar, 'band']];
  let lx = W - 22, legendW = 0;
  if (W >= 1000) {
    o.push(`<circle cx="${lx - 13}" cy="${fy + 29}" r="12" fill="#16a34a"/><path d="M${lx - 19} ${fy + 29} l4 4 l8 -9" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);
    o.push(`<text x="${lx - 32}" y="${fy + 36}" font-size="19" font-weight="700" fill="#2b3048" text-anchor="end">to‘langan</text>`);
    lx -= 32 + 9 * 10.5 + 26;
    for (const [bg, bar, t] of legend.reverse()) {
      const tw = t.length * 9.3;
      o.push(`<text x="${lx}" y="${fy + 36}" font-size="19" font-weight="700" fill="#2b3048" text-anchor="end">${xml(t)}</text>`);
      o.push(`<rect x="${lx - tw - 34}" y="${fy + 17}" width="26" height="24" fill="${bg}" stroke="#7d869c" stroke-width="1.2"/><rect x="${lx - tw - 34}" y="${fy + 17}" width="7" height="24" fill="${bar}"/>`);
      lx -= tw + 34 + 22;
    }
    legendW = W - lx;
  }
  o.push(`<text x="22" y="${fy + 37}" font-size="21" font-weight="700" fill="#2b3048">${xml(fit(p.footer, W - 44 - legendW, 21, 0.5))}</text>`);
  o.push('</svg>');
  return o.join('');
}

let fontFiles: string[] | null = null;
function fonts(): string[] {
  if (fontFiles) return fontFiles;
  const dir = new URL('../assets/fonts/', import.meta.url);
  fontFiles = ['Carlito-Regular.ttf', 'Carlito-Bold.ttf'].map((f) => fileURLToPath(new URL(f, dir)));
  for (const f of fontFiles) readFileSync(f);
  return fontFiles;
}

/** PNG’lar — ikki barobar o'lchamda (eng uzun tomoni ≤ 2560 px). Chizib bo'lmasa — []. */
export async function renderSheetPngs(parts: SheetPart[]): Promise<Uint8Array[]> {
  if (!parts.length) return [];
  try {
    const mod: any = await import('@resvg/resvg-js');
    const Resvg = mod.Resvg || mod.default?.Resvg;
    if (!Resvg) return [];
    return parts.map((p) => {
      const svg = sheetPartSvg(p);
      const w = Number(/width="(\d+)"/.exec(svg)?.[1] || 1000), h = Number(/height="(\d+)"/.exec(svg)?.[1] || 1000);
      const scale = Math.min(2, 2560 / Math.max(w, h));
      const r = new Resvg(svg, {
        font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: 'Carlito' },
        fitTo: { mode: 'width', value: Math.round(w * scale) },
      });
      return r.render().asPng() as Uint8Array;
    });
  } catch (e) {
    console.warn('sheet image render failed:', e instanceof Error ? e.message : e);
    return [];
  }
}
