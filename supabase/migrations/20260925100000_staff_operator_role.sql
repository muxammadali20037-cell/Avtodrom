-- =====================================================================
-- OPERATOR ROLI
--
-- Xodimlar endi uch xil: admin (hammasi), cashier (faqat o'z kassasi),
-- operator (bronlar, qo'lda bron, bekor so'rovlari, mijozlar chati).
-- staff.role ustunida eski CHECK cheklovi bo'lsa (faqat admin/cashier),
-- operator yozilmaydi — shu skript uni yangilaydi.
--
-- Bir necha marta ishga tushirish xavfsiz.
-- =====================================================================

do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.staff'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.staff drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.staff
  add constraint staff_role_check check (role in ('admin', 'cashier', 'operator'));

-- Operator va admin kassaga biriktirilmaydi
update public.staff set register_id = null where role in ('admin', 'operator') and register_id is not null;
