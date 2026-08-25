import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';

async function getContentSetting() {
  try {
    const rows = await supabaseRest<any[]>('admin_settings', { query: '?key=eq.customer_content&select=key,value,updated_at' });
    return rows[0]?.value || { media: [] };
  } catch {
    return { media: [] };
  }
}

async function saveContentSetting(value: any) {
  const body = JSON.stringify({ key: 'customer_content', value, updated_at: new Date().toISOString() });
  const patched = await supabaseRest<any[]>('admin_settings', {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, query: '?key=eq.customer_content', body,
  });
  if (patched[0]) return patched[0];
  const created = await supabaseRest<any[]>('admin_settings', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body,
  });
  return created[0];
}

export async function registerContentRoutes(app: FastifyInstance) {
  app.get('/api/content', async () => {
    const content = await getContentSetting();
    return { ok: true, media: Array.isArray(content.media) ? content.media : [], updated_at: content.updated_at || null };
  });

  app.get('/api/results', async () => {
    const safeCount = async (table: string, query: string) => {
      try { return (await supabaseRest<any[]>(table, { query })).length; } catch { return 0; }
    };
    const [customers, instructors, completedBookings] = await Promise.all([
      safeCount('profiles', '?role=eq.customer&select=id'),
      safeCount('instructors', '?active=eq.true&approved=eq.true&select=id'),
      safeCount('bookings', '?status=eq.completed&select=id'),
    ]);
    let averageRating = 0;
    try {
      const rows = await supabaseRest<any[]>('reviews', { query: '?status=eq.approved&select=rating' });
      const ratings = rows.map(x => Number(x.rating)).filter(Number.isFinite);
      if (ratings.length) averageRating = Number((ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(2));
    } catch {}
    return { ok: true, stats: { customers, instructors, completedBookings, averageRating } };
  });

  // This endpoint is intentionally metadata-only. Actual video bytes belong in Supabase Storage.
  // Admin UI can commit a Storage public URL here after a successful upload.
  app.post('/api/admin/content', async (request, reply) => {
    try {
      const cookie = String(request.headers?.cookie || '');
      if (!cookie.includes('avtodrom_admin_session=')) return reply.code(401).send({ok:false,error:'Unauthorized'});
      const body = (request.body || {}) as any;
      const current = await getContentSetting();
      const media = Array.isArray(current.media) ? current.media : [];
      const item = {
        id: String(body.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
        key: String(body.key || 'guide_video'),
        title: String(body.title || 'Video qo‘llanma').trim(),
        description: String(body.description || '').trim(),
        media_type: String(body.media_type || 'video'),
        public_url: String(body.public_url || '').trim(),
        active: body.active !== false,
        created_at: new Date().toISOString(),
      };
      if (!item.public_url) return reply.code(400).send({ok:false,error:'public_url required'});
      const filtered = media.filter((x:any)=>String(x.id)!==item.id && String(x.key)!==item.key);
      filtered.unshift(item);
      await saveContentSetting({media:filtered.slice(0,20),updated_at:new Date().toISOString()});
      return {ok:true,media:filtered};
    } catch (e:any) {
      return reply.code(500).send({ok:false,error:e?.message||'Content save failed'});
    }
  });

  app.delete('/api/admin/content/:id', async (request, reply) => {
    try {
      const cookie = String(request.headers?.cookie || '');
      if (!cookie.includes('avtodrom_admin_session=')) return reply.code(401).send({ok:false,error:'Unauthorized'});
      const id = String((request.params as any).id || '');
      const current = await getContentSetting();
      const media = (Array.isArray(current.media) ? current.media : []).filter((x:any)=>String(x.id)!==id);
      await saveContentSetting({media,updated_at:new Date().toISOString()});
      return {ok:true,media};
    } catch(e:any) {
      return reply.code(500).send({ok:false,error:e?.message||'Content delete failed'});
    }
  });
}
