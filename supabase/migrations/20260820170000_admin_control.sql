-- Admin control layer: prices, reviews, user status and global settings.
create table if not exists public.admin_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.instructor_reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid unique references public.bookings(id) on delete set null,
  customer_id uuid references public.profiles(id) on delete set null,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text,
  status text not null default 'visible' check (status in ('visible','hidden','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists active boolean not null default true;

create index if not exists instructor_reviews_instructor_idx on public.instructor_reviews(instructor_id, status, created_at desc);
create index if not exists instructor_reviews_customer_idx on public.instructor_reviews(customer_id, created_at desc);

insert into public.admin_settings(key,value) values
  ('lesson_price', '{"amount":0,"currency":"UZS"}'::jsonb),
  ('lesson_duration', '{"minutes":60}'::jsonb),
  ('booking_enabled', '{"enabled":true}'::jsonb),
  ('system_name', '{"value":"AVTODROM"}'::jsonb)
on conflict (key) do nothing;

alter table public.admin_settings enable row level security;
alter table public.instructor_reviews enable row level security;

-- All writes/reads are performed by the server with the Supabase service role.
