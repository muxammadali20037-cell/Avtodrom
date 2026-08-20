-- AVTODROM CORE DATA MODEL
-- Shared by customer, instructor and admin Mini Apps.
-- Apply this migration to the connected Supabase project before production use.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique,
  role text not null default 'customer' check (role in ('customer','instructor','admin')),
  full_name text not null default '',
  phone text,
  username text,
  avatar_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cars (
  id uuid primary key default gen_random_uuid(),
  plate_number text not null unique,
  brand text not null default '',
  model text not null default '',
  color text,
  status text not null default 'available' check (status in ('available','busy','maintenance','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.instructor_profiles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  license_number text,
  experience_years integer not null default 0,
  is_available boolean not null default true,
  rating numeric(3,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  instructor_id uuid references public.profiles(id),
  car_id uuid references public.cars(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','confirmed','in_progress','completed','cancelled','no_show')),
  price numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  customer_id uuid not null references public.profiles(id),
  amount numeric(12,2) not null check (amount >= 0),
  method text not null default 'cash' check (method in ('cash','card','transfer','online')),
  status text not null default 'pending' check (status in ('pending','paid','refunded','failed')),
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  started_at timestamptz,
  finished_at timestamptz,
  duration_minutes integer,
  instructor_note text,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  booking_id uuid references public.bookings(id) on delete cascade,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists bookings_customer_idx on public.bookings(customer_id, starts_at desc);
create index if not exists bookings_instructor_idx on public.bookings(instructor_id, starts_at desc);
create index if not exists bookings_status_time_idx on public.bookings(status, starts_at);
create index if not exists payments_customer_idx on public.payments(customer_id, created_at desc);
create index if not exists notifications_profile_idx on public.notifications(profile_id, is_read, created_at desc);

-- Prevent overlapping active bookings for the same instructor/car.
create extension if not exists btree_gist;
create index if not exists bookings_starts_at_idx on public.bookings(starts_at);

alter table public.profiles enable row level security;
alter table public.cars enable row level security;
alter table public.instructor_profiles enable row level security;
alter table public.bookings enable row level security;
alter table public.payments enable row level security;
alter table public.attendance enable row level security;
alter table public.notifications enable row level security;

-- Realtime is intentionally enabled for the shared workflow tables.
alter publication supabase_realtime add table public.bookings;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.attendance;
