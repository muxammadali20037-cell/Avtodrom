-- REAL INSTRUCTOR REGISTRATION / ADMIN APPROVAL
-- Compatible with the project's existing users / instructor_profiles / telegram_users schema.

create table if not exists public.instructor_applications (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  first_name text not null,
  last_name text not null,
  phone text not null,
  experience_years integer,
  message text,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists instructor_applications_status_idx on public.instructor_applications(status);
alter table public.instructor_applications enable row level security;

create or replace function public.get_instructor_registration_status(p_telegram_user_id bigint)
returns table(status text, first_name text, last_name text, rejection_reason text)
language sql security definer set search_path=public
as $$
  select ia.status, ia.first_name, ia.last_name, ia.rejection_reason
  from public.instructor_applications ia
  where ia.telegram_user_id=p_telegram_user_id
  limit 1;
$$;

create or replace function public.submit_instructor_application(
  p_telegram_user_id bigint,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_experience_years integer default null,
  p_message text default null
) returns public.instructor_applications
language plpgsql security definer set search_path=public
as $$
declare r public.instructor_applications;
begin
  if p_telegram_user_id is null or nullif(trim(p_first_name),'') is null or nullif(trim(p_last_name),'') is null or nullif(trim(p_phone),'') is null then
    raise exception 'Ism, familiya va telefon raqami majburiy';
  end if;

  insert into public.telegram_users(telegram_id,first_name,last_name,role,updated_at)
  values(p_telegram_user_id,trim(p_first_name),trim(p_last_name),'instructor',now())
  on conflict(telegram_id) do update set first_name=excluded.first_name,last_name=excluded.last_name,role='instructor',updated_at=now();

  insert into public.instructor_applications(telegram_user_id,first_name,last_name,phone,experience_years,message,status,updated_at)
  values(p_telegram_user_id,trim(p_first_name),trim(p_last_name),trim(p_phone),p_experience_years,p_message,'PENDING',now())
  on conflict(telegram_user_id) do update set
    first_name=excluded.first_name,last_name=excluded.last_name,phone=excluded.phone,
    experience_years=excluded.experience_years,message=excluded.message,
    status=case when instructor_applications.status='APPROVED' then 'APPROVED' else 'PENDING' end,
    rejection_reason=null,updated_at=now()
  returning * into r;
  return r;
end;
$$;

create or replace function public.admin_approve_instructor(p_application_id uuid, p_admin_id uuid)
returns public.instructor_applications
language plpgsql security definer set search_path=public
as $$
declare a public.instructor_applications; u public.users;
begin
  if not exists(select 1 from public.users where id=p_admin_id and role='admin' and is_active=true and is_blocked=false) then raise exception 'Admin huquqi talab qilinadi'; end if;
  update public.instructor_applications set status='APPROVED',reviewed_by=p_admin_id,reviewed_at=now(),rejection_reason=null,updated_at=now() where id=p_application_id returning * into a;
  if a.id is null then raise exception 'Ariza topilmadi'; end if;
  insert into public.users(telegram_id,phone,full_name,role,is_active,is_blocked)
  values(a.telegram_user_id,a.phone,trim(a.first_name||' '||a.last_name),'instructor',true,false)
  on conflict(telegram_id) do update set phone=excluded.phone,full_name=excluded.full_name,role='instructor',is_active=true,is_blocked=false,updated_at=now()
  returning * into u;
  insert into public.instructor_profiles(user_id,experience_years,is_verified,is_available,bio)
  values(u.id,coalesce(a.experience_years,0),true,true,a.message)
  on conflict(user_id) do update set experience_years=excluded.experience_years,is_verified=true,is_available=true,bio=excluded.bio,updated_at=now();
  return a;
end;
$$;

create or replace function public.admin_reject_instructor(p_application_id uuid, p_admin_id uuid, p_reason text default null)
returns public.instructor_applications
language plpgsql security definer set search_path=public
as $$
declare a public.instructor_applications;
begin
  if not exists(select 1 from public.users where id=p_admin_id and role='admin' and is_active=true and is_blocked=false) then raise exception 'Admin huquqi talab qilinadi'; end if;
  update public.instructor_applications set status='REJECTED',reviewed_by=p_admin_id,reviewed_at=now(),rejection_reason=p_reason,updated_at=now() where id=p_application_id returning * into a;
  if a.id is null then raise exception 'Ariza topilmadi'; end if;
  return a;
end;
$$;
