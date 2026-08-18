-- AVTODROM REAL-TIME MANAGEMENT SYSTEM
-- PostgreSQL/Supabase migration

create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('ADMIN','CASHIER','USER');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.session_status as enum ('WAITING','ACTIVE','PAUSED','COMPLETED','CANCELLED');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payment_status as enum ('UNPAID','PAID','PARTIAL','CANCELLED');
exception when duplicate_object then null; end $$;

a create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  role public.app_role not null default 'USER',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  plate_number text not null unique,
  model text,
  vehicle_type text,
  driver_id uuid references public.profiles(id) on delete set null,
  driver_name text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tariffs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  billing_interval_minutes integer not null default 30 check (billing_interval_minutes > 0),
  price_per_interval bigint not null default 0 check (price_per_interval >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id),
  driver_id uuid references public.profiles(id) on delete set null,
  tariff_id uuid not null references public.tariffs(id),
  operator_id uuid references public.profiles(id) on delete set null,
  status public.session_status not null default 'WAITING',
  started_at timestamptz,
  finished_at timestamptz,
  active_seconds bigint not null default 0 check (active_seconds >= 0),
  billed_minutes integer not null default 0 check (billed_minutes >= 0),
  price bigint not null default 0 check (price >= 0),
  payment_status public.payment_status not null default 'UNPAID',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.session_pauses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  paused_at timestamptz not null default now(),
  resumed_at timestamptz,
  duration_seconds bigint not null default 0 check (duration_seconds >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  amount bigint not null check (amount >= 0),
  method text not null default 'CASH',
  status public.payment_status not null default 'PAID',
  operator_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  title text not null,
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  session_id uuid references public.sessions(id) on delete set null,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists sessions_one_live_vehicle_idx
on public.sessions(vehicle_id)
where status in ('ACTIVE','PAUSED','WAITING');

create index if not exists sessions_created_at_idx on public.sessions(created_at desc);
create index if not exists sessions_status_idx on public.sessions(status);
create index if not exists sessions_vehicle_idx on public.sessions(vehicle_id);
create index if not exists payments_created_at_idx on public.payments(created_at desc);

insert into public.settings(key,value) values ('timezone','"Asia/Tashkent"'::jsonb)
on conflict (key) do nothing;
insert into public.settings(key,value) values ('default_billing_interval_minutes','30'::jsonb)
on conflict (key) do nothing;

create or replace function public.calculate_billing(p_active_seconds bigint, p_interval_minutes integer, p_price_per_interval bigint)
returns table(billed_minutes integer, price bigint)
language sql immutable as $$
  select
    case when p_active_seconds <= 0 then 0
    else (ceil((p_active_seconds / 60.0) / p_interval_minutes) * p_interval_minutes)::integer end,
    case when p_active_seconds <= 0 then 0
    else (ceil((p_active_seconds / 60.0) / p_interval_minutes) * p_price_per_interval)::bigint end;
$$;

create or replace function public.session_active_seconds(p_session_id uuid, p_now timestamptz default now())
returns bigint
language plpgsql stable as $$
declare
  s record;
  total bigint := 0;
  p record;
  segment_end timestamptz;
begin
  select * into s from public.sessions where id = p_session_id;
  if not found or s.started_at is null then return 0; end if;
  for p in select * from public.session_pauses where session_id=p_session_id order by paused_at loop
    segment_end := coalesce(p.paused_at, p_now);
    total := total + greatest(0, extract(epoch from (segment_end - s.started_at))::bigint);
  end loop;
  total := greatest(0, extract(epoch from (coalesce(s.finished_at,p_now) - s.started_at))::bigint);
  select coalesce(sum(duration_seconds),0) into p from public.session_pauses where session_id=p_session_id;
  return greatest(0, total - p);
end $$;

create or replace function public.start_session(p_vehicle_id uuid, p_tariff_id uuid, p_operator_id uuid)
returns public.sessions
language plpgsql security definer as $$
declare result public.sessions;
begin
  insert into public.sessions(vehicle_id,tariff_id,operator_id,status,started_at)
  values(p_vehicle_id,p_tariff_id,p_operator_id,'ACTIVE',clock_timestamp())
  returning * into result;
  insert into public.audit_logs(user_id,action,session_id,new_value)
  values(p_operator_id,'SESSION_STARTED',result.id,jsonb_build_object('vehicle_id',p_vehicle_id));
  return result;
exception when unique_violation then
  raise exception 'Bu avtomobil uchun allaqachon faol sessiya mavjud.';
end $$;

create or replace function public.pause_session(p_session_id uuid, p_operator_id uuid)
returns public.sessions
language plpgsql security definer as $$
declare result public.sessions;
begin
  update public.sessions set status='PAUSED', updated_at=now()
  where id=p_session_id and status='ACTIVE' returning * into result;
  if not found then raise exception 'Sessiya ACTIVE holatda emas.'; end if;
  insert into public.session_pauses(session_id,paused_at) values(p_session_id,clock_timestamp());
  insert into public.audit_logs(user_id,action,session_id) values(p_operator_id,'SESSION_PAUSED',p_session_id);
  return result;
end $$;

create or replace function public.resume_session(p_session_id uuid, p_operator_id uuid)
returns public.sessions
language plpgsql security definer as $$
declare result public.sessions; p public.session_pauses;
begin
  update public.session_pauses set resumed_at=clock_timestamp(), duration_seconds=greatest(0,extract(epoch from (clock_timestamp()-paused_at))::bigint)
  where id=(select id from public.session_pauses where session_id=p_session_id and resumed_at is null order by paused_at desc limit 1)
  returning * into p;
  if not found then raise exception 'Ochiq pause topilmadi.'; end if;
  update public.sessions set status='ACTIVE', updated_at=now() where id=p_session_id and status='PAUSED' returning * into result;
  if not found then raise exception 'Sessiya PAUSED holatda emas.'; end if;
  insert into public.audit_logs(user_id,action,session_id) values(p_operator_id,'SESSION_RESUMED',p_session_id);
  return result;
end $$;

create or replace function public.finish_session(p_session_id uuid, p_operator_id uuid)
returns public.sessions
language plpgsql security definer as $$
declare result public.sessions; t public.tariffs; secs bigint; calc record; open_pause public.session_pauses;
begin
  select * into result from public.sessions where id=p_session_id for update;
  if not found or result.status not in ('ACTIVE','PAUSED') then raise exception 'Sessiyani tugatib bo‘lmaydi.'; end if;
  if result.status='PAUSED' then
    update public.session_pauses set resumed_at=clock_timestamp(), duration_seconds=greatest(0,extract(epoch from (clock_timestamp()-paused_at))::bigint)
    where id=(select id from public.session_pauses where session_id=p_session_id and resumed_at is null order by paused_at desc limit 1)
    returning * into open_pause;
  end if;
  result.finished_at := clock_timestamp();
  select * into t from public.tariffs where id=result.tariff_id;
  secs := public.session_active_seconds(p_session_id,result.finished_at);
  select * into calc from public.calculate_billing(secs,t.billing_interval_minutes,t.price_per_interval);
  update public.sessions set status='COMPLETED', finished_at=result.finished_at, active_seconds=secs, billed_minutes=calc.billed_minutes, price=calc.price, updated_at=now() where id=p_session_id returning * into result;
  insert into public.audit_logs(user_id,action,session_id,new_value) values(p_operator_id,'SESSION_FINISHED',p_session_id,jsonb_build_object('active_seconds',secs,'billed_minutes',calc.billed_minutes,'price',calc.price));
  return result;
end $$;

alter table public.profiles enable row level security;
alter table public.vehicles enable row level security;
alter table public.tariffs enable row level security;
alter table public.sessions enable row level security;
alter table public.session_pauses enable row level security;
alter table public.payments enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.settings enable row level security;

-- Baseline authenticated policies. Tighten/extend as your production role model requires.
do $$ begin
  create policy profiles_self_or_admin on public.profiles for all to authenticated using (id=auth.uid() or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='ADMIN')) with check (id=auth.uid() or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='ADMIN'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy vehicles_staff on public.vehicles for all to authenticated using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('ADMIN','CASHIER'))) with check (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('ADMIN','CASHIER')));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tariffs_read on public.tariffs for select to authenticated using (active or exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='ADMIN'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy tariffs_admin on public.tariffs for all to authenticated using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='ADMIN')) with check (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='ADMIN'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy sessions_staff_read on public.sessions for select to authenticated using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('ADMIN','CASHIER')) or driver_id=auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy sessions_staff_write on public.sessions for all to authenticated using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('ADMIN','CASHIER'))) with check (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('ADMIN','CASHIER')));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy payments_staff on public.payments for all to authenticated using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('ADMIN','CASHIER'))) with check (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('ADMIN','CASHIER')));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy notifications_self on public.notifications for select to authenticated using (user_id=auth.uid());
exception when duplicate_object then null; end $$;

-- Realtime publication (safe if already present).
do $$ begin
  alter publication supabase_realtime add table public.sessions;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.vehicles;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.payments;
exception when duplicate_object then null; when undefined_object then null; end $$;
