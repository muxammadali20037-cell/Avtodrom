/**
 * AVTODROM — kanonik identifikatsiya qatlami.
 *
 * Bazada YAGONA haqiqat manbai:
 *   users               (id, telegram_id, full_name, phone, role, is_active, is_blocked)
 *   instructor_profiles (id, user_id -> users.id, is_verified, is_available, ...)
 *
 * `profiles` va `instructors` — faqat O'QISH uchun view'lar (INSTEAD OF trigger yo'q),
 * shuning uchun ularga hech qachon INSERT/PATCH qilinmaydi.
 *
 * Frontend `first_name` / `last_name` kutadi, bazada esa `full_name` bor —
 * konversiya shu yerda, bitta joyda bajariladi.
 */
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

export function q(value: string) { return encodeURIComponent(value); }

export function splitName(fullName?: string | null) {
  const s = String(fullName ?? '').trim();
  if (!s) return { first_name: '', last_name: '' };
  const i = s.indexOf(' ');
  if (i < 0) return { first_name: s, last_name: '' };
  return { first_name: s.slice(0, i), last_name: s.slice(i + 1).trim() };
}

export function joinName(first?: string | null, last?: string | null) {
  return [String(first ?? '').trim(), String(last ?? '').trim()].filter(Boolean).join(' ');
}

/** users satrini frontend kutadigan shaklga o'giradi. */
export function toProfile(user: any, extra: { username?: string | null } = {}) {
  if (!user) return null;
  const { first_name, last_name } = splitName(user.full_name);
  return {
    id: user.id,
    telegram_id: user.telegram_id ?? null,
    first_name,
    last_name,
    full_name: user.full_name ?? '',
    phone: user.phone ?? null,
    username: extra.username ?? null,
    role: user.role ?? 'customer',
    active: user.is_active !== false && user.is_blocked !== true,
    is_active: user.is_active !== false,
    is_blocked: user.is_blocked === true,
  };
}

/** Telegram registri — bot uchun username/til saqlanadi. Xato bo'lsa oqim to'xtamaydi. */
export async function rememberTelegramUser(u: TelegramWebAppUser, role: string) {
  try {
    await supabaseRest('telegram_users', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        telegram_id: u.id,
        first_name: u.first_name ?? null,
        last_name: u.last_name ?? null,
        username: (u as any).username ?? null,
        language_code: (u as any).language_code ?? null,
        role,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error('telegram_users upsert skipped:', e);
  }
}

export async function findUserByTelegram(telegramId: number | string) {
  const rows = await supabaseRest<any[]>('users', {
    query: `?telegram_id=eq.${q(String(telegramId))}&select=*&limit=1`,
  });
  return rows[0] ?? null;
}

/**
 * Telegram foydalanuvchisi uchun `users` yozuvini topadi, bo'lmasa yaratadi.
 * MUHIM: eski kod `profiles` view'iga INSERT qilardi — u yozib bo'lmaydigan view,
 * shuning uchun har bir yangi mijoz shu yerda yiqilardi.
 */
export async function userForTelegram(
  u: TelegramWebAppUser,
  options: { create?: boolean; role?: 'customer' | 'instructor' } = {},
) {
  const { create = true, role = 'customer' } = options;

  const existing = await findUserByTelegram(u.id);
  if (existing) { void rememberTelegramUser(u, existing.role ?? role); return existing; }
  if (!create) return null;

  // full_name NOT NULL — hech qachon bo'sh qoldirmaymiz.
  const fullName =
    joinName(u.first_name, u.last_name) ||
    String((u as any).username ?? '').trim() ||
    `Telegram ${u.id}`;

  try {
    const created = await supabaseRest<any[]>('users', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ telegram_id: u.id, full_name: fullName, role }),
    });
    if (created[0]) { void rememberTelegramUser(u, role); return created[0]; }
  } catch (error) {
    // Parallel so'rovlar bir vaqtda yaratmoqchi bo'lsa — qayta o'qiymiz.
    const retry = await findUserByTelegram(u.id);
    if (retry) return retry;
    throw error;
  }

  const retry = await findUserByTelegram(u.id);
  if (retry) return retry;
  throw new Error('Foydalanuvchi yaratilmadi');
}

/** user_id bo'yicha instruktor profili. approvedOnly=true bo'lsa faqat tasdiqlangan+faol. */
export async function instructorProfileForUser(userId: string, approvedOnly = true) {
  const filters = [`user_id=eq.${q(String(userId))}`, 'select=*', 'limit=1'];
  if (approvedOnly) filters.push('is_verified=eq.true', 'is_available=eq.true');
  const rows = await supabaseRest<any[]>('instructor_profiles', { query: `?${filters.join('&')}` });
  return rows[0] ?? null;
}

/**
 * Bildirishnoma yozadi.
 * Bazadagi ustunlar: user_id, type, title, message (hammasi NOT NULL, `type` ham).
 * Eski kod profile_id/body/channel/booking_id yozardi — bunday ustunlar yo'q.
 */
export async function notifyUser(
  userId: string | null | undefined,
  type: string,
  title: string,
  message: string,
) {
  if (!userId) return;
  try {
    await supabaseRest('notifications', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, type, title, message }),
    });
  } catch (e) {
    console.error('notification insert failed:', e);
  }
}

/** instructor_profiles + embed qilingan user'ni frontend shakliga o'giradi. */
export function toInstructorCard(row: any) {
  const user = row?.user ?? row?.users ?? null;
  const { first_name, last_name } = splitName(user?.full_name);
  return {
    id: row.id,
    user_id: row.user_id,
    profile_id: row.user_id,
    telegram_id: user?.telegram_id ?? null,
    first_name,
    last_name,
    full_name: user?.full_name ?? '',
    phone: user?.phone ?? null,
    bio: row.bio ?? null,
    avatar_url: row.avatar_url ?? null,
    experience_years: row.experience_years ?? 0,
    rating: row.rating ?? 0,
    total_reviews: row.total_reviews ?? 0,
    approved: row.is_verified === true,
    is_verified: row.is_verified === true,
    active: row.is_available === true && user?.is_active !== false && user?.is_blocked !== true,
    is_available: row.is_available === true,
    profile: { id: user?.id ?? null, first_name, last_name, phone: user?.phone ?? null },
  };
}
