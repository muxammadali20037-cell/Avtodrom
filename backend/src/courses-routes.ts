import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { q } from './identity.js';
import type { TelegramWebAppUser } from './telegram.js';

/**
 * Mashg'ulotlar (courses) — narx/davomiylik hech qachon frontendga
 * hardcode qilinmasin degan talab shu yerda bajariladi.
 * Faqat is_active=true kurslar chiqadi; narxni faqat admin o'zgartiradi.
 */
export async function registerCourseRoutes(
  app: FastifyInstance,
  authenticate: (request: any) => Promise<TelegramWebAppUser>,
) {
  app.get('/api/courses', async (request, reply) => {
    try {
      await authenticate(request);
      const rows = await supabaseRest<any[]>('courses', {
        /* `category` shart: mijoz panelida instruktorlar shu kategoriya
           bo'yicha filtrlanadi. Busiz qaysi kategoriya tanlanganini
           bilib bo'lmaydi va hamma instruktor chiqib ketadi. */
        query: '?is_active=eq.true&select=id,name,description,duration_minutes,price,category&order=price.asc',
      });
      return { ok: true, courses: rows };
    } catch (e) {
      return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' });
    }
  });

  /**
   * Ochiq sozlamalar — faqat oq ro'yxatdagi kalitlar.
   * admin_settings ichida boshqa (maxfiy) kalitlar bo'lishi mumkin,
   * shuning uchun butun jadval qaytarilmaydi.
   */
  const PUBLIC_KEYS = ['system_name', 'contact_phone', 'address', 'working_hours', 'booking_enabled',
                       'location', 'work_start', 'work_end', 'slot_step_min',
                       'about_text', 'facilities'];

  app.get('/api/settings', async (_request, reply) => {
    try {
      const rows = await supabaseRest<any[]>('admin_settings', {
        query: `?key=in.(${PUBLIC_KEYS.map(q).join(',')})&select=key,value`,
      });
      const settings: Record<string, unknown> = {};
      for (const r of rows) {
        // value jsonb: {"value": "..."} yoki to'g'ridan-to'g'ri qiymat bo'lishi mumkin
        settings[r.key] = r.value?.value !== undefined ? r.value.value : r.value;
      }
      // Standart ish vaqti — sozlama kiritilmagan bo'lsa
      if (!settings.work_start) settings.work_start = '07:00';
      if (!settings.work_end) settings.work_end = '19:00';
      if (!settings.slot_step_min) settings.slot_step_min = 60;
      return { ok: true, settings };
    } catch (e) {
      // Sozlama bo'lmasa ham mijoz paneli ishlashi kerak
      return reply.code(200).send({ ok: true, settings: { work_start: '07:00', work_end: '19:00', slot_step_min: 60 } });
    }
  });
}
