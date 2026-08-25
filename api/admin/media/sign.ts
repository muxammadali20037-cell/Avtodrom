import { randomUUID } from 'node:crypto';
import { requireAdmin, supabaseConfig, BUCKET } from './_auth.js';

const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALL_TYPES = [...VIDEO_TYPES, ...IMAGE_TYPES];
const TARGET_FILE_SIZE = 150 * 1024 * 1024;
const FALLBACK_FILE_SIZE = 50 * 1024 * 1024;

function cleanName(name: string) {
  return String(name || 'media').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'media';
}

function ext(name: string, type: string) {
  const found = String(name).toLowerCase().match(/\.[a-z0-9]{2,6}$/)?.[0];
  if (found) return found;
  return ({
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  } as Record<string, string>)[type] || '';
}

async function readTextSafe(response: Response) {
  return await response.text().catch(() => '');
}

async function ensureBucket(url: string, serviceKey: string) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  const check = await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(BUCKET)}`, {
    method: 'GET',
    headers,
  });
  const checkText = await readTextSafe(check);

  if (!check.ok) {
    const missing = check.status === 404 || (check.status === 400 && /NoSuchBucket|Bucket not found|not found/i.test(checkText));
    if (!missing) throw new Error(`Storage bucket tekshiruvi ${check.status}: ${checkText || 'xato'}`);

    const create = await fetch(`${url}/storage/v1/bucket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: BUCKET,
        name: BUCKET,
        public: true,
        file_size_limit: TARGET_FILE_SIZE,
        allowed_mime_types: ALL_TYPES,
      }),
    });
    const createText = await readTextSafe(create);
    if (!create.ok && create.status !== 409 && !(create.status === 400 && /already exists|Duplicate|exists/i.test(createText))) {
      throw new Error(`Storage bucket yaratilmadi (${create.status}): ${createText || 'xato'}`);
    }
  } else {
    // The bucket may have been created earlier with Supabase's default 50 MB limit.
    // Raise it to 150 MB when the project-level Storage limit allows it.
    const current = (() => {
      try { return JSON.parse(checkText || '{}'); } catch { return {}; }
    })();
    const currentLimit = Number(current?.file_size_limit || 0);
    if (currentLimit > 0 && currentLimit < TARGET_FILE_SIZE) {
      const update = await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(BUCKET)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          public: true,
          file_size_limit: TARGET_FILE_SIZE,
          allowed_mime_types: ALL_TYPES,
        }),
      });
      const updateText = await readTextSafe(update);
      // Free Supabase projects can reject a bucket limit above the global 50 MB limit.
      // In that case keep the existing bucket limit and let the frontend show the real limit.
      if (!update.ok && !/maximum|limit|exceed|too large/i.test(updateText)) {
        throw new Error(`Storage bucket sozlamasi yangilanmadi (${update.status}): ${updateText || 'xato'}`);
      }
    }
  }

  const finalCheck = await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(BUCKET)}`, {
    method: 'GET',
    headers,
  });
  const finalText = await readTextSafe(finalCheck);
  let finalData: any = {};
  try { finalData = finalText ? JSON.parse(finalText) : {}; } catch { finalData = {}; }
  const actualLimit = Number(finalData?.file_size_limit || 0);
  return actualLimit > 0 ? actualLimit : FALLBACK_FILE_SIZE;
}

export default async function handler(request: any, response: any) {
  try {
    requireAdmin(request);

    if (request.method !== 'POST') {
      response.statusCode = 405;
      response.setHeader('Allow', 'POST');
      response.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }

    const body = request.body || {};
    const title = String(body.title || '').trim();
    const mediaType = String(body.media_type || 'video').trim();
    const fileName = cleanName(body.file_name || body.filename || 'media');
    const contentType = String(body.content_type || body.contentType || '').toLowerCase();

    if (!title) throw new Error('Media nomi majburiy');
    if (!['video', 'image'].includes(mediaType)) throw new Error('Media turi noto‘g‘ri');

    const allowed = mediaType === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
    if (!allowed.has(contentType)) throw new Error('Bu fayl turi qo‘llab-quvvatlanmaydi');

    const mediaKey = mediaType === 'video' ? 'guide_video' : 'home_image';
    const baseName = fileName.replace(/\.[a-z0-9]{2,6}$/i, '');
    const path = `${mediaKey}/${Date.now()}-${randomUUID()}-${baseName}${ext(fileName, contentType)}`;

    const { url, key: serviceKey } = supabaseConfig();
    const maxFileSize = await ensureBucket(url, serviceKey);

    const signUrl = `${url}/storage/v1/object/upload/sign/${BUCKET}/${path}`;
    const signResponse = await fetch(signUrl, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'x-upsert': 'true',
      },
      body: JSON.stringify({ expiresIn: 3600, upsert: true, contentType }),
    });

    const signText = await readTextSafe(signResponse);
    let data: any = {};
    try { data = signText ? JSON.parse(signText) : {}; } catch { data = {}; }

    if (!signResponse.ok) throw new Error(`Storage sign ${signResponse.status}: ${signText || JSON.stringify(data)}`);

    const absolute = String(data.url || '').startsWith('http') ? String(data.url) : `${url}${data.url || ''}`;
    const token = String(data.token || (absolute ? new URL(absolute).searchParams.get('token') : '') || '');
    if (!token) throw new Error('Storage token qaytmadi');

    const publicUrl = `${url}/storage/v1/object/public/${BUCKET}/${path}`;

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({
      ok: true,
      bucket: BUCKET,
      path,
      storage_path: path,
      token,
      upload_url: `${absolute}${absolute.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
      signed_url: absolute,
      public_url: publicUrl,
      max_file_size: maxFileSize,
    }));
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'Unauthorized';
    response.statusCode = unauthorized ? 401 : 400;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Media sign failed' }));
  }
}
