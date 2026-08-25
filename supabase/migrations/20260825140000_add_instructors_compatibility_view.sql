-- Keep legacy instructor API queries compatible with the canonical users/instructor_profiles schema.
-- bookings.instructor_id continues to reference instructor_profiles.id.
create or replace view public.instructors as
select
  ip.id,
  ip.user_id as profile_id,
  u.telegram_id as telegram_user_id,
  split_part(u.full_name, ' ', 1) as first_name,
  case
    when position(' ' in trim(u.full_name)) > 0
      then substring(trim(u.full_name) from position(' ' in trim(u.full_name)) + 1)
    else null
  end as last_name,
  u.phone,
  case when ip.is_verified then 'APPROVED' else 'PENDING' end as registration_status,
  ip.is_verified as approved,
  ip.updated_at as approved_at,
  null::uuid as approved_by,
  ip.bio,
  null::text as category,
  ip.experience_years,
  ip.rating,
  ip.total_reviews,
  ip.is_available as active,
  ip.is_available,
  jsonb_build_object() as settings,
  ip.created_at,
  ip.updated_at
from public.instructor_profiles ip
join public.users u on u.id = ip.user_id;
