import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * KIM QILDI — har bir so'rov uchun.
 *
 * app.ts dagi preHandler ilgagi so'rov boshida kim kirganini (xodim
 * cookie'si) shu yerga qo'yadi. Keyin:
 *   - audit() admin_audit_logs ga staff_id / staff_login ni yozadi
 *     (ilgari hamma yozuv umumiy «AVTODROM Administrator» nomidan edi);
 *   - supabaseRest har PATCH/DELETE ga `x-avt-actor` sarlavhasini qo'shadi —
 *     bazadagi tahrir jurnali (db_changes) tahrirni kim qilganini shundan oladi.
 * Sarlavhada faqat ASCII ID (ism emas): s:<staff id> | l:<login> | tg:<telegram id>.
 */
export type ActorStore = { staff_id: string | null; login: string | null; role: string | null; tg: string | null };

export const actorStore = new AsyncLocalStorage<ActorStore>();

export const currentActor = (): ActorStore | null => actorStore.getStore() || null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function actorTag(s: ActorStore | null = currentActor()): string | null {
  if (!s) return null;
  if (s.staff_id && UUID_RE.test(s.staff_id)) return `s:${s.staff_id}`;
  const login = String(s.login || '').replace(/[^A-Za-z0-9_.@-]/g, '').slice(0, 60);
  if (login) return `l:${login}`;
  const tg = String(s.tg || '').replace(/\D/g, '').slice(0, 20);
  if (tg) return `tg:${tg}`;
  return null;
}

/** Telegram orqali kirgan (mijoz / instruktor) — xodim bo'lmasa shu yoziladi. */
export function setTelegramActor(id: unknown) {
  const s = currentActor();
  const v = String(id ?? '').replace(/\D/g, '').slice(0, 20);
  if (s && !s.tg && v) s.tg = v;
}
