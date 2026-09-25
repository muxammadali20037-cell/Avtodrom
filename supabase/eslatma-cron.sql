-- =====================================================================
-- ESLATMALARNI HAR 2 DAQIQADA AVTOMATIK TEKSHIRISH (Supabase pg_cron)
--
-- Nega kerak: Vercel bepul rejasida cron kuniga faqat 1 marta ishlaydi.
-- Admin/kassa paneli ochiq turganda eslatmalar baribir ketadi, lekin
-- panel yopiq bo'lsa ham ishlashi uchun buni BIR MARTA ishga tushiring.
--
-- Qanday:
--   1) Supabase → SQL Editor → shu faylni joylang.
--   2) SAYT  → saytingiz manzili (masalan https://avtodrom.vercel.app)
--      CRON_SECRET → Vercel'dagi CRON_SECRET qiymati.
--   3) Run.
-- Admin panel → Sozlamalar → «Eslatmalar» kartasida tayyor matn bor —
-- u yerda sayt manzili o'zi qo'yilgan bo'ladi.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Qayta ishga tushirilsa eskisi o'chadi
select cron.unschedule(jobid) from cron.job where jobname = 'avtodrom-eslatmalar';

select cron.schedule(
  'avtodrom-eslatmalar',
  '*/2 * * * *',
  $$
  select net.http_get(
    url := 'SAYT/api/cron/reminders',
    headers := jsonb_build_object('x-cron-secret', 'CRON_SECRET'),
    timeout_milliseconds := 30000
  );
  $$
);

-- Tekshirish:   select * from cron.job where jobname = 'avtodrom-eslatmalar';
-- Natijalar:    select status, return_message, start_time from cron.job_run_details
--               order by start_time desc limit 10;
-- O'chirish:    select cron.unschedule('avtodrom-eslatmalar');
