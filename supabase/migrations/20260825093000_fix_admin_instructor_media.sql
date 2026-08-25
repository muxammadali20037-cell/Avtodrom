-- Production fix for Admin <-> Instructor workflow and customer media uploads.
-- Safe/additive for the current production schema.

create extension if not exists pgcrypto;

alter table public.admin_media add column if not exists sort_order integer not null default 0;
alter table public.admin_media add column if not exists is_active boolean not null default true;
create index if not exists admin_media_order_idx on public.admin_media(is_active, sort_order, created_at desc);

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('customer-media','customer-media',true,524288000,array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime'])
on conflict (id) do update
set public=true,file_size_limit=greatest(coalesce(storage.buckets.file_size_limit,0),524288000),allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.admin_approve_instructor_service(p_application_id uuid)
returns public.instructor_applications
language plpgsql security definer set search_path=public
as $$
declare a public.instructor_applications; u public.users;
begin
  select * into a from public.instructor_applications where id=p_application_id for update;
  if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  update public.instructor_applications set status='APPROVED',reviewed_at=now(),rejection_reason=null,updated_at=now() where id=a.id returning * into a;
  insert into public.users(telegram_id,phone,full_name,role,is_active,is_blocked)
  values(a.telegram_user_id,a.phone,trim(a.first_name||' '||a.last_name),'instructor',true,false)
  on conflict(telegram_id) do update set phone=excluded.phone,full_name=excluded.full_name,role='instructor',is_active=true,is_blocked=false,updated_at=now()
  returning * into u;
  insert into public.instructor_profiles(user_id,experience_years,is_verified,is_available,bio)
  values(u.id,coalesce(a.experience_years,0),true,true,a.message)
  on conflict(user_id) do update set experience_years=excluded.experience_years,is_verified=true,is_available=true,bio=excluded.bio,updated_at=now();
  return a;
end; $$;

create or replace function public.admin_reject_instructor_service(p_application_id uuid,p_reason text default null)
returns public.instructor_applications language plpgsql security definer set search_path=public
as $$
declare a public.instructor_applications;
begin
  update public.instructor_applications set status='REJECTED',reviewed_at=now(),rejection_reason=nullif(trim(p_reason),''),updated_at=now() where id=p_application_id returning * into a;
  if a.id is null then raise exception 'APPLICATION_NOT_FOUND'; end if;
  return a;
end; $$;
revoke all on function public.admin_approve_instructor_service(uuid) from public,anon,authenticated;
revoke all on function public.admin_reject_instructor_service(uuid,text) from public,anon,authenticated;
grant execute on function public.admin_approve_instructor_service(uuid) to service_role;
grant execute on function public.admin_reject_instructor_service(uuid,text) to service_role;
