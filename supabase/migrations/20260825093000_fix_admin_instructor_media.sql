-- Production fix for Admin <-> Instructor workflow and customer media uploads.
-- Safe/additive: does not delete existing data.

-- 1) Make the media schema compatible with every deployed version.
create extension if not exists pgcrypto;

create table if not exists public.admin_media (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  title text not null,
  media_type text not null default 'video' check (media_type in ('image','video')),
  storage_path text not null unique,
  public_url text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_media add column if not exists sort_order integer not null default 0;
alter table public.admin_media add column if not exists is_active boolean not null default true;
alter table public.admin_media add column if not exists updated_at timestamptz not null default now();
alter table public.admin_media add column if not exists media_type text;
alter table public.admin_media alter column media_type set default 'video';
update public.admin_media set media_type='video' where media_type is null;
alter table public.admin_media alter column media_type set not null;

create index if not exists admin_media_order_idx
  on public.admin_media(is_active, sort_order, created_at desc);

-- 2) Ensure the customer-media bucket exists and is public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-media',
  'customer-media',
  true,
  524288000,
  array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime']
)
on conflict (id) do update
set public=true,
    file_size_limit=greatest(coalesce(storage.buckets.file_size_limit,0),524288000),
    allowed_mime_types=excluded.allowed_mime_types;

-- 3) Service-role-only approval functions.
-- The Vercel Admin API authenticates the administrator first, then calls these functions
-- with the server service-role key. This avoids depending on a browser-visible admin UUID.
create or replace function public.admin_approve_instructor_service(p_application_id uuid)
returns public.instructor_applications
language plpgsql
security definer
set search_path=public
as $$
declare
  a public.instructor_applications;
  p public.profiles;
  i public.instructors;
begin
  select * into a from public.instructor_applications where id=p_application_id for update;
  if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;

  update public.instructor_applications
     set status='APPROVED', reviewed_at=now(), rejection_reason=null, updated_at=now()
   where id=a.id
   returning * into a;

  select * into p from public.profiles where telegram_id=a.telegram_user_id limit 1;
  if p.id is null then
    insert into public.profiles(telegram_id,first_name,last_name,phone,role,active)
    values(a.telegram_user_id,a.first_name,a.last_name,a.phone,'instructor',true)
    returning * into p;
  else
    update public.profiles
       set first_name=a.first_name,last_name=a.last_name,phone=a.phone,
           role='instructor',active=true,updated_at=now()
     where id=p.id
     returning * into p;
  end if;

  select * into i from public.instructors where profile_id=p.id limit 1;
  if i.id is null then
    insert into public.instructors(
      profile_id,telegram_user_id,first_name,last_name,phone,
      registration_status,approved,approved_at,active,bio
    ) values(
      p.id,a.telegram_user_id,a.first_name,a.last_name,a.phone,
      'APPROVED',true,now(),true,a.message
    ) returning * into i;
  else
    update public.instructors
       set telegram_user_id=a.telegram_user_id,first_name=a.first_name,
           last_name=a.last_name,phone=a.phone,registration_status='APPROVED',
           approved=true,approved_at=now(),active=true,bio=a.message
     where id=i.id;
  end if;

  return a;
end;
$$;

create or replace function public.admin_reject_instructor_service(
  p_application_id uuid,
  p_reason text default null
)
returns public.instructor_applications
language plpgsql
security definer
set search_path=public
as $$
declare a public.instructor_applications;
begin
  update public.instructor_applications
     set status='REJECTED',reviewed_at=now(),rejection_reason=nullif(trim(p_reason),''),updated_at=now()
   where id=p_application_id
   returning * into a;
  if a.id is null then raise exception 'APPLICATION_NOT_FOUND'; end if;
  return a;
end;
$$;

revoke all on function public.admin_approve_instructor_service(uuid) from public, anon, authenticated;
revoke all on function public.admin_reject_instructor_service(uuid,text) from public, anon, authenticated;
grant execute on function public.admin_approve_instructor_service(uuid) to service_role;
grant execute on function public.admin_reject_instructor_service(uuid,text) to service_role;
