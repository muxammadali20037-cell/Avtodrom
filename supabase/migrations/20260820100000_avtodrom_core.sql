create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(), telegram_id bigint unique,
  role text not null default 'customer' check (role in ('customer','instructor','admin')),
  first_name text, last_name text, username text, phone text, avatar_url text,
  status text not null default 'active' check (status in ('active','blocked','pending')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.instructors (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null unique references public.profiles(id) on delete cascade,
  bio text, experience_years integer not null default 0 check (experience_years >= 0),
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','rejected','blocked')),
  active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.cars (
  id uuid primary key default gen_random_uuid(), brand text not null, model text not null,
  plate_number text not null unique, active boolean not null default true,
  status text not null default 'available' check (status in ('available','busy','maintenance','inactive')),
  instructor_id uuid references public.instructors(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.profiles(id) on delete cascade,
  instructor_id uuid references public.instructors(id) on delete set null, car_id uuid references public.cars(id) on delete set null,
  start_at timestamptz not null, end_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','confirmed','customer_confirmed','in_progress','completed','rejected','cancelled','no_show','expired')),
  customer_note text, cancelled_reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint bookings_time_valid check (end_at > start_at)
);

create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(), booking_id uuid not null unique references public.bookings(id) on delete cascade,
  started_at timestamptz, ended_at timestamptz, duration_minutes integer,
  status text not null default 'scheduled' check (status in ('scheduled','in_progress','completed','cancelled')),
  instructor_note text, created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete cascade, title text not null, body text not null,
  channel text not null default 'in_app' check (channel in ('in_app','telegram')),
  type text not null default 'system' check (type in ('system','booking','reminder','approval','status')),
  scheduled_at timestamptz, sent_at timestamptz,
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(), booking_id uuid not null unique references public.bookings(id) on delete cascade,
  customer_id uuid not null references public.profiles(id) on delete cascade, instructor_id uuid not null references public.instructors(id) on delete cascade,
  stars integer not null check (stars between 1 and 5), text text,
  moderation_status text not null default 'pending' check (moderation_status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key, actor_profile_id uuid references public.profiles(id) on delete set null,
  action text not null, entity_type text not null, entity_id uuid, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bookings_customer_idx on public.bookings(customer_id,start_at desc);
create index if not exists bookings_instructor_idx on public.bookings(instructor_id,start_at desc);
create index if not exists bookings_car_idx on public.bookings(car_id,start_at desc);
create index if not exists bookings_status_time_idx on public.bookings(status,start_at);
create index if not exists notifications_due_idx on public.notifications(status,scheduled_at);
create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc);

create or replace function public.prevent_booking_conflict() returns trigger language plpgsql as $$
begin
  if new.status in ('pending','confirmed','customer_confirmed','in_progress') and exists (
    select 1 from public.bookings b where b.id <> new.id and b.status in ('pending','confirmed','customer_confirmed','in_progress')
    and b.start_at < new.end_at and b.end_at > new.start_at
    and ((new.instructor_id is not null and b.instructor_id = new.instructor_id) or (new.car_id is not null and b.car_id = new.car_id))
  ) then raise exception 'Booking conflict: instructor or car is already occupied'; end if;
  return new;
end; $$;

drop trigger if exists bookings_conflict_trigger on public.bookings;
create trigger bookings_conflict_trigger before insert or update of instructor_id,car_id,start_at,end_at,status on public.bookings for each row execute function public.prevent_booking_conflict();

alter table public.profiles enable row level security;
alter table public.instructors enable row level security;
alter table public.cars enable row level security;
alter table public.bookings enable row level security;
alter table public.lessons enable row level security;
alter table public.notifications enable row level security;
alter table public.reviews enable row level security;
alter table public.audit_logs enable row level security;
