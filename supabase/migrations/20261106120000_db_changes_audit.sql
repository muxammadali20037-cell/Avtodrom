-- =====================================================================
-- BAZADAGI TAHRIRLAR JURNALI (boshliq ilovasi → «Tahrirlanganlar»)
--
-- Ilova kodi yozadigan admin_audit_logs faqat ma'lum tugmalarni qayd
-- qiladi. Bu jurnal esa BAZANING O'ZIDA ishlaydi: muhim jadvallardagi
-- har bir UPDATE / DELETE — qaysi yo'l bilan bo'lmasin (admin panel,
-- kassa, bot, Supabase oynasi) — «eski → yangi» bilan yoziladi.
--
-- Kim qilgani: backend har PATCH/DELETE so'roviga `x-avt-actor`
-- sarlavhasini qo'shadi (s:<staff id> | l:<login> | tg:<telegram id>),
-- PostgREST uni request.headers ga qo'yadi. Sarlavha yo'q — tizim/bot.
--
-- Kundalik ish yozilmaydi (aks holda jurnal shovqinga to'lardi):
--   * yozuv yaratilgandan keyin 15 soniya ichidagi o'zgarishlar (o'sha amalning davomi);
--   * bronlarning odatiy oqimi (tasdiqlash, keldi, tugadi…) — faqat yopilgan
--     (tugagan / bekor / kelmagan) bronni o'zgartirish va mijozni almashtirish;
--   * ochiq smena (yopish — oddiy ish), oxirgi kirish vaqti, reyting hisobi,
--     chek chop etilgan vaqt, tizim kalitlari (jadval, paketlar, bot jurnali…);
--   * 25 tadan ko'p qator birdaniga o'zgarsa — bitta umumiy yozuv.
-- Parol / PIN xeshlari yozilmaydi — faqat «o'zgartirildi».
-- Trigger xato bersa ham asosiy yozuv saqlanadi (faqat WARNING).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.db_changes (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  tbl     TEXT NOT NULL,
  op      CHAR(1) NOT NULL,          -- U | D
  row_id  TEXT,
  actor   TEXT,
  changes JSONB,                     -- U: {ustun: [eski, yangi]}, D: o'chirilgan qator
  n_rows  INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_db_changes_at  ON public.db_changes (at DESC);
CREATE INDEX IF NOT EXISTS idx_db_changes_row ON public.db_changes (tbl, row_id, at);
ALTER TABLE public.db_changes ENABLE ROW LEVEL SECURITY;   -- siyosat yo'q: faqat service_role o'qiydi
REVOKE ALL ON public.db_changes FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.db_changes_id_seq FROM anon, authenticated;

/* Sozlamalar ro'yxatidagi kalitmi (admin panel ko'rsatadiganlar) — tizim yozuvlari emas */
CREATE OR REPLACE FUNCTION public.avt_setting_tracked(k TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT k IS NOT NULL
     AND k !~ '^(pack|instructor_busy|instructor_schedule|booking_sheet|instructor_digest|instructor_bot_log|sheet_group|support_kb|customer_bot|reminders_last_run|feedback_campaign)'
     AND k NOT IN ('control_link', 'boss_link')
$$;

CREATE OR REPLACE FUNCTION public.avt_track_changes() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  t       TEXT := TG_TABLE_NAME;
  key_col TEXT := COALESCE(NULLIF(TG_ARGV[0], ''), 'id');
  ign     TEXT[] := ARRAY['updated_at'];
  mask    TEXT[] := ARRAY['password_hash', 'pin_hash'];
  w       TEXT[];
  hdr     TEXT;
  actor   TEXT;
  acc     JSONB := '[]'::jsonb;
  cnt     INT := 0;
  r       RECORD;
  o       JSONB;
  nw      JSONB;
  d       JSONB;
  k       TEXT;
  secret  BOOLEAN;
BEGIN
  IF current_setting('avtodrom.audit_off', true) = '1' THEN RETURN NULL; END IF;

  hdr := current_setting('request.headers', true);
  IF hdr IS NOT NULL AND hdr <> '' THEN
    BEGIN
      actor := substring(hdr::jsonb ->> 'x-avt-actor' FROM '^[A-Za-z0-9_.:@-]{1,80}$');
    EXCEPTION WHEN OTHERS THEN actor := NULL;
    END;
  END IF;

  IF    t = 'staff'               THEN ign := ign || ARRAY['last_login_at'];
  ELSIF t = 'cash_registers'      THEN ign := ign || ARRAY['pin_set_at'];
  ELSIF t = 'instructor_profiles' THEN ign := ign || ARRAY['rating', 'total_reviews'];
  ELSIF t = 'payments'            THEN ign := ign || ARRAY['receipt_printed_at'];
  END IF;

  IF TG_OP = 'DELETE' THEN
    FOR r IN SELECT to_jsonb(x) AS j FROM avt_old x LOOP
      o := r.j;
      IF t = 'admin_settings' AND NOT public.avt_setting_tracked(o ->> 'key') THEN CONTINUE; END IF;
      FOREACH k IN ARRAY mask LOOP
        IF o ? k THEN o := o || jsonb_build_object(k, '***'); END IF;
      END LOOP;
      IF t = 'admin_settings' AND (o ->> 'key') ~ 'pin' THEN o := o || jsonb_build_object('value', '***'); END IF;
      cnt := cnt + 1;
      IF cnt <= 25 THEN acc := acc || jsonb_build_array(jsonb_build_object('id', o ->> key_col, 'c', o)); END IF;
    END LOOP;
  ELSE
    FOR r IN
      SELECT to_jsonb(a) AS oj, to_jsonb(b) AS nj
        FROM avt_old a JOIN avt_new b ON (to_jsonb(a) ->> key_col) = (to_jsonb(b) ->> key_col)
    LOOP
      o := r.oj; nw := r.nj;
      /* yangi yozuvning davomi — o'sha amalning bir qismi */
      IF (o ->> 'created_at') IS NOT NULL AND (o ->> 'created_at')::timestamptz > now() - interval '15 seconds' THEN CONTINUE; END IF;
      w := NULL;
      IF t = 'bookings' THEN
        IF (o ->> 'status') IN ('completed', 'cancelled', 'no_show', 'rejected') THEN
          /* yopilgan bron: yopilish amalining davomi emas (10 soniya) */
          IF (o ->> 'updated_at') IS NOT NULL AND (o ->> 'updated_at')::timestamptz > now() - interval '10 seconds' THEN CONTINUE; END IF;
          w := ARRAY['status', 'price', 'start_at', 'end_at', 'duration_minutes', 'hours', 'instructor_id', 'customer_id',
                     'category', 'course_id', 'deposit_amount', 'arrived_at', 'departed_at'];
        ELSE
          w := ARRAY['customer_id'];
        END IF;
      ELSIF t = 'cashier_shifts' THEN
        IF (o ->> 'closed_at') IS NULL THEN CONTINUE; END IF;
      ELSIF t = 'admin_settings' THEN
        IF NOT public.avt_setting_tracked(o ->> 'key') THEN CONTINUE; END IF;
      END IF;
      secret := t = 'admin_settings' AND (o ->> 'key') ~ 'pin';
      d := '{}'::jsonb;
      FOR k IN SELECT jsonb_object_keys(nw) LOOP
        IF k = ANY(ign) THEN CONTINUE; END IF;
        IF w IS NOT NULL AND NOT (k = ANY(w)) THEN CONTINUE; END IF;
        IF (o -> k) IS DISTINCT FROM (nw -> k) THEN
          IF k = ANY(mask) OR (secret AND k = 'value') THEN
            d := d || jsonb_build_object(k, jsonb_build_array('***', '***'));
          ELSE
            d := d || jsonb_build_object(k, jsonb_build_array(o -> k, nw -> k));
          END IF;
        END IF;
      END LOOP;
      IF d = '{}'::jsonb THEN CONTINUE; END IF;
      cnt := cnt + 1;
      IF cnt <= 25 THEN acc := acc || jsonb_build_array(jsonb_build_object('id', o ->> key_col, 'c', d)); END IF;
    END LOOP;
  END IF;

  IF cnt = 0 THEN RETURN NULL; END IF;
  IF cnt > 25 THEN
    INSERT INTO public.db_changes (tbl, op, row_id, actor, changes, n_rows)
    VALUES (t, left(TG_OP, 1), NULL, actor, NULL, cnt);
  ELSE
    INSERT INTO public.db_changes (tbl, op, row_id, actor, changes, n_rows)
    SELECT t, left(TG_OP, 1), e ->> 'id', actor, e -> 'c', 1 FROM jsonb_array_elements(acc) e;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'avt_track_changes(%): %', t, SQLERRM;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.avt_track_changes() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  spec TEXT[];
  specs TEXT[][] := ARRAY[
    ARRAY['bookings', 'id'], ARRAY['payments', 'id'], ARRAY['users', 'id'], ARRAY['staff', 'id'],
    ARRAY['courses', 'id'], ARRAY['cash_registers', 'id'], ARRAY['cashier_shifts', 'id'],
    ARRAY['instructor_profiles', 'id'], ARRAY['admin_settings', 'key'], ARRAY['reviews', 'id'],
    ARRAY['telegram_admins', 'id']
  ];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    IF to_regclass('public.' || spec[1]) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS avt_chg_u ON public.%I', spec[1]);
    EXECUTE format('CREATE TRIGGER avt_chg_u AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS avt_old NEW TABLE AS avt_new
                    FOR EACH STATEMENT EXECUTE FUNCTION public.avt_track_changes(%L)', spec[1], spec[2]);
    EXECUTE format('DROP TRIGGER IF EXISTS avt_chg_d ON public.%I', spec[1]);
    EXECUTE format('CREATE TRIGGER avt_chg_d AFTER DELETE ON public.%I REFERENCING OLD TABLE AS avt_old
                    FOR EACH STATEMENT EXECUTE FUNCTION public.avt_track_changes(%L)', spec[1], spec[2]);
  END LOOP;
END $$;
