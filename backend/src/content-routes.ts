/**
 * AVTODROM — ochiq kontent (mijoz Mini App uchun media).
 *
 * DIQQAT: Vercel'da `/api/content` ni `api/content.ts` static funksiyasi
 * xizmat qiladi (u fayl-tizim ustuvorligi bo'yicha yutadi). Bu route
 * faqat Render/lokal Fastify uchun zaxira sifatida qoladi.
 *
 * Bu fayldan olib tashlangan (2026-08-29 audit):
 *   - /api/results                      → mock ma'lumot, hech kim chaqirmasdi
 *   - /api/admin/content*               → chaqiruvchisi yo'q (frontend/admin/media.html o'chirildi)
 *   - /api/admin/media{,/sign,/commit}  → api/admin/media/*.ts dublikati;
 *                                          bu versiya `storage_path` ustuniga yozardi,
 *                                          bazada esa ustun nomi `path`.
 */
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';

const BUCKET = 'customer-media';

/** admin_media.path — bazadagi haqiqiy ustun nomi (`storage_path` EMAS). */
function publicUrl(path: string) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return `${url}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function activeMedia() {
  try {
    const rows = await supabaseRest<any[]>('admin_media', {
      query:
        '?is_active=eq.true' +
        '&select=id,key,title,media_type,path,public_url,sort_order,created_at' +
        '&order=sort_order.asc,created_at.desc',
    });
    return rows.map((x) => ({
      ...x,
      id: String(x.id),
      active: true,
      public_url: x.public_url || publicUrl(x.path || ''),
    }));
  } catch (e) {
    console.error('admin_media read failed:', e);
    return [];
  }
}

export async function registerContentRoutes(app: FastifyInstance) {
  app.get('/api/content', async () => ({ ok: true, media: await activeMedia() }));
}
