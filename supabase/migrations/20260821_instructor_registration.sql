-- REAL INSTRUCTOR REGISTRATION / ADMIN APPROVAL
-- Run in the project's Supabase SQL editor.

create table if not exists public.instructor_applications (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  first_name text not null,
  last_name text not null,
  phone text not null,
  experience_years integer,
  message text,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.instructors add column if not exists telegram_user_id bigint;
alter table public.instructors add column if not exists registration_status text not null default 'PENDING';
alter table public.instructors add column if not exists phone text;
alter table public.instructors add column if not exists first_name text;
alter table public.instructors add column if not exists last_name text;
alter table public.instructors add column if not exists approved_at timestamptz;
alter table public.instructors add column if not exists approved_by uuid references auth.users(id);

create index if not exists instructor_applications_status_idx on public.instructor_applications(status);
create index if not exists instructors_telegram_user_id_idx on public.instructors(telegram_user_id);

-- SECURITY: browser clients cannot approve instructors directly.
alter table public.instructor_applications enable row level security;
alter table public.instructors enable row level security;

create or replace function public.submit_instructor_application(
  p_telegram_user_id bigint,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_experience_years integer default null,
  p_message text default null
) returns public.instructor_applications
language plpgsql security definer set search_path = public
as $$
declare r public.instructor_applications;
begin
  if p_telegram_user_id is null or trim(p_first_name) = '' or trim(p_last_name) = '' or trim(p_phone) = '' then
    raise exception 'Ism, familiya va telefon raqami majburiy';
  end if;

  insert into public.instructor_applications
    (telegram_user_id, first_name, last_name, phone, experience_years, message, status, updated_at)
  values
    (p_telegram_user_id, trim(p_first_name), trim(p_last_name), trim(p_phone), p_experience_years, p_message, 'PENDING', now())
  on conflict (telegram_user_id) do update set
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    phone = excluded.phone,
    experience_years = excluded.experience_years,
    message = excluded.message,
    status = case when instructor_applications.status = 'APPROVED' then 'APPROVED' else 'PENDING' end,
    rejection_reason = null,
    updated_at = now()
  returning * into r;

  return r;
end;
$$;

create or replace function public.get_instructor_registration_status(p_telegram_user_id bigint)
returns table(status text, first_name text, last_name text, rejection_reason text)
language sql security definer set search_path = public
as $$
  select status, first_name, last_name, rejection_reason
  from public.instructor_applications
  where telegram_user_id = p_telegram_user_id
  limit 1;
$$;

create or replace function public.admin_approve_instructor(p_application_id uuid, p_admin_id uuid)
returns public.instructor_applications
language plpgsql security definer set search_path = public
as $$
declare a public.instructor_applications;
begin
  -- Only an existing ADMIN profile can approve.
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'ADMIN') then
    raise exception 'Admin huquqi talab qilinadi';
  end if;

  update public.instructor_applications
  set status='APPROVED', reviewed_by=p_admin_id, reviewed_at=now(), updated_at=now(), rejection_reason=null
  where id=p_application_id
  returning * into a;

  if a.id is null then raise exception 'Ariza topilmadi'; end if;

  insert into public.instructors (telegram_user_id, first_name, last_name, phone, registration_status, approved_at, approved_by)
  values (a.telegram_user_id, a.first_name, a.last_name, a.phone, 'APPROVED', now(), p_admin_id)
  on conflict (telegram_user_id) do update set
    first_name=excluded.first_name,
    last_name=excluded.last_name,
    phone=excluded.phone,
    registration_status='APPROVED',
    approved_at=now(),
    approved_by=p_admin_id;

  return a;
end;
$$;

create or replace function public.admin_reject_instructor(p_application_id uuid, p_admin_id uuid, p_reason text default null)
returns public.instructor_applications
language plpgsql security definer set search_path = public
as $$
declare a public.instructor_applications;
begin
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'ADMIN') then
    raise exception 'Admin huquqi talab qilinadi';
  end if;
  update public.instructor_applications
  set status='REJECTED', reviewed_by=p_admin_id, reviewed_at=now(), updated_at=now(), rejection_reason=p_reason
  where id=p_application_id
  returning * into a;
  if a.id is null then raise exception 'Ariza topilmadi'; end if;
  return a;
end;
$$;
