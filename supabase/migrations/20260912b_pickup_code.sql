-- ============================================================
--  BRON KODI (pickup_code)
--
--  Mijoz kassaga kelib shu kodni aytadi: "AVD-4821". Kassir kodni
--  kiritadi — bron, instruktor, vaqt va narx avtomatik chiqadi.
--
--  MUAMMO: telefon orqali qo'lda bron qilinganda kod berilmasdi.
--  Mijoz kassaga kelib "bron qilganman" derdi, lekin ayta oladigan
--  hech narsasi yo'q edi va kassir uni topolmasdi.
--
--  Qayta ishga tushirish xavfsiz.
-- ============================================================

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS pickup_code TEXT;

-- Kod takrorlanmasin
CREATE UNIQUE INDEX IF NOT EXISTS bookings_pickup_code_key
  ON public.bookings(pickup_code)
  WHERE pickup_code IS NOT NULL;

COMMENT ON COLUMN public.bookings.pickup_code IS
  'Mijoz kassada aytadigan kod, AVD-4821 ko‘rinishida.';

-- Kodi yo'q, hali to'lanmagan bronlarga kod beramiz.
-- Tasodifiy 4 xonali; takrorlansa indeks to'sadi, shuning uchun
-- takrorlanganini keyingi urinishda qayta yozamiz.
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  tries INT;
BEGIN
  FOR r IN
    SELECT id FROM public.bookings
     WHERE pickup_code IS NULL
       AND status IN ('pending','confirmed','in_progress')
  LOOP
    tries := 0;
    LOOP
      candidate := 'AVD-' || LPAD((1000 + floor(random() * 9000))::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.bookings WHERE pickup_code = candidate);
      tries := tries + 1;
      IF tries > 50 THEN
        candidate := 'AVD-' || LPAD((10000 + floor(random() * 90000))::int::text, 5, '0');
        EXIT;
      END IF;
    END LOOP;
    UPDATE public.bookings SET pickup_code = candidate WHERE id = r.id;
  END LOOP;
END $$;
