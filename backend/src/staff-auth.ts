import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from './supabase.js';
import { q } from './identity.js';

/**
 * XODIM HISOBLARI VA ROLLAR
 *
 * Ilgari bitta ADMIN_LOGIN/ADMIN_PASSWORD juftligi bor edi va kassir
 * to'liq admin huquqiga ega bo'lardi. Endi har bir xodim o'z hisobi
 * bilan kiradi va roli chegaralaydi.
 *
 * ORQAGA MOSLIK: xodim jadvali bo'sh bo'lsa yoki login topilmasa,
 * eski ADMIN_LOGIN/ADMIN_PASSWORD ishlashda davom etadi. Bu ataylab —
 * xodimlarni qo'shishdan oldin paneldan qulflanib qolmaslik uchun,
 * va parol unutilganda zaxira yo'l sifatida.
 */

export type StaffRole = 'admin' | 'cashier';

export interface StaffIdentity {
  id: string | null;          // null — eski env admin
  login: string;
  role: StaffRole;
  register_id: string | null;
  full_name: string | null;
  legacy: boolean;            // env orqali kirganmi
}

/* ---------------- Parol ---------------- */

/**
 * scrypt bilan xeshlash. Format: `scrypt$<salt-hex>$<hash-hex>`
 *
 * Nima uchun scrypt: bcrypt kabi sekin va xotira talab qiladi, lekin
 * Node ichida — qo'shimcha paket kerak emas. SHA-256 kabi tez
 * algoritmlar parol uchun yaramaydi (GPU'da soniyada milliardlab
 * urinish qilinadi).
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(String(plain), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(String(plain), Buffer.from(saltHex, 'hex'), expected.length);
    // Uzunlik mos kelmasa timingSafeEqual xato tashlaydi
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------------- Kirish ---------------- */

const envAdmin = () => ({
  login: String(process.env.ADMIN_LOGIN || '').trim(),
  password: String(process.env.ADMIN_PASSWORD || ''),
});

/** Xodim jadvalidan qidiradi. Jadval yo'q bo'lsa null (xato emas). */
async function findStaff(login: string): Promise<any | null> {
  try {
    const rows = await supabaseRest<any[]>('staff', {
      query: `?login=ilike.${q(login)}&is_active=eq.true&select=*&limit=1`,
    });
    return rows[0] ?? null;
  } catch (e) {
    // Jadval hali yaratilmagan bo'lishi mumkin — eski usulga tushamiz
    console.warn('staff jadvali o‘qilmadi, env admin ishlatiladi:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Login va parolni tekshiradi.
 * Muvaffaqiyatli bo'lsa kimligini qaytaradi, aks holda null.
 */
export async function authenticateStaff(login: string, password: string): Promise<StaffIdentity | null> {
  const l = String(login || '').trim();
  const p = String(password || '');
  if (!l || !p) return null;

  // 1) Xodim jadvali
  const staff = await findStaff(l);
  if (staff) {
    if (!verifyPassword(p, String(staff.password_hash))) return null;
    // Oxirgi kirish vaqti — xato bo'lsa ham kirishni to'xtatmaymiz
    supabaseRest('staff', {
      method: 'PATCH', query: `?id=eq.${q(String(staff.id))}`,
      body: JSON.stringify({ last_login_at: new Date().toISOString() }),
    }).catch(() => {});
    return {
      id: String(staff.id),
      login: String(staff.login),
      role: (staff.role === 'admin' ? 'admin' : 'cashier') as StaffRole,
      register_id: staff.register_id ? String(staff.register_id) : null,
      full_name: staff.full_name ?? null,
      legacy: false,
    };
  }

  // 2) Eski env admin — zaxira yo'l
  const env = envAdmin();
  if (env.login && env.password && l.toLowerCase() === env.login.toLowerCase()) {
    const a = Buffer.from(p);
    const b = Buffer.from(env.password);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { id: null, login: env.login, role: 'admin', register_id: null, full_name: 'Administrator', legacy: true };
    }
  }

  return null;
}

/* ---------------- Rol tekshiruvi ---------------- */

export class ForbiddenError extends Error {
  statusCode = 403;
  constructor(message = 'Bu amal uchun ruxsat yo‘q') {
    super(message);
  }
}

/**
 * Rolni tekshiradi. Admin hamma narsaga kira oladi; kassir faqat
 * o'ziga ruxsat berilganiga.
 */
export function assertRole(identity: StaffIdentity | null, required: StaffRole) {
  if (!identity) {
    const e: any = new Error('Kirish talab qilinadi');
    e.statusCode = 401;
    throw e;
  }
  if (required === 'admin' && identity.role !== 'admin') {
    throw new ForbiddenError('Bu bo‘lim faqat administrator uchun');
  }
}

/**
 * Kassir faqat O'Z kassasi bilan ishlay oladi.
 * Admin har qanday kassaga kira oladi.
 */
export function assertRegister(identity: StaffIdentity | null, registerId: string) {
  if (!identity) {
    const e: any = new Error('Kirish talab qilinadi');
    e.statusCode = 401;
    throw e;
  }
  if (identity.role === 'admin') return;
  if (!identity.register_id || String(identity.register_id) !== String(registerId)) {
    throw new ForbiddenError('Bu kassaga ruxsatingiz yo‘q');
  }
}
