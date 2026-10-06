/**
 * VERCEL MARSHRUTLARI — har bir backend endpointi production'da yetib boradimi.
 *
 * Vercel'da `api/admin/[...path].ts` va `api/[...path].ts` catch-all faqat
 * BIR bo'g'inli manzillarni tutadi (`/api/admin/retention`). Ichma-ich manzil
 * (`/api/admin/instructors/<id>/work-schedule`) uchun alohida fayl kerak:
 *     api/admin/instructors/[id]/work-schedule.ts →  export { default } from '../../../_forward.js';
 * Fayl bo'lmasa Vercel 404 qaytaradi ({"error":{"code":"NOT_FOUND"}}) va
 * panelda «[object Object]» chiqadi. Bu test yangi endpoint qo'shilganda
 * faylini unutishga yo'l qo'ymaydi.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'backend/src');

/** app.ts ro'yxatdan o'tkazgan modullar (ulanmagan eski fayllar hisobga olinmaydi). */
function registeredModules(): string[] {
  const app = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8');
  const mods = [...app.matchAll(/from '\.\/([\w-]+)\.js'/g)].map((m) => `${m[1]}.ts`);
  return ['app.ts', ...mods].filter((f) => fs.existsSync(path.join(SRC, f)));
}

function routes(): { method: string; path: string; file: string }[] {
  const out: { method: string; path: string; file: string }[] = [];
  for (const f of registeredModules()) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']+)'/g)) {
      out.push({ method: m[1].toUpperCase(), path: m[2], file: f });
    }
  }
  return out;
}

function apiFiles(): string[][] {
  const out: string[][] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(e.name) && !e.name.startsWith('_')) {
        const segs = path.relative(ROOT, p).replace(/\.(ts|mjs)$/, '').split(path.sep);
        if (segs[segs.length - 1] === 'index') segs.pop();
        out.push(segs);
      }
    }
  };
  walk(path.join(ROOT, 'api'));
  return out;
}

function reachable(route: string, files: string[][]): boolean {
  const rs = route.split('/').filter(Boolean);
  const exact = files.some((fs_) => fs_.length === rs.length && fs_.every((a, i) =>
    !a.startsWith('[...') && (a.startsWith('[') || a === rs[i])));
  if (exact) return true;
  /* bir bo'g'inli: /api/x → api/[...path].ts, /api/admin/x → api/admin/[...path].ts */
  if (rs.length === 2) return files.some((f) => f.join('/') === 'api/[...path]');
  if (rs.length === 3 && rs[1] === 'admin') return files.some((f) => f.join('/') === 'api/admin/[...path]');
  return false;
}

describe('Vercel: har bir endpointning marshrut fayli bor', () => {
  it('ichma-ich manzillar alohida faylsiz qolmagan', () => {
    const files = apiFiles();
    const missing = routes().filter((r) => !reachable(r.path, files)).map((r) => `${r.method} ${r.path} (${r.file})`);
    expect(missing).toEqual([]);
  });

  it('yangi grafik va admin bot endpointlari qamrab olingan', () => {
    const files = apiFiles();
    for (const p of ['/api/admin/instructors/abc/work-schedule', '/api/admin/instructors/abc/blocks',
      '/api/admin/work-schedules', '/api/admin/retention', '/api/admin/telegram-admins/test', '/api/admin/telegram-admins/123']) {
      expect(reachable(p, files), p).toBe(true);
    }
  });
});
