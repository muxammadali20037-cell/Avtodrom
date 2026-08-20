create extension if not exists pgcrypto;

do $$ begin
  create type public.user_role as enum ('customer','instructor','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.booking_status as enum ('pending','confirmed','cancelled','in_progress','completed','no_show');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  first_name text,
  last_name text,
  username text,
  phone text,
  role public.user_role not null default 'customer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.instructors (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique not null references public.profiles(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.cars (
  id uuid primary key default gen_random_uuid(),
  plate_number text unique not null,
  model text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  instructor_id uuid references public.instructors(id) on delete set null,
  car_id uuid references public.cars(id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status public.booking_status not null default 'pending',
  customer_note text,
  cancelled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete cascade,
  title text not null,
  body text not null,
  channel text not null default 'in_app',
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.booking_reminders (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  reminder_minutes integer not null check (reminder_minutes in (120,60,30,10)),
  send_at timestamptz not null,
  sent_at timestamptz,
  unique (booking_id, reminder_minutes)
);

create index if not exists bookings_customer_idx on public.bookings(customer_id, start_at desc);
create index if not exists bookings_instructor_idx on public.bookings(instructor_id, start_at desc);
create index if not exists bookings_start_idx on public.bookings(start_at, status);
create index if not exists notifications_profile_idx on public.notifications(profile_id, created_at desc);
create index if not exists reminders_due_idx on public.booking_reminders(send_at) where sent_at is null;

alter table public.profiles enable row level security;
alter table public.instructors enable row level security;
alter table public.cars enable row level security;
alter table public.bookings enable row level security;
alter table public.notifications enable row level security;
alter table public.booking_reminders enable row level security;

-- Server uses the Supabase service role. Client-side direct table access remains blocked.
-- API authorization is enforced in the Fastify layer.

create or replace function public.create_booking_reminders()
returns trigger language plpgsql as $$
begin
  if new.status in ('pending','confirmed') then
    insert into public.booking_reminders(booking_id, reminder_minutes, send_at)
    values
      (new.id, 120, new.start_at - interval '120 minutes'),
      (new.id, 60,  new.start_at - interval '60 minutes'),
      (new.id, 30,  new.start_at - interval '30 minutes'),
      (new.id, 10,  new.start_at - interval '10 minutes')
    on conflict (booking_id, reminder_minutes) do update set send_at = excluded.send_at, sent_at = null;
  end if;
  return new;
end $$;

drop trigger if exists booking_reminder_trigger on public.bookings;
create trigger booking_reminder_trigger after insert or update of start_at,status on public.bookings
for each row execute function public.create_booking_reminders();

alter table public.bookings replica identity full;
alter table public.notifications replica identity full;
