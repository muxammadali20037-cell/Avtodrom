import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';

/**
 * MEDIA — rasm va video yuklash
 *
 * Ilgari bu to'rtta endpoint `api/admin/media/*` da Fastify'dan
 * TASHQARIDA yashardi: o'z auth'i, o'z xato formati, o'z Supabase
 * chaqiruvi bilan. Natijada backendda qilingan tuzatishlar
 * (masalan rol tekshiruvi) ularga tegmasdi.
 *
 * Endi hammasi shu yerda va umumiy `guardAdmin` bilan himoyalangan.
 * Xatti-harakat bir xil qoldirilgan — yuklash oqimi buzilmasin.
 */

const BUCKET = 'customer-media';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const ALL_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES];

const TARGET_FILE_SIZE = 200 * 1024 * 1024;   // bucket uchun so'raladigan chegara
const FALLBACK_FILE_SIZE = 50 * 1024 * 1024;  // bucket javob bermasa

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) throw new Error('Supabase sozlamalari yo‘q');
  return { url, key };
}

function cleanName(name: unknown) {
  return String(name || 'media')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'media';
}

function ext(name: string, type: string) {
  const found = String(name).toLowerCase().match(/\.[a-z0-9]{2,6}$/)?.[0];
  if (found) return found;
  return ({
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  } as Record<string, string>)[type] || '';
}

const textSafe = (r: Response) => r.text().catch(() => '');

/**
 * Bucket bor-yo'qligini tekshiradi, bo'lmasa yaratadi va hajm
 * chegarasini ko'taradi. Qaytaradigan qiymat — haqiqiy chegara.
 */
async function ensureBucket(url: string, serviceKey: string): Promise<number> {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  const check = await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(BUCKET)}`, { method: 'GET', headers });
  const checkText = await textSafe(check);

  if (!check.ok) {
    const missing = check.status === 404
      || (check.status === 400 && /NoSuchBucket|Bucket not found|not found/i.test(checkText));
    if (!missing) throw new Error(`Storage bucket tekshiruvi ${check.status}: ${checkText || 'xato'}`);

    const create = await fetch(`${url}/storage/v1/bucket`, {
      method: 'POST', headers,
      body: JSON.stringify({
        id: BUCKET, name: BUCKET, public: true,
        file_size_limit: TARGET_FILE_SIZE, allowed_mime_types: ALL_TYPES,
      }),
    });
    const createText = await textSafe(create);
    const alreadyThere = create.status === 409
      || (create.status === 400 && /already exists|Duplicate|exists/i.test(createText));
    if (!create.ok && !alreadyThere) {
      throw new Error(`Storage bucket yaratilmadi (${create.status}): ${createText || 'xato'}`);
    }
  } else {
    // Mavjud bucket chegarasi kichik bo'lsa ko'taramiz
    let current: any = {};
    try { current = checkText ? JSON.parse(checkText) : {}; } catch { current = {}; }
    const currentLimit = Number(current?.file_size_limit || 0);
    if (currentLimit > 0 && currentLimit < TARGET_FILE_SIZE) {
      await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(BUCKET)}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ public: true, file_size_limit: TARGET_FILE_SIZE, allowed_mime_types: ALL_TYPES }),
      }).catch(() => {});
    }
  }

  const finalCheck = await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(BUCKET)}`, { method: 'GET', headers });
  const finalText = await textSafe(finalCheck);
  let finalData: any = {};
  try { finalData = finalText ? JSON.parse(finalText) : {}; } catch { finalData = {}; }
  const actual = Number(finalData?.file_size_limit || 0);
  return actual > 0 ? actual : FALLBACK_FILE_SIZE;
}

/**
 * Media kaliti. Uchta slot bitta elementga ega (home, location, guide),
 * galereya esa ko'p elementli — shuning uchun unga noyob kalit beriladi
 * (`admin_media.key` UNIQUE).
 */
function mediaKeyFor(slot: string, mediaType: string) {
  if (slot === 'gallery') return `gallery_${Date.now()}_${randomUUID().slice(0, 8)}`;
  if (mediaType === 'video') return 'guide_video';
  if (slot === 'location') return 'location_image';
  return 'home_image';
}

export function registerMediaRoutes(
  app: FastifyInstance,
  guardAdmin: (req: any) => Promise<void>,
) {
  /* ---------------- Ro'yxat ---------------- */
  app.get('/api/admin/media', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const media = await supabaseRest<any[]>('admin_media', {
        query: '?select=*&order=sort_order.asc,created_at.desc',
      });
      return { ok: true, media };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Media yuklanmadi' });
    }
  });

  /* ---------------- Imzolangan yuklash manzili ---------------- */
  app.post('/api/admin/media/sign', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const b = (req.body || {}) as any;

      const title = String(b.title || '').trim();
      const mediaType = String(b.media_type || 'video').trim();
      const fileName = cleanName(b.file_name || b.filename || 'media');
      const contentType = String(b.content_type || b.contentType || '').toLowerCase();

      if (!title) return reply.code(400).send({ ok: false, error: 'Media nomi majburiy' });
      if (!['video', 'image'].includes(mediaType)) {
        return reply.code(400).send({ ok: false, error: 'Media turi noto‘g‘ri' });
      }
      const allowed = mediaType === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
      if (!allowed.has(contentType)) {
        return reply.code(400).send({ ok: false, error: 'Bu fayl turi qo‘llab-quvvatlanmaydi' });
      }

      const slot = String(b.slot || 'home').trim();
      const mediaKey = mediaKeyFor(slot, mediaType);
      const folder = slot === 'gallery' ? 'gallery' : mediaKey;
      const baseName = fileName.replace(/\.[a-z0-9]{2,6}$/i, '');
      const path = `${folder}/${Date.now()}-${randomUUID()}-${baseName}${ext(fileName, contentType)}`;

      const { url, key: serviceKey } = supabaseConfig();
      const maxFileSize = await ensureBucket(url, serviceKey);

      const signResponse = await fetch(`${url}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: {
          apikey: serviceKey, Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json', 'x-upsert': 'true',
        },
        body: JSON.stringify({ expiresIn: 3600, upsert: true, contentType }),
      });
      const signText = await textSafe(signResponse);
      let data: any = {};
      try { data = signText ? JSON.parse(signText) : {}; } catch { data = {}; }
      if (!signResponse.ok) {
        return reply.code(502).send({ ok: false, error: `Storage sign ${signResponse.status}: ${signText.slice(0, 200)}` });
      }

      /* Token `data.token` da yoki `data.url` ichidagi query'da keladi —
         Supabase versiyasiga qarab. URL shakliga TAYANMAYMIZ: tokenni
         ajratib olib, manzilni o'zimiz quramiz. Aks holda prefikssiz
         URL hosil bo'lib, brauzer 404 ni CORS xatosi deb ko'rsatardi. */
      let token = String(data.token || '');
      if (!token) {
        const raw = String(data.url || data.signedUrl || data.signedURL || '');
        const qs = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
        token = new URLSearchParams(qs).get('token') || '';
      }
      if (!token) {
        return reply.code(502).send({ ok: false, error: `Storage token qaytmadi: ${signText.slice(0, 200)}` });
      }

      const absolute = `${url}/storage/v1/object/upload/sign/${BUCKET}/${path}`;
      return {
        ok: true,
        bucket: BUCKET, path, storage_path: path, token,
        key: mediaKey, slot,
        upload_url: `${absolute}?token=${encodeURIComponent(token)}`,
        signed_url: absolute,
        public_url: `${url}/storage/v1/object/public/${BUCKET}/${path}`,
        max_file_size: maxFileSize,
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Imzo olinmadi' });
    }
  });

  /* ---------------- Yuklangandan keyin yozib qo'yish ---------------- */
  app.post('/api/admin/media/commit', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const b = (req.body || {}) as any;

      const mediaType = String(b.media_type || 'video').trim();
      const title = String(b.title || '').trim();
      let path = String(b.path || b.storage_path || '').trim();
      const publicUrl = String(b.public_url || '').trim();

      if (!title) return reply.code(400).send({ ok: false, error: 'Media nomi majburiy' });
      if (!['video', 'image'].includes(mediaType)) {
        return reply.code(400).send({ ok: false, error: 'Media turi noto‘g‘ri' });
      }
      if (!path || !publicUrl) {
        return reply.code(400).send({ ok: false, error: 'Media fayl ma’lumotlari to‘liq emas' });
      }
      if (path.startsWith(`${BUCKET}/`)) path = path.slice(BUCKET.length + 1);

      const slot = String(b.slot || 'home').trim();
      const isGallery = slot === 'gallery';
      const key = isGallery
        ? String(b.key || '').trim()
        : (mediaType === 'video' ? 'guide_video' : (slot === 'location' ? 'location_image' : 'home_image'));

      if (isGallery && !/^gallery_[0-9]+_[a-z0-9]{4,}$/i.test(key)) {
        return reply.code(400).send({ ok: false, error: 'Galereya kaliti noto‘g‘ri' });
      }

      /* Yo'l va URL tekshiruvi — mijoz ixtiyoriy manzil yuborib,
         boshqa bucket'dagi faylni bazaga yozib qo'ymasin. */
      const folder = isGallery ? 'gallery' : key;
      if (!path.startsWith(`${folder}/`)) {
        return reply.code(400).send({ ok: false, error: 'Media path noto‘g‘ri' });
      }
      const { url } = supabaseConfig();
      const prefix = `${url}/storage/v1/object/public/${BUCKET}/`;
      if (!publicUrl.startsWith(prefix)) {
        return reply.code(400).send({ ok: false, error: 'Media URL noto‘g‘ri' });
      }

      let media: any = null;
      let previous: string | null = null;

      if (isGallery) {
        const created = await supabaseRest<any[]>('admin_media', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            key, title, media_type: mediaType, path, public_url: publicUrl,
            is_active: true, sort_order: Date.now() % 100000,
          }),
        });
        media = created?.[0] ?? null;
      } else {
        const old = await supabaseRest<any[]>('admin_media', {
          query: `?key=eq.${encodeURIComponent(key)}&select=id,path`,
        });
        const patched = await supabaseRest<any[]>('admin_media', {
          method: 'PATCH', headers: { Prefer: 'return=representation' },
          query: `?key=eq.${encodeURIComponent(key)}`,
          body: JSON.stringify({
            title, media_type: mediaType, path, public_url: publicUrl,
            is_active: true, updated_at: new Date().toISOString(),
          }),
        });
        media = patched?.[0] ?? null;
        if (!media) {
          const created = await supabaseRest<any[]>('admin_media', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ key, title, media_type: mediaType, path, public_url: publicUrl, is_active: true }),
          });
          media = created?.[0] ?? null;
        }
        previous = old?.[0]?.path ?? null;
      }

      // Eski faylni o'chiramiz — storage keraksiz to'lib ketmasin
      if (previous && previous !== path) {
        const { key: serviceKey } = supabaseConfig();
        await fetch(`${url}/storage/v1/object/${BUCKET}/${previous}`, {
          method: 'DELETE',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        }).catch(() => {});
      }

      return { ok: true, media };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Media saqlanmadi' });
    }
  });

  /* ---------------- O'chirish ---------------- */
  app.delete('/api/admin/media/:id', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const id = String(req.params.id);
      const rows = await supabaseRest<any[]>('admin_media', {
        query: `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
      });
      const media = rows?.[0];
      if (!media) return reply.code(404).send({ ok: false, error: 'Media topilmadi' });

      await supabaseRest('admin_media', { method: 'DELETE', query: `?id=eq.${encodeURIComponent(id)}` });

      if (media.path) {
        const { url, key: serviceKey } = supabaseConfig();
        await fetch(`${url}/storage/v1/object/${BUCKET}/${media.path}`, {
          method: 'DELETE',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        }).catch(() => {});
      }
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Media o‘chirilmadi' });
    }
  });
}
