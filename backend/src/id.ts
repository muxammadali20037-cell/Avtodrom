import { requireAdmin, rest, supabaseConfig, BUCKET } from './_auth.js';

/**
 * DELETE /api/admin/media/:id — media yozuvini va storage'dagi faylni o'chiradi.
 *
 * Eslatma: bu fayl `api/admin/media/sign.ts` va `commit.ts` bilan to'qnashmaydi,
 * chunki Vercel'da aniq nomli fayl dinamik `[id]` dan ustun turadi.
 * Ustun nomi `path` (bazadan tasdiqlangan), `storage_path` EMAS.
 */
export default async function handler(request: any, response: any) {
  const json = (code: number, body: unknown) => {
    response.statusCode = code;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  };

  try {
    requireAdmin(request);

    if (request.method !== 'DELETE') {
      response.setHeader('Allow', 'DELETE');
      return json(405, { ok: false, error: 'Method not allowed' });
    }

    const id = String(request.query?.id || '').trim();
    if (!id) return json(400, { ok: false, error: 'Media ID topilmadi' });

    const rows = await rest('admin_media', { query: `?id=eq.${encodeURIComponent(id)}&select=id,path` });
    const media = Array.isArray(rows) ? rows[0] : null;
    if (!media) return json(404, { ok: false, error: 'Media topilmadi' });

    await rest('admin_media', { method: 'DELETE', query: `?id=eq.${encodeURIComponent(id)}` });

    if (media.path) {
      const { url, key } = supabaseConfig();
      await fetch(`${url}/storage/v1/object/${BUCKET}/${media.path}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      }).catch(() => { /* yozuv o'chdi; storage fayli qolsa ham oqim to'xtamaydi */ });
    }

    return json(200, { ok: true, deleted: id });
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'Unauthorized';
    return json(unauthorized ? 401 : 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Media delete failed',
    });
  }
}
