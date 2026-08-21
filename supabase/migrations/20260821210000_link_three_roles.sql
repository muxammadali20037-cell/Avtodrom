-- Link instructor applications to the canonical profiles/instructors records.
-- Admin approval creates/updates the instructor profile and makes it bookable.

create or replace function public.admin_approve_instructor(p_application_id uuid, p_admin_id uuid)
returns public.instructor_applications
language plpgsql
security definer
set search_path = public
as $$
declare a public.instructor_applications; p public.profiles; i public.instructors;
begin
  if not exists (select 1 from public.profiles where id=p_admin_id and lower(role::text)='admin' and coalesce(active,true)=true) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  select * into a from public.instructor_applications where id=p_application_id for update;
  if not found then raise exception 'APPLICATION_NOT_FOUND'; end if;
  update public.instructor_applications set status='APPROVED', reviewed_by=p_admin_id, reviewed_at=now(), rejection_reason=null, updated_at=now() where id=a.id returning * into a;

  select * into p from public.profiles where telegram_id=a.telegram_user_id limit 1;
  if p.id is null then
    insert into public.profiles(telegram_id,first_name,last_name,phone,role,active)
    values(a.telegram_user_id,a.first_name,a.last_name,a.phone,'instructor',true) returning * into p;
  else
    update public.profiles set first_name=a.first_name,last_name=a.last_name,phone=a.phone,role='instructor',active=true,updated_at=now() where id=p.id returning * into p;
  end if;

  select * into i from public.instructors where profile_id=p.id limit 1;
  if i.id is null then
    insert into public.instructors(profile_id,telegram_user_id,first_name,last_name,phone,registration_status,approved,approved_at,approved_by,active)
    values(p.id,a.telegram_user_id,a.first_name,a.last_name,a.phone,'APPROVED',true,now(),p_admin_id,true) returning * into i;
  else
    update public.instructors set telegram_user_id=a.telegram_user_id,first_name=a.first_name,last_name=a.last_name,phone=a.phone,registration_status='APPROVED',approved=true,approved_at=now(),approved_by=p_admin_id,active=true where id=i.id;
  end if;
  return a;
end;
$$;

create or replace function public.admin_reject_instructor(p_application_id uuid, p_admin_id uuid, p_reason text default null)
returns public.instructor_applications
language plpgsql
security definer
set search_path = public
as $$
declare a public.instructor_applications;
begin
  if not exists (select 1 from public.profiles where id=p_admin_id and lower(role::text)='admin' and coalesce(active,true)=true) then raise exception 'ADMIN_REQUIRED'; end if;
  update public.instructor_applications set status='REJECTED',reviewed_by=p_admin_id,reviewed_at=now(),rejection_reason=p_reason,updated_at=now() where id=p_application_id returning * into a;
  if a.id is null then raise exception 'APPLICATION_NOT_FOUND'; end if;
  return a;
end;
$$;
