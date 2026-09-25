-- =====================================================================
-- ESLATMALAR JADVALI — server kodi (backend/src/reminders.ts) kutgan shakl
--
-- Server har bir bron uchun 60 / 30 / 10 daqiqa qolganda mijozga
-- Telegram eslatma yuboradi va takrorlanmasligi uchun shu jadvalga
-- (booking_id, kind) yozadi. Jadval eski shaklda bo'lsa (reminder_minutes,
-- send_at NOT NULL) yozuv yiqilardi va eslatma umuman ketmasdi.
--
-- Bu skriptni bir necha marta ishga tushirish xavfsiz.
-- =====================================================================

create table if not exists public.booking_reminders (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  kind integer,
  telegram_ok boolean,
  created_at timestamptz not null default now()
);

alter table public.booking_reminders add column if not exists kind integer;
alter table public.booking_reminders add column if not exists telegram_ok boolean;
alter table public.booking_reminders add column if not exists created_at timestamptz not null default now();

-- Eski ustunlar bo'lsa — yangi yozuvlarga to'sqinlik qilmasin
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'booking_reminders'
               and column_name = 'reminder_minutes') then
    execute 'alter table public.booking_reminders alter column reminder_minutes drop not null';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'booking_reminders'
               and column_name = 'send_at') then
    execute 'alter table public.booking_reminders alter column send_at drop not null';
  end if;
end $$;

-- Eski trigger har bronga bo'sh yozuvlar qo'yardi — endi server o'zi yozadi
drop trigger if exists booking_reminder_trigger on public.bookings;

-- Takror xabardan himoya: (booking_id, kind) yagona
delete from public.booking_reminders a
 using public.booking_reminders b
 where a.kind is not null
   and a.booking_id = b.booking_id
   and a.kind = b.kind
   and a.ctid > b.ctid;

create unique index if not exists booking_reminders_booking_kind_key
  on public.booking_reminders (booking_id, kind);
create index if not exists booking_reminders_created_idx
  on public.booking_reminders (created_at desc);

alter table public.booking_reminders enable row level security;
