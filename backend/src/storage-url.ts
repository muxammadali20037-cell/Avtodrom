/**
 * Rasm manzili bizning Supabase Storage'imizning ochiq manzilimi.
 * Ilgari faqat *.supabase.co qabul qilinardi — loyiha o'z domeniga
 * (custom domain) ulangan bo'lsa, instruktor rasmi saqlanmay qolardi.
 */
export function isStoragePublicUrl(u: string): boolean {
  const url = String(u || '').trim();
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (base && url.startsWith(`${base}/storage/v1/object/public/`)) return true;
  return /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\//i.test(url);
}
