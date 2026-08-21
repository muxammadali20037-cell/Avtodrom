-- Real three-bot production layer: customer, instructor and admin workflows.
-- This migration is additive and keeps the existing autodrom session model intact.

alter table public.instructors
  add column if not exists approved boolean not null default false,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists bio text,
  add column if not exists category text,
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table public.bookings
  add column if not exists arrived_at timestamptz,
  add column if not exists departed_at timestamptz,
  add column if not exists assigned_by uuid references public.profiles(id) on delete set null,
  add column if not exists admin_note text,
  add column if not exists instructor_note text;

alter table public.instructor_reviews
  add column if not exists autodrom_rating integer check (autodrom_rating between 1 and 5),
  add column if not exists instructor_comment text,
  add column if not exists autodrom_comment text;

create table if not exists public.customer_reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid unique not null references public.bookings(id) on delete cascade,
  customer_id uuid not null references public.profiles(id) on delete cascade,
  instructor_id uuid references public.instructors(id) on delete set null,
  instructor_rating integer not null check (instructor_rating between 1 and 5),
  autodrom_rating integer not null check (autodrom_rating between 1 and 5),
  comment text,
  status text not null default 'visible' check (status in ('visible','hidden','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.media_content (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('image','video')),
  title text not null,
  storage_path text not null,
  public_url text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_faq (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  keywords text[] not null default '{}',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists instructors_approval_idx on public.instructors(approved, active);
create index if not exists bookings_attendance_idx on public.bookings(arrived_at, departed_at);
create index if not exists customer_reviews_instructor_idx on public.customer_reviews(instructor_id, status, created_at desc);
create index if not exists customer_reviews_customer_idx on public.customer_reviews(customer_id, created_at desc);
create index if not exists media_content_active_idx on public.media_content(active, sort_order);
create index if not exists ai_faq_active_idx on public.ai_faq(active, sort_order);

alter table public.customer_reviews enable row level security;
alter table public.media_content enable row level security;
alter table public.ai_faq enable row level security;

-- Server-side service-role access remains the authoritative write path.
-- These RPCs make attendance transitions atomic and prevent invalid state changes.
create or replace function public.instructor_mark_arrived(p_booking_id uuid, p_instructor_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare v_booking public.bookings;
begin
  select * into v_booking from public.bookings
  where id = p_booking_id and instructor_id = p_instructor_id
  for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status <> 'confirmed' then raise exception 'BOOKING_NOT_CONFIRMED'; end if;
  update public.bookings
     set status = 'in_progress', arrived_at = coalesce(arrived_at, now()), updated_at = now()
   where id = p_booking_id
   returning * into v_booking;
  return v_booking;
end;
$$;

create or replace function public.instructor_mark_departed(p_booking_id uuid, p_instructor_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare v_booking public.bookings;
begin
  select * into v_booking from public.bookings
  where id = p_booking_id and instructor_id = p_instructor_id
  for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status <> 'in_progress' then raise exception 'BOOKING_NOT_IN_PROGRESS'; end if;
  update public.bookings
     set status = 'completed', departed_at = coalesce(departed_at, now()), updated_at = now()
   where id = p_booking_id
   returning * into v_booking;
  insert into public.notifications(profile_id, booking_id, title, body, channel)
  values (v_booking.customer_id, v_booking.id, 'Dars tugadi', 'Darsingiz tugadi. Instruktor va Avtodromni baholang.', 'in_app');
  return v_booking;
end;
$$;

-- Admin approval is explicit; an instructor cannot become bookable by self-registration alone.
create or replace function public.admin_approve_instructor(p_instructor_id uuid, p_admin_id uuid)
returns public.instructors
language plpgsql
security definer
set search_path = public
as $$
declare v public.instructors;
begin
  if not exists(select 1 from public.profiles where id=p_admin_id and role='admin' and active=true) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  update public.instructors
     set approved=true, approved_at=now(), approved_by=p_admin_id, active=true
   where id=p_instructor_id
   returning * into v;
  if not found then raise exception 'INSTRUCTOR_NOT_FOUND'; end if;
  return v;
end;
$$;

-- Keep updated_at current for records edited by the three apps.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end $$;

drop trigger if exists customer_reviews_touch on public.customer_reviews;
create trigger customer_reviews_touch before update on public.customer_reviews for each row execute function public.touch_updated_at();
drop trigger if exists media_content_touch on public.media_content;
create trigger media_content_touch before update on public.media_content for each row execute function public.touch_updated_at();
drop trigger if exists ai_faq_touch on public.ai_faq;
create trigger ai_faq_touch before update on public.ai_faq for each row execute function public.touch_updated_at();

insert into public.ai_faq(question,answer,keywords,sort_order) values
('Qanday bron qilaman?','Bron qilish bo‘limiga kiring, instruktor, sana va vaqtni tanlang va bronni yuboring. Admin tasdiqlagandan keyin broningiz tasdiqlanadi.',array['bron','buyurtma','dars'],1),
('Bronim holatini qanday ko‘raman?','Bronlarim bo‘limida broningizning kutilmoqda, tasdiqlangan, jarayonda yoki tugagan holatini ko‘rasiz.',array['holat','bron','tasdiq'],2),
('Dars tugagach nima qilaman?','Instruktor KETDI tugmasini bosgach, sizga instruktor va Avtodromni 1–5 yulduz bilan baholash hamda sharh yozish imkoniyati yuboriladi.',array['baho','yulduz','sharh'],3)
on conflict do nothing;
