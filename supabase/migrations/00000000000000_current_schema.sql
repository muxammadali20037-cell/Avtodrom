proname,pg_get_functiondef
admin_reject_instructor_service,"CREATE OR REPLACE FUNCTION public.admin_reject_instructor_service(p_application_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS instructor_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.instructor_applications;
begin
 update public.instructor_applications set status='REJECTED',reviewed_at=now(),rejection_reason=nullif(trim(p_reason),''),updated_at=now() where id=p_application_id returning * into a;
 if a.id is null then raise exception 'APPLICATION_NOT_FOUND'; end if;
 return a;
end; $function$
"
get_instructor_registration_status,"CREATE OR REPLACE FUNCTION public.get_instructor_registration_status(p_telegram_user_id bigint)
 RETURNS TABLE(status text, first_name text, last_name text, rejection_reason text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select ia.status, ia.first_name, ia.last_name, ia.rejection_reason
  from public.instructor_applications ia
  where ia.telegram_user_id=p_telegram_user_id
  limit 1;
$function$
"
prevent_attendance_mutation,"CREATE OR REPLACE FUNCTION public.prevent_attendance_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'Attendance verification records are immutable';
end;
$function$
"
current_app_user,"CREATE OR REPLACE FUNCTION public.current_app_user()
 RETURNS users
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select *
  from public.users
  where id = auth.uid()
  limit 1;
$function$
"
set_updated_at,"CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
"
submit_instructor_application,"CREATE OR REPLACE FUNCTION public.submit_instructor_application(p_telegram_user_id bigint, p_first_name text, p_last_name text, p_phone text, p_experience_years integer DEFAULT NULL::integer, p_message text DEFAULT NULL::text)
 RETURNS instructor_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
"
admin_approve_instructor_service,"CREATE OR REPLACE FUNCTION public.admin_approve_instructor_service(p_application_id uuid)
 RETURNS instructor_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end; $function$
"
admin_reject_instructor,"CREATE OR REPLACE FUNCTION public.admin_reject_instructor(p_application_id uuid, p_admin_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS instructor_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.instructor_applications; v_admin uuid;
begin
  select id into v_admin from public.users where id = p_admin_id limit 1;

  update public.instructor_applications
  set status           = 'REJECTED',
      reviewed_by      = v_admin,
      reviewed_at      = now(),
      rejection_reason = nullif(btrim(coalesce(p_reason, '')), ''),
      updated_at       = now()
  where id = p_application_id
  returning * into a;

  if not found then
    raise exception 'APPLICATION_NOT_FOUND';
  end if;
  return a;
end;
$function$
"
bookings_sync_booking_date,"CREATE OR REPLACE FUNCTION public.bookings_sync_booking_date()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.booking_date := new.start_at;
  return new;
end;
$function$
"
gbtreekey4_in,"CREATE OR REPLACE FUNCTION public.gbtreekey4_in(cstring)
 RETURNS gbtreekey4
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_in$function$
"
gbtreekey4_out,"CREATE OR REPLACE FUNCTION public.gbtreekey4_out(gbtreekey4)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_out$function$
"
gbtreekey8_in,"CREATE OR REPLACE FUNCTION public.gbtreekey8_in(cstring)
 RETURNS gbtreekey8
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_in$function$
"
gbtreekey8_out,"CREATE OR REPLACE FUNCTION public.gbtreekey8_out(gbtreekey8)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_out$function$
"
gbtreekey16_in,"CREATE OR REPLACE FUNCTION public.gbtreekey16_in(cstring)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_in$function$
"
gbtreekey16_out,"CREATE OR REPLACE FUNCTION public.gbtreekey16_out(gbtreekey16)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_out$function$
"
gbtreekey32_in,"CREATE OR REPLACE FUNCTION public.gbtreekey32_in(cstring)
 RETURNS gbtreekey32
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_in$function$
"
gbtreekey32_out,"CREATE OR REPLACE FUNCTION public.gbtreekey32_out(gbtreekey32)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_out$function$
"
gbtreekey_var_in,"CREATE OR REPLACE FUNCTION public.gbtreekey_var_in(cstring)
 RETURNS gbtreekey_var
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_in$function$
"
gbtreekey_var_out,"CREATE OR REPLACE FUNCTION public.gbtreekey_var_out(gbtreekey_var)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_out$function$
"
cash_dist,"CREATE OR REPLACE FUNCTION public.cash_dist(money, money)
 RETURNS money
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$cash_dist$function$
"
date_dist,"CREATE OR REPLACE FUNCTION public.date_dist(date, date)
 RETURNS integer
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$date_dist$function$
"
float4_dist,"CREATE OR REPLACE FUNCTION public.float4_dist(real, real)
 RETURNS real
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$float4_dist$function$
"
float8_dist,"CREATE OR REPLACE FUNCTION public.float8_dist(double precision, double precision)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$float8_dist$function$
"
int2_dist,"CREATE OR REPLACE FUNCTION public.int2_dist(smallint, smallint)
 RETURNS smallint
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$int2_dist$function$
"
int4_dist,"CREATE OR REPLACE FUNCTION public.int4_dist(integer, integer)
 RETURNS integer
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$int4_dist$function$
"
int8_dist,"CREATE OR REPLACE FUNCTION public.int8_dist(bigint, bigint)
 RETURNS bigint
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$int8_dist$function$
"
interval_dist,"CREATE OR REPLACE FUNCTION public.interval_dist(interval, interval)
 RETURNS interval
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$interval_dist$function$
"
oid_dist,"CREATE OR REPLACE FUNCTION public.oid_dist(oid, oid)
 RETURNS oid
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$oid_dist$function$
"
time_dist,"CREATE OR REPLACE FUNCTION public.time_dist(time without time zone, time without time zone)
 RETURNS interval
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$time_dist$function$
"
ts_dist,"CREATE OR REPLACE FUNCTION public.ts_dist(timestamp without time zone, timestamp without time zone)
 RETURNS interval
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$ts_dist$function$
"
tstz_dist,"CREATE OR REPLACE FUNCTION public.tstz_dist(timestamp with time zone, timestamp with time zone)
 RETURNS interval
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$tstz_dist$function$
"
gbt_oid_consistent,"CREATE OR REPLACE FUNCTION public.gbt_oid_consistent(internal, oid, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_oid_consistent$function$
"
gbt_oid_distance,"CREATE OR REPLACE FUNCTION public.gbt_oid_distance(internal, oid, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_oid_distance$function$
"
gbt_oid_fetch,"CREATE OR REPLACE FUNCTION public.gbt_oid_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_oid_fetch$function$
"
gbt_oid_compress,"CREATE OR REPLACE FUNCTION public.gbt_oid_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_oid_compress$function$
"
gbt_decompress,"CREATE OR REPLACE FUNCTION public.gbt_decompress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_decompress$function$
"
gbt_var_decompress,"CREATE OR REPLACE FUNCTION public.gbt_var_decompress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_var_decompress$function$
"
gbt_var_fetch,"CREATE OR REPLACE FUNCTION public.gbt_var_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_var_fetch$function$
"
gbt_oid_penalty,"CREATE OR REPLACE FUNCTION public.gbt_oid_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_oid_penalty$function$
"
gbt_oid_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_oid_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_oid_picksplit$function$
"
gbt_oid_union,"CREATE OR REPLACE FUNCTION public.gbt_oid_union(internal, internal)
 RETURNS gbtreekey8
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_oid_union$function$
"
gbt_oid_same,"CREATE OR REPLACE FUNCTION public.gbt_oid_same(gbtreekey8, gbtreekey8, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_oid_same$function$
"
gbt_int2_consistent,"CREATE OR REPLACE FUNCTION public.gbt_int2_consistent(internal, smallint, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int2_consistent$function$
"
gbt_int2_distance,"CREATE OR REPLACE FUNCTION public.gbt_int2_distance(internal, smallint, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int2_distance$function$
"
gbt_int2_compress,"CREATE OR REPLACE FUNCTION public.gbt_int2_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int2_compress$function$
"
gbt_int2_fetch,"CREATE OR REPLACE FUNCTION public.gbt_int2_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int2_fetch$function$
"
gbt_int2_penalty,"CREATE OR REPLACE FUNCTION public.gbt_int2_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int2_penalty$function$
"
gbt_int2_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_int2_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int2_picksplit$function$
"
gbt_int2_union,"CREATE OR REPLACE FUNCTION public.gbt_int2_union(internal, internal)
 RETURNS gbtreekey4
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int2_union$function$
"
gbt_int2_same,"CREATE OR REPLACE FUNCTION public.gbt_int2_same(gbtreekey4, gbtreekey4, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int2_same$function$
"
gbt_int4_consistent,"CREATE OR REPLACE FUNCTION public.gbt_int4_consistent(internal, integer, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int4_consistent$function$
"
gbt_int4_distance,"CREATE OR REPLACE FUNCTION public.gbt_int4_distance(internal, integer, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int4_distance$function$
"
gbt_int4_compress,"CREATE OR REPLACE FUNCTION public.gbt_int4_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int4_compress$function$
"
gbt_int4_fetch,"CREATE OR REPLACE FUNCTION public.gbt_int4_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int4_fetch$function$
"
gbt_int4_penalty,"CREATE OR REPLACE FUNCTION public.gbt_int4_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int4_penalty$function$
"
gbt_int4_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_int4_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int4_picksplit$function$
"
gbt_int4_union,"CREATE OR REPLACE FUNCTION public.gbt_int4_union(internal, internal)
 RETURNS gbtreekey8
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int4_union$function$
"
gbt_int4_same,"CREATE OR REPLACE FUNCTION public.gbt_int4_same(gbtreekey8, gbtreekey8, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int4_same$function$
"
gbt_int8_consistent,"CREATE OR REPLACE FUNCTION public.gbt_int8_consistent(internal, bigint, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int8_consistent$function$
"
gbt_int8_distance,"CREATE OR REPLACE FUNCTION public.gbt_int8_distance(internal, bigint, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int8_distance$function$
"
gbt_int8_compress,"CREATE OR REPLACE FUNCTION public.gbt_int8_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int8_compress$function$
"
gbt_int8_fetch,"CREATE OR REPLACE FUNCTION public.gbt_int8_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int8_fetch$function$
"
gbt_int8_penalty,"CREATE OR REPLACE FUNCTION public.gbt_int8_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int8_penalty$function$
"
gbt_int8_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_int8_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int8_picksplit$function$
"
gbt_int8_union,"CREATE OR REPLACE FUNCTION public.gbt_int8_union(internal, internal)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int8_union$function$
"
gbt_int8_same,"CREATE OR REPLACE FUNCTION public.gbt_int8_same(gbtreekey16, gbtreekey16, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_int8_same$function$
"
gbt_float4_consistent,"CREATE OR REPLACE FUNCTION public.gbt_float4_consistent(internal, real, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float4_consistent$function$
"
gbt_float4_distance,"CREATE OR REPLACE FUNCTION public.gbt_float4_distance(internal, real, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float4_distance$function$
"
gbt_float4_compress,"CREATE OR REPLACE FUNCTION public.gbt_float4_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float4_compress$function$
"
gbt_float4_fetch,"CREATE OR REPLACE FUNCTION public.gbt_float4_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float4_fetch$function$
"
gbt_float4_penalty,"CREATE OR REPLACE FUNCTION public.gbt_float4_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float4_penalty$function$
"
gbt_float4_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_float4_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float4_picksplit$function$
"
gbt_float4_union,"CREATE OR REPLACE FUNCTION public.gbt_float4_union(internal, internal)
 RETURNS gbtreekey8
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float4_union$function$
"
gbt_float4_same,"CREATE OR REPLACE FUNCTION public.gbt_float4_same(gbtreekey8, gbtreekey8, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float4_same$function$
"
gbt_float8_consistent,"CREATE OR REPLACE FUNCTION public.gbt_float8_consistent(internal, double precision, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float8_consistent$function$
"
gbt_float8_distance,"CREATE OR REPLACE FUNCTION public.gbt_float8_distance(internal, double precision, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float8_distance$function$
"
gbt_float8_compress,"CREATE OR REPLACE FUNCTION public.gbt_float8_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float8_compress$function$
"
gbt_float8_fetch,"CREATE OR REPLACE FUNCTION public.gbt_float8_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float8_fetch$function$
"
gbt_float8_penalty,"CREATE OR REPLACE FUNCTION public.gbt_float8_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float8_penalty$function$
"
gbt_float8_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_float8_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float8_picksplit$function$
"
gbt_float8_union,"CREATE OR REPLACE FUNCTION public.gbt_float8_union(internal, internal)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float8_union$function$
"
gbt_float8_same,"CREATE OR REPLACE FUNCTION public.gbt_float8_same(gbtreekey16, gbtreekey16, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_float8_same$function$
"
gbt_ts_consistent,"CREATE OR REPLACE FUNCTION public.gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_ts_consistent$function$
"
gbt_ts_distance,"CREATE OR REPLACE FUNCTION public.gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_ts_distance$function$
"
gbt_tstz_consistent,"CREATE OR REPLACE FUNCTION public.gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_tstz_consistent$function$
"
gbt_tstz_distance,"CREATE OR REPLACE FUNCTION public.gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_tstz_distance$function$
"
gbt_ts_compress,"CREATE OR REPLACE FUNCTION public.gbt_ts_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_ts_compress$function$
"
gbt_tstz_compress,"CREATE OR REPLACE FUNCTION public.gbt_tstz_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_tstz_compress$function$
"
gbt_ts_fetch,"CREATE OR REPLACE FUNCTION public.gbt_ts_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_ts_fetch$function$
"
gbt_ts_penalty,"CREATE OR REPLACE FUNCTION public.gbt_ts_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_ts_penalty$function$
"
gbt_ts_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_ts_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_ts_picksplit$function$
"
gbt_ts_union,"CREATE OR REPLACE FUNCTION public.gbt_ts_union(internal, internal)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_ts_union$function$
"
gbt_ts_same,"CREATE OR REPLACE FUNCTION public.gbt_ts_same(gbtreekey16, gbtreekey16, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_ts_same$function$
"
gbt_time_consistent,"CREATE OR REPLACE FUNCTION public.gbt_time_consistent(internal, time without time zone, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_time_consistent$function$
"
gbt_time_distance,"CREATE OR REPLACE FUNCTION public.gbt_time_distance(internal, time without time zone, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_time_distance$function$
"
gbt_timetz_consistent,"CREATE OR REPLACE FUNCTION public.gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_timetz_consistent$function$
"
gbt_time_compress,"CREATE OR REPLACE FUNCTION public.gbt_time_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_time_compress$function$
"
gbt_timetz_compress,"CREATE OR REPLACE FUNCTION public.gbt_timetz_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_timetz_compress$function$
"
gbt_time_fetch,"CREATE OR REPLACE FUNCTION public.gbt_time_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_time_fetch$function$
"
gbt_time_penalty,"CREATE OR REPLACE FUNCTION public.gbt_time_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_time_penalty$function$
"
gbt_time_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_time_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_time_picksplit$function$
"
gbt_time_union,"CREATE OR REPLACE FUNCTION public.gbt_time_union(internal, internal)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_time_union$function$
"
gbt_time_same,"CREATE OR REPLACE FUNCTION public.gbt_time_same(gbtreekey16, gbtreekey16, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_time_same$function$
"
gbt_date_consistent,"CREATE OR REPLACE FUNCTION public.gbt_date_consistent(internal, date, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_date_consistent$function$
"
gbt_date_distance,"CREATE OR REPLACE FUNCTION public.gbt_date_distance(internal, date, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_date_distance$function$
"
gbt_date_compress,"CREATE OR REPLACE FUNCTION public.gbt_date_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_date_compress$function$
"
gbt_date_fetch,"CREATE OR REPLACE FUNCTION public.gbt_date_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_date_fetch$function$
"
gbt_date_penalty,"CREATE OR REPLACE FUNCTION public.gbt_date_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_date_penalty$function$
"
gbt_date_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_date_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_date_picksplit$function$
"
gbt_date_union,"CREATE OR REPLACE FUNCTION public.gbt_date_union(internal, internal)
 RETURNS gbtreekey8
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_date_union$function$
"
gbt_date_same,"CREATE OR REPLACE FUNCTION public.gbt_date_same(gbtreekey8, gbtreekey8, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_date_same$function$
"
gbt_intv_consistent,"CREATE OR REPLACE FUNCTION public.gbt_intv_consistent(internal, interval, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_consistent$function$
"
gbt_intv_distance,"CREATE OR REPLACE FUNCTION public.gbt_intv_distance(internal, interval, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_distance$function$
"
gbt_intv_compress,"CREATE OR REPLACE FUNCTION public.gbt_intv_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_compress$function$
"
gbt_intv_decompress,"CREATE OR REPLACE FUNCTION public.gbt_intv_decompress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_decompress$function$
"
gbt_intv_fetch,"CREATE OR REPLACE FUNCTION public.gbt_intv_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_fetch$function$
"
gbt_intv_penalty,"CREATE OR REPLACE FUNCTION public.gbt_intv_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_penalty$function$
"
gbt_intv_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_intv_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_picksplit$function$
"
gbt_intv_union,"CREATE OR REPLACE FUNCTION public.gbt_intv_union(internal, internal)
 RETURNS gbtreekey32
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_union$function$
"
gbt_intv_same,"CREATE OR REPLACE FUNCTION public.gbt_intv_same(gbtreekey32, gbtreekey32, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_intv_same$function$
"
gbt_cash_consistent,"CREATE OR REPLACE FUNCTION public.gbt_cash_consistent(internal, money, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_cash_consistent$function$
"
gbt_cash_distance,"CREATE OR REPLACE FUNCTION public.gbt_cash_distance(internal, money, smallint, oid, internal)
 RETURNS double precision
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_cash_distance$function$
"
gbt_cash_compress,"CREATE OR REPLACE FUNCTION public.gbt_cash_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_cash_compress$function$
"
gbt_cash_fetch,"CREATE OR REPLACE FUNCTION public.gbt_cash_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_cash_fetch$function$
"
gbt_cash_penalty,"CREATE OR REPLACE FUNCTION public.gbt_cash_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_cash_penalty$function$
"
gbt_cash_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_cash_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_cash_picksplit$function$
"
gbt_cash_union,"CREATE OR REPLACE FUNCTION public.gbt_cash_union(internal, internal)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_cash_union$function$
"
gbt_cash_same,"CREATE OR REPLACE FUNCTION public.gbt_cash_same(gbtreekey16, gbtreekey16, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_cash_same$function$
"
gbt_macad_consistent,"CREATE OR REPLACE FUNCTION public.gbt_macad_consistent(internal, macaddr, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad_consistent$function$
"
gbt_macad_compress,"CREATE OR REPLACE FUNCTION public.gbt_macad_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad_compress$function$
"
gbt_macad_fetch,"CREATE OR REPLACE FUNCTION public.gbt_macad_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad_fetch$function$
"
gbt_macad_penalty,"CREATE OR REPLACE FUNCTION public.gbt_macad_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad_penalty$function$
"
gbt_macad_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_macad_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad_picksplit$function$
"
gbt_macad_union,"CREATE OR REPLACE FUNCTION public.gbt_macad_union(internal, internal)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad_union$function$
"
gbt_macad_same,"CREATE OR REPLACE FUNCTION public.gbt_macad_same(gbtreekey16, gbtreekey16, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad_same$function$
"
gbt_text_consistent,"CREATE OR REPLACE FUNCTION public.gbt_text_consistent(internal, text, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_text_consistent$function$
"
gbt_bpchar_consistent,"CREATE OR REPLACE FUNCTION public.gbt_bpchar_consistent(internal, character, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bpchar_consistent$function$
"
gbt_text_compress,"CREATE OR REPLACE FUNCTION public.gbt_text_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_text_compress$function$
"
gbt_bpchar_compress,"CREATE OR REPLACE FUNCTION public.gbt_bpchar_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bpchar_compress$function$
"
gbt_text_penalty,"CREATE OR REPLACE FUNCTION public.gbt_text_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_text_penalty$function$
"
gbt_text_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_text_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_text_picksplit$function$
"
gbt_text_union,"CREATE OR REPLACE FUNCTION public.gbt_text_union(internal, internal)
 RETURNS gbtreekey_var
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_text_union$function$
"
gbt_text_same,"CREATE OR REPLACE FUNCTION public.gbt_text_same(gbtreekey_var, gbtreekey_var, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_text_same$function$
"
gbt_bytea_consistent,"CREATE OR REPLACE FUNCTION public.gbt_bytea_consistent(internal, bytea, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bytea_consistent$function$
"
gbt_bytea_compress,"CREATE OR REPLACE FUNCTION public.gbt_bytea_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bytea_compress$function$
"
gbt_bytea_penalty,"CREATE OR REPLACE FUNCTION public.gbt_bytea_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bytea_penalty$function$
"
gbt_bytea_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_bytea_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bytea_picksplit$function$
"
gbt_bytea_union,"CREATE OR REPLACE FUNCTION public.gbt_bytea_union(internal, internal)
 RETURNS gbtreekey_var
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bytea_union$function$
"
gbt_bytea_same,"CREATE OR REPLACE FUNCTION public.gbt_bytea_same(gbtreekey_var, gbtreekey_var, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bytea_same$function$
"
gbt_numeric_consistent,"CREATE OR REPLACE FUNCTION public.gbt_numeric_consistent(internal, numeric, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_numeric_consistent$function$
"
gbt_numeric_compress,"CREATE OR REPLACE FUNCTION public.gbt_numeric_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_numeric_compress$function$
"
gbt_numeric_penalty,"CREATE OR REPLACE FUNCTION public.gbt_numeric_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_numeric_penalty$function$
"
gbt_numeric_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_numeric_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_numeric_picksplit$function$
"
gbt_numeric_union,"CREATE OR REPLACE FUNCTION public.gbt_numeric_union(internal, internal)
 RETURNS gbtreekey_var
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_numeric_union$function$
"
gbt_numeric_same,"CREATE OR REPLACE FUNCTION public.gbt_numeric_same(gbtreekey_var, gbtreekey_var, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_numeric_same$function$
"
gbt_bit_consistent,"CREATE OR REPLACE FUNCTION public.gbt_bit_consistent(internal, bit, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bit_consistent$function$
"
gbt_bit_compress,"CREATE OR REPLACE FUNCTION public.gbt_bit_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bit_compress$function$
"
gbt_bit_penalty,"CREATE OR REPLACE FUNCTION public.gbt_bit_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bit_penalty$function$
"
gbt_bit_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_bit_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bit_picksplit$function$
"
gbt_bit_union,"CREATE OR REPLACE FUNCTION public.gbt_bit_union(internal, internal)
 RETURNS gbtreekey_var
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bit_union$function$
"
gbt_bit_same,"CREATE OR REPLACE FUNCTION public.gbt_bit_same(gbtreekey_var, gbtreekey_var, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_bit_same$function$
"
gbt_inet_consistent,"CREATE OR REPLACE FUNCTION public.gbt_inet_consistent(internal, inet, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_inet_consistent$function$
"
gbt_inet_compress,"CREATE OR REPLACE FUNCTION public.gbt_inet_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_inet_compress$function$
"
gbt_inet_penalty,"CREATE OR REPLACE FUNCTION public.gbt_inet_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_inet_penalty$function$
"
gbt_inet_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_inet_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_inet_picksplit$function$
"
gbt_inet_union,"CREATE OR REPLACE FUNCTION public.gbt_inet_union(internal, internal)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_inet_union$function$
"
gbt_inet_same,"CREATE OR REPLACE FUNCTION public.gbt_inet_same(gbtreekey16, gbtreekey16, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_inet_same$function$
"
gbt_uuid_consistent,"CREATE OR REPLACE FUNCTION public.gbt_uuid_consistent(internal, uuid, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_uuid_consistent$function$
"
gbt_uuid_fetch,"CREATE OR REPLACE FUNCTION public.gbt_uuid_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_uuid_fetch$function$
"
gbt_uuid_compress,"CREATE OR REPLACE FUNCTION public.gbt_uuid_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_uuid_compress$function$
"
gbt_uuid_penalty,"CREATE OR REPLACE FUNCTION public.gbt_uuid_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_uuid_penalty$function$
"
gbt_uuid_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_uuid_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_uuid_picksplit$function$
"
gbt_uuid_union,"CREATE OR REPLACE FUNCTION public.gbt_uuid_union(internal, internal)
 RETURNS gbtreekey32
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_uuid_union$function$
"
gbt_uuid_same,"CREATE OR REPLACE FUNCTION public.gbt_uuid_same(gbtreekey32, gbtreekey32, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_uuid_same$function$
"
gbt_macad8_consistent,"CREATE OR REPLACE FUNCTION public.gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad8_consistent$function$
"
gbt_macad8_compress,"CREATE OR REPLACE FUNCTION public.gbt_macad8_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad8_compress$function$
"
gbt_macad8_fetch,"CREATE OR REPLACE FUNCTION public.gbt_macad8_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad8_fetch$function$
"
gbt_macad8_penalty,"CREATE OR REPLACE FUNCTION public.gbt_macad8_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad8_penalty$function$
"
gbt_macad8_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_macad8_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad8_picksplit$function$
"
gbt_macad8_union,"CREATE OR REPLACE FUNCTION public.gbt_macad8_union(internal, internal)
 RETURNS gbtreekey16
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad8_union$function$
"
gbt_macad8_same,"CREATE OR REPLACE FUNCTION public.gbt_macad8_same(gbtreekey16, gbtreekey16, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_macad8_same$function$
"
gbt_enum_consistent,"CREATE OR REPLACE FUNCTION public.gbt_enum_consistent(internal, anyenum, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_enum_consistent$function$
"
gbt_enum_compress,"CREATE OR REPLACE FUNCTION public.gbt_enum_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_enum_compress$function$
"
gbt_enum_fetch,"CREATE OR REPLACE FUNCTION public.gbt_enum_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_enum_fetch$function$
"
gbt_enum_penalty,"CREATE OR REPLACE FUNCTION public.gbt_enum_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_enum_penalty$function$
"
gbt_enum_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_enum_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_enum_picksplit$function$
"
gbt_enum_union,"CREATE OR REPLACE FUNCTION public.gbt_enum_union(internal, internal)
 RETURNS gbtreekey8
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_enum_union$function$
"
gbt_enum_same,"CREATE OR REPLACE FUNCTION public.gbt_enum_same(gbtreekey8, gbtreekey8, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbt_enum_same$function$
"
gbtreekey2_in,"CREATE OR REPLACE FUNCTION public.gbtreekey2_in(cstring)
 RETURNS gbtreekey2
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_in$function$
"
gbtreekey2_out,"CREATE OR REPLACE FUNCTION public.gbtreekey2_out(gbtreekey2)
 RETURNS cstring
 LANGUAGE c
 IMMUTABLE PARALLEL SAFE STRICT
AS '$libdir/btree_gist', $function$gbtreekey_out$function$
"
gbt_bool_consistent,"CREATE OR REPLACE FUNCTION public.gbt_bool_consistent(internal, boolean, smallint, oid, internal)
 RETURNS boolean
 LANGUAGE c
 IMMUTABLE STRICT
AS '$libdir/btree_gist', $function$gbt_bool_consistent$function$
"
gbt_bool_compress,"CREATE OR REPLACE FUNCTION public.gbt_bool_compress(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE STRICT
AS '$libdir/btree_gist', $function$gbt_bool_compress$function$
"
gbt_bool_fetch,"CREATE OR REPLACE FUNCTION public.gbt_bool_fetch(internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE STRICT
AS '$libdir/btree_gist', $function$gbt_bool_fetch$function$
"
gbt_bool_penalty,"CREATE OR REPLACE FUNCTION public.gbt_bool_penalty(internal, internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE STRICT
AS '$libdir/btree_gist', $function$gbt_bool_penalty$function$
"
gbt_bool_picksplit,"CREATE OR REPLACE FUNCTION public.gbt_bool_picksplit(internal, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE STRICT
AS '$libdir/btree_gist', $function$gbt_bool_picksplit$function$
"
gbt_bool_union,"CREATE OR REPLACE FUNCTION public.gbt_bool_union(internal, internal)
 RETURNS gbtreekey2
 LANGUAGE c
 IMMUTABLE STRICT
AS '$libdir/btree_gist', $function$gbt_bool_union$function$
"
gbt_bool_same,"CREATE OR REPLACE FUNCTION public.gbt_bool_same(gbtreekey2, gbtreekey2, internal)
 RETURNS internal
 LANGUAGE c
 IMMUTABLE STRICT
AS '$libdir/btree_gist', $function$gbt_bool_same$function$
"
recalc_instructor_rating,"CREATE OR REPLACE FUNCTION public.recalc_instructor_rating()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid := coalesce(new.instructor_id, old.instructor_id);
begin
  if v_id is null then
    return null;
  end if;

  update public.instructor_profiles ip
  set rating = coalesce((
        select round(avg(r.rating)::numeric, 2)
        from public.reviews r
        where r.instructor_id = ip.id and r.status = 'approved'
      ), 0),
      total_reviews = (
        select count(*)
        from public.reviews r
        where r.instructor_id = ip.id and r.status = 'approved'
      ),
      updated_at = now()
  where ip.id = v_id;

  return null;
end;
$function$
"
reviews_require_completed,"CREATE OR REPLACE FUNCTION public.reviews_require_completed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_status public.booking_status;
  v_customer uuid;
begin
  select b.status, b.customer_id into v_status, v_customer
  from public.bookings b where b.id = new.booking_id;

  if v_status is null then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if v_status <> 'completed' then
    raise exception 'BOOKING_NOT_COMPLETED';
  end if;
  if v_customer <> new.customer_id then
    raise exception 'REVIEW_CUSTOMER_MISMATCH';
  end if;

  return new;
end;
$function$
"
instructor_mark_arrived,"CREATE OR REPLACE FUNCTION public.instructor_mark_arrived(p_booking_id uuid, p_instructor_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking public.bookings;
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id and instructor_id = p_instructor_id
  for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if v_booking.status <> 'confirmed' then
    raise exception 'BOOKING_NOT_CONFIRMED';
  end if;

  update public.bookings
  set status = 'in_progress',
      arrived_at = coalesce(arrived_at, now()),
      updated_at = now()
  where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end;
$function$
"
instructor_mark_departed,"CREATE OR REPLACE FUNCTION public.instructor_mark_departed(p_booking_id uuid, p_instructor_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking public.bookings;
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id and instructor_id = p_instructor_id
  for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if v_booking.status <> 'in_progress' then
    raise exception 'BOOKING_NOT_IN_PROGRESS';
  end if;

  update public.bookings
  set status = 'completed',
      departed_at = coalesce(departed_at, now()),
      updated_at = now()
  where id = p_booking_id
  returning * into v_booking;

  return v_booking;
end;
$function$
"
generate_receipt_code,"CREATE OR REPLACE FUNCTION public.generate_receipt_code()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate text;
  i int;
  attempts int := 0;
begin
  loop
    candidate := 'AVD-' || to_char(now() at time zone 'Asia/Tashkent', 'YYMMDD') || '-';
    for i in 1..5 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.payments where receipt_code = candidate);
    attempts := attempts + 1;
    if attempts > 20 then
      raise exception 'RECEIPT_CODE_GENERATION_FAILED';
    end if;
  end loop;
  return candidate;
end;
$function$
"
analytics_report,"CREATE OR REPLACE FUNCTION public.analytics_report(p_from timestamp with time zone, p_to timestamp with time zone, p_bucket text DEFAULT 'day'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bucket text := case when p_bucket in ('hour','day','week','month') then p_bucket else 'day' end;
  v_result jsonb;
begin
  with b as (
    select
      bk.id, bk.status, bk.source, bk.customer_id, bk.instructor_id,
      coalesce(bk.start_at, bk.booking_date)                        as at,
      c.name                                                        as course_name,
      coalesce(bk.duration_minutes, c.duration_minutes, 60)         as mins,
      p.amount                                                      as paid_amount,
      p.method                                                      as pay_method,
      -- Instruktor o'chirilgan bo'lsa bronda saqlangan ism
      coalesce(u.full_name, bk.instructor_name, '—')                as instructor_label
    from public.bookings bk
    left join public.courses  c  on c.id = bk.course_id
    left join public.payments p  on p.booking_id = bk.id and p.status = 'paid'
    left join public.instructor_profiles ip on ip.id = bk.instructor_id
    left join public.users u on u.id = ip.user_id
    where coalesce(bk.start_at, bk.booking_date) >= p_from
      and coalesce(bk.start_at, bk.booking_date) <  p_to
  ),
  totals as (
    select
      count(*)                                                        as bookings,
      count(*) filter (where status = 'completed')                    as completed,
      count(*) filter (where status = 'no_show')                      as no_show,
      count(*) filter (where status in ('cancelled','rejected'))       as cancelled,
      count(*) filter (where status = 'pending')                      as pending,
      count(*) filter (where source = 'walk_in')                      as walk_in,
      count(distinct customer_id)                                     as customers,
      coalesce(sum(paid_amount), 0)                                   as revenue,
      coalesce(sum(paid_amount) filter (where pay_method = 'cash'), 0) as revenue_cash,
      coalesce(sum(paid_amount) filter (where pay_method = 'card'), 0) as revenue_card,
      coalesce(sum(paid_amount) filter (where pay_method = 'mixed'), 0) as revenue_mixed,
      coalesce(sum(mins) filter (where status = 'completed'), 0)      as minutes
    from b
  ),
  series as (
    select
      to_char(date_trunc(v_bucket, at at time zone 'Asia/Tashkent'),
              case v_bucket when 'hour' then 'YYYY-MM-DD HH24:00'
                            when 'month' then 'YYYY-MM'
                            else 'YYYY-MM-DD' end)                     as label,
      count(*)                                                         as bookings,
      count(*) filter (where status = 'completed')                     as completed,
      count(*) filter (where status = 'no_show')                       as no_show,
      coalesce(sum(paid_amount), 0)                                    as revenue
    from b group by 1 order by 1
  ),
  by_instructor as (
    select instructor_label                                          as name,
           count(*)                                                  as bookings,
           count(*) filter (where status = 'completed')              as completed,
           count(*) filter (where status = 'no_show')                as no_show,
           coalesce(sum(mins) filter (where status = 'completed'),0) as minutes,
           coalesce(sum(paid_amount), 0)                             as revenue
    from b where instructor_label <> '—'
    group by instructor_label order by 6 desc, 2 desc
  ),
  by_course as (
    select coalesce(course_name,'—') as name, count(*) as bookings,
           coalesce(sum(paid_amount),0) as revenue
    from b group by 1 order by 3 desc, 2 desc
  ),
  by_hour as (
    select extract(hour from at at time zone 'Asia/Tashkent')::int as hour,
           count(*) as bookings
    from b group by 1 order by 1
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'bucket', v_bucket,
    'totals',      (select to_jsonb(t) from totals t),
    'series',      coalesce((select jsonb_agg(to_jsonb(s)) from series s), '[]'::jsonb),
    'instructors', coalesce((select jsonb_agg(to_jsonb(i)) from by_instructor i), '[]'::jsonb),
    'courses',     coalesce((select jsonb_agg(to_jsonb(c)) from by_course c), '[]'::jsonb),
    'hours',       coalesce((select jsonb_agg(to_jsonb(h)) from by_hour h), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$
"
analytics_instructor,"CREATE OR REPLACE FUNCTION public.analytics_instructor(p_instructor uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_bucket text DEFAULT 'day'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bucket text := case when p_bucket in ('hour','day','week','month') then p_bucket else 'day' end;
  v_result jsonb;
begin
  with b as (
    select bk.id, bk.status, bk.source, bk.customer_id,
           coalesce(bk.start_at, bk.booking_date)                as at,
           c.name                                                as course_name,
           coalesce(bk.duration_minutes, c.duration_minutes, 60) as mins,
           p.amount                                              as paid_amount,
           (av.id is not null)                                   as scanned
    from public.bookings bk
    left join public.courses  c on c.id = bk.course_id
    left join public.payments p on p.booking_id = bk.id and p.status = 'paid'
    left join public.attendance_verifications av on av.booking_id = bk.id
    where bk.instructor_id = p_instructor
      and coalesce(bk.start_at, bk.booking_date) >= p_from
      and coalesce(bk.start_at, bk.booking_date) <  p_to
  ),
  totals as (
    select
      count(*)                                                    as bookings,
      count(*) filter (where status = 'completed')                as completed,
      count(*) filter (where status = 'no_show')                  as no_show,
      count(*) filter (where status in ('cancelled','rejected'))   as cancelled,
      count(*) filter (where scanned)                             as scanned,
      count(distinct customer_id)                                 as customers,
      coalesce(sum(mins) filter (where status='completed'), 0)    as minutes,
      coalesce(sum(paid_amount), 0)                               as revenue
    from b
  ),
  series as (
    select
      to_char(date_trunc(v_bucket, at at time zone 'Asia/Tashkent'),
              case v_bucket when 'hour' then 'YYYY-MM-DD HH24:00'
                            when 'month' then 'YYYY-MM'
                            else 'YYYY-MM-DD' end)                as label,
      count(*)                                                    as bookings,
      count(*) filter (where status = 'completed')                as completed,
      count(*) filter (where status = 'no_show')                  as no_show,
      coalesce(sum(mins) filter (where status='completed'), 0)    as minutes
    from b group by 1 order by 1
  ),
  by_course as (
    select coalesce(course_name,'—') as name, count(*) as bookings
    from b group by 1 order by 2 desc
  ),
  by_hour as (
    select extract(hour from at at time zone 'Asia/Tashkent')::int as hour, count(*) as bookings
    from b group by 1 order by 1
  )
  select jsonb_build_object(
    'totals',  (select to_jsonb(t) from totals t),
    'series',  coalesce((select jsonb_agg(to_jsonb(s)) from series s), '[]'::jsonb),
    'courses', coalesce((select jsonb_agg(to_jsonb(c)) from by_course c), '[]'::jsonb),
    'hours',   coalesce((select jsonb_agg(to_jsonb(h)) from by_hour h), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$
"
shift_summary,"CREATE OR REPLACE FUNCTION public.shift_summary(p_shift uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  select jsonb_build_object(
    'shift_id',      s.id,
    'register',      r.name,
    'register_code', r.code,
    'cashier_name',  s.cashier_name,
    'opened_at',     s.opened_at,
    'closed_at',     s.closed_at,
    'opening_cash',  s.opening_cash,
    'receipts',      coalesce(p.cnt, 0),
    'cash',          coalesce(p.cash, 0),
    'card',          coalesce(p.card, 0),
    'total',         coalesce(p.total, 0),
    -- Kutilgan naqd: smena boshidagi qoldiq + shu smenadagi naqd tushum
    'expected_cash', s.opening_cash + coalesce(p.cash, 0),
    'counted_cash',  s.counted_cash,
    'difference',    s.difference
  )
  into v
  from public.cashier_shifts s
  join public.cash_registers r on r.id = s.register_id
  left join lateral (
    select count(*) as cnt,
           coalesce(sum(case when pm.method = 'mixed' then pm.cash_amount
                             when pm.method = 'cash'  then pm.amount else 0 end), 0) as cash,
           coalesce(sum(case when pm.method = 'mixed' then pm.card_amount
                             when pm.method = 'card'  then pm.amount else 0 end), 0) as card,
           coalesce(sum(pm.amount), 0) as total
    from public.payments pm
    where pm.shift_id = s.id and pm.status = 'paid'
  ) p on true
  where s.id = p_shift;

  return v;
end;
$function$
"
register_report,"CREATE OR REPLACE FUNCTION public.register_report(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(x) order by x.code), '[]'::jsonb)
  into v
  from (
    select
      r.code,
      r.name,
      coalesce(count(p.id), 0)                                             as receipts,
      coalesce(sum(case when p.method = 'mixed' then p.cash_amount
                        when p.method = 'cash'  then p.amount else 0 end), 0) as cash,
      coalesce(sum(case when p.method = 'mixed' then p.card_amount
                        when p.method = 'card'  then p.amount else 0 end), 0) as card,
      coalesce(sum(p.amount), 0)                                           as total
    from public.cash_registers r
    left join public.payments p
      on p.register_id = r.id
     and p.status = 'paid'
     and p.paid_at >= p_from
     and p.paid_at <  p_to
    where r.is_active
    group by r.code, r.name
  ) x;

  return v;
end;
$function$
"
register_dashboard,"CREATE OR REPLACE FUNCTION public.register_dashboard(p_register uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb;
begin
  with p as (
    select pm.*,
           coalesce(bk.category, c.category)                          as category,
           coalesce(bk.duration_minutes, c.duration_minutes, 60)      as mins,
           u.full_name                                                as customer_name,
           iu.full_name                                               as instructor_name
    from public.payments pm
    left join public.bookings bk on bk.id = pm.booking_id
    left join public.courses  c  on c.id  = bk.course_id
    left join public.users    u  on u.id  = pm.customer_id
    left join public.instructor_profiles ip on ip.id = bk.instructor_id
    left join public.users    iu on iu.id = ip.user_id
    where pm.register_id = p_register
      and pm.status = 'paid'
      and pm.paid_at >= p_from
      and pm.paid_at <  p_to
  ),
  totals as (
    select
      count(*)                                                                as receipts,
      coalesce(sum(case when method = 'mixed' then cash_amount
                        when method = 'cash'  then amount else 0 end), 0)     as cash,
      coalesce(sum(case when method = 'mixed' then card_amount
                        when method = 'card'  then amount else 0 end), 0)     as card,
      coalesce(sum(amount), 0)                                                as total,
      coalesce(sum(mins), 0)                                                  as minutes,
      count(distinct customer_id)                                             as customers
    from p
  ),
  by_hour as (
    select extract(hour from paid_at at time zone 'Asia/Tashkent')::int as hour,
           count(*) as receipts, coalesce(sum(amount),0) as total
    from p group by 1 order by 1
  ),
  by_category as (
    select coalesce(category,'—') as name, count(*) as receipts, coalesce(sum(amount),0) as total
    from p group by 1 order by 3 desc
  ),
  by_instructor as (
    select coalesce(instructor_name,'—') as name, count(*) as receipts, coalesce(sum(amount),0) as total
    from p group by 1 order by 3 desc
  ),
  recent as (
    select receipt_code, paid_at, amount, method, customer_name, instructor_name, category, mins
    from p order by paid_at desc limit 50
  )
  select jsonb_build_object(
    'totals',      (select to_jsonb(t) from totals t),
    'hours',       coalesce((select jsonb_agg(to_jsonb(h)) from by_hour h), '[]'::jsonb),
    'categories',  coalesce((select jsonb_agg(to_jsonb(c)) from by_category c), '[]'::jsonb),
    'instructors', coalesce((select jsonb_agg(to_jsonb(i)) from by_instructor i), '[]'::jsonb),
    'recent',      coalesce((select jsonb_agg(to_jsonb(r)) from recent r), '[]'::jsonb)
  ) into v;

  return v;
end;
$function$
"
admin_approve_instructor,"CREATE OR REPLACE FUNCTION public.admin_approve_instructor(p_application_id uuid, p_admin_id uuid)
 RETURNS instructor_applications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  a public.instructor_applications;
  u public.users;
  v_name  text;
  v_phone text;
  v_admin uuid;
begin
  -- Admin yozuvi mavjud bo'lsagina yozamiz, aks holda null
  select id into v_admin from public.users where id = p_admin_id limit 1;
  select * into a from public.instructor_applications where id = p_application_id for update;
  if not found then
    raise exception 'APPLICATION_NOT_FOUND';
  end if;

  v_name  := nullif(btrim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')), '');
  v_phone := nullif(btrim(coalesce(a.phone, '')), '');

  -- Mavjud foydalanuvchi: avval Telegram, keyin telefon bo'yicha
  select * into u from public.users where telegram_id = a.telegram_user_id limit 1;
  if not found and v_phone is not null then
    select * into u from public.users where phone = v_phone limit 1;
  end if;

  if found then
    update public.users
    set telegram_id = coalesce(a.telegram_user_id, telegram_id),
        full_name   = coalesce(v_name, full_name),
        -- Telefonni faqat boshqa foydalanuvchida band bo'lmasa tegamiz
        phone       = case
                        when v_phone is null then phone
                        when exists (select 1 from public.users x
                                     where x.phone = v_phone and x.id <> u.id) then phone
                        else v_phone
                      end,
        role        = 'instructor',
        is_active   = true,
        is_blocked  = false,
        updated_at  = now()
    where id = u.id
    returning * into u;
  else
    insert into public.users (telegram_id, phone, full_name, role, is_active, is_blocked)
    values (a.telegram_user_id, v_phone, coalesce(v_name, 'Instruktor'), 'instructor', true, false)
    returning * into u;
  end if;

  insert into public.instructor_profiles (user_id, experience_years, is_verified, is_available, bio)
  values (u.id, coalesce(a.experience_years, 0), true, true, a.message)
  on conflict (user_id) do update
    set experience_years = excluded.experience_years,
        is_verified      = true,
        is_available     = true,
        bio              = coalesce(excluded.bio, public.instructor_profiles.bio),
        updated_at       = now();

  update public.instructor_applications
  set status           = 'APPROVED',
      reviewed_by      = v_admin,
      reviewed_at      = now(),
      rejection_reason = null,
      updated_at       = now()
  where id = a.id
  returning * into a;

  return a;
end;
$function$
"
