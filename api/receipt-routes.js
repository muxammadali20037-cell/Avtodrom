import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { pool } from '../backend/src/db.js';

/* =========================================================================
   QR CHEK — avtoshkola o'quvchisi uchun (CHEK SHU YERDA CHIQADI)

   IKKI LOYIHA:
     • avtodrom12 (shu repo) — CHEK CHIQARADI. Operator belgilagan bitta
       avtoshkolaning o'quvchisiga QR kodli chek beriladi. Dars TEKIN.
     • Avtodrom (boshqa repo) — INSTRUKTOR PANELI CHEKNI SKANERLAYDI.
       Skanerlanganda dars Avtodrom dagi instruktor jadvaliga va
       hisobotiga tushadi, shu bilan birga bu yerda ham yoziladi.

   OQIM:
     1) Operator chek chiqaradi → receipts (status='issued', AVS-12345)
     2) O'quvchi chekni instruktorga beradi
     3) Avtodrom instruktor paneli QR ni skanerlaydi va shu yerdagi
        /api/receipts/redeem ga murojaat qiladi (maxfiy kalit bilan):
        chek 'scanned' bo'ladi va bu yerda ham sessiya ochiladi
     4) Dars yakunlanganda Avtodrom /api/receipts/complete ga xabar beradi

   ENDPOINTLAR
     Operator (JWT):
       GET/PUT /api/receipts/config       — chek beriladigan avtoshkola
       POST    /api/receipts              — chek chiqarish
       GET     /api/receipts?date=&status=— cheklar ro'yxati
       POST    /api/receipts/:id/cancel   — bekor qilish
     Avtodrom serveri (X-Receipt-Key maxfiy kaliti, JWT kerak emas):
       GET     /api/receipts/verify?code= — chekni tekshirish (ishlatmaydi)
       POST    /api/receipts/redeem       — chekni ishlatish + sessiya
       POST    /api/receipts/complete     — darsni yakunlash
       POST    /api/receipts/release      — dars ochilmadi, chekni qaytarish
   ========================================================================= */

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const REGIONS = ['01','10','20','25','30','40','50','60','70','75','80','85','90','95'];
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = v => String(v ?? '').trim();

function send(res, status, data) {
  if (res.headersSent) return true;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
  return true;
}

function userId(req) {
  try {
    const h = req.headers?.authorization || '';
    if (!h.startsWith('Bearer ')) return null;
    return String(jwt.verify(h.slice(7), JWT_SECRET).sub);
  } catch { return null; }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  req.body = parsed; req._body = true;
  return parsed;
}

/* ---------------- SXEMA (ishga tushganda o'zi yaratiladi) ----------------
   Repo'dagi mavjud uslub: v3-routes.js ham shunday qiladi. Shu sabab
   qo'lda SQL ishga tushirish shart emas — birinchi so'rovda tayyorlanadi. */
let schemaPromise = null;
function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  /* Xato bo'lsa keshlamaymiz: sovuq startda baza uyqudan uyg'onayotgan
     bo'lsa hamma DDL yiqiladi va shu instansiya umrbod 500 berardi. */
  const first = [];
  schemaPromise = (async () => {
    const q = async sql => { try { await pool.query(sql); } catch (e) { first.push(e); console.error('RECEIPT SCHEMA:', e.message); } };
    await q(`
      CREATE TABLE IF NOT EXISTS receipts(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        code VARCHAR(16) NOT NULL,
        customer_type VARCHAR(20) NOT NULL DEFAULT 'school',
        school_id UUID NULL,
        group_id UUID NULL,
        student_id UUID NULL,
        customer_name VARCHAR(160) NULL,
        customer_phone VARCHAR(50) NULL,
        instructor_id UUID NULL,
        vehicle_plate VARCHAR(30) NULL,
        planned_minutes INTEGER NOT NULL DEFAULT 60,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
        cash_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        terminal_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'issued',
        issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scanned_at TIMESTAMPTZ NULL,
        cancelled_at TIMESTAMPTZ NULL,
        session_id UUID NULL,
        note TEXT NULL
      )
    `);
    await q(`
      CREATE TABLE IF NOT EXISTS receipt_config(
        user_id TEXT PRIMARY KEY,
        school_id UUID NULL,
        default_minutes INTEGER NOT NULL DEFAULT 60,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_user_code ON receipts(user_id, code)`);
    /* Bitta o'quvchida bir vaqtda bitta ochiq chek */
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_open_student
             ON receipts(user_id, student_id) WHERE status='issued' AND student_id IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS idx_receipts_user_issued ON receipts(user_id, issued_at DESC)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_receipts_open ON receipts(user_id, status, issued_at DESC)`);
    await q(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS receipt_id UUID NULL`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_receipt_unique ON sessions(receipt_id) WHERE receipt_id IS NOT NULL`);
    /* Chekni Avtodrom instruktor paneli skanerlaydi — kim skanerlagani
       shu ustunlarda saqlanadi (u instruktor boshqa bazada). */
    await q(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS scanned_by_name TEXT`);
    await q(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS scanned_by_ref TEXT`);
    await q(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS external_booking_id TEXT`);
    /* OCHIQ chek kodi butun bazada yagona — Avtodrom tomoni chekni
       faqat kod bo'yicha topadi, operatorni bilmaydi. */
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_open_code
             ON receipts(code) WHERE status='issued'`);
    if (first.length) { schemaPromise = null; throw first[0]; }
  })().catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}

/* ---------------- Yordamchilar ---------------- */

function normalizePlate(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/** Raqamni vehicles uchun qismlarga ajratadi.
    MUHIM: `plate` matni asosiy ilovadagi plateData() bilan AYNAN bir xil
    yoziladi ("01 111 QQQ" / "01 A 555 AA"). Aks holda o'sha avtomobil
    uchun ikkinchi yozuv paydo bo'lib, band-avtomobil tekshiruvi ishlamay
    qolardi va "Jarayonda" ro'yxatida bitta mashina ikki marta turardi. */
function splitPlate(raw) {
  const s = String(raw || '').toUpperCase().trim();
  let region = '', body = normalizePlate(s);
  const m = s.match(/^(\d{2})\s*([A-Z0-9]{6})$/);
  if (m) { region = m[1]; body = m[2]; }
  else if (body.length === 8 && /^\d{2}/.test(body)) { region = body.slice(0, 2); body = body.slice(2); }
  if (!REGIONS.includes(region)) region = '01';
  if (/^[A-Z]\d{3}[A-Z]{2}$/.test(body)) {
    const firstLetter = body[0], number = body.slice(1, 4), lastLetters = body.slice(4, 6);
    return { region, body, firstLetter, number, lastLetters, plate: `${region} ${firstLetter} ${number} ${lastLetters}` };
  }
  if (/^\d{3}[A-Z]{3}$/.test(body)) {
    const number = body.slice(0, 3), lastLetters = body.slice(3, 6);
    return { region, body, firstLetter: null, number, lastLetters, plate: `${region} ${number} ${lastLetters}` };
  }
  return null;
}

/* Chek kodi prefiksi. "AVD-" ISHLATILMAYDI: Avtodrom loyihasida mijozga
   beriladigan pickup_code aynan AVD-1234 ko'rinishida va ikkalasi
   aralashib ketardi — instruktor birovning chekini ishlatib yuborishi
   mumkin edi. "AVS" = avtoshkola. */
const CODE_PREFIX = 'AVS-';
const CODE_RE = /^AVS-\d{5}$/;

/** Chek raqami. OCHIQ cheklar orasida GLOBAL takrorlanmaydi — chunki
    Avtodrom tomoni chekni faqat kod bo'yicha qidiradi, operatorni
    bilmaydi. Ishlatilgan kod keyinchalik qayta berilishi mumkin. */
async function nextCode(user) {
  for (let i = 0; i < 80; i++) {
    const code = CODE_PREFIX + String(10000 + Math.floor(Math.random() * 90000));
    const r = await pool.query(
      `SELECT 1 FROM receipts WHERE code=$1 AND status='issued' LIMIT 1`, [code]);
    if (!r.rows[0]) return code;
  }
  throw new Error('Bo‘sh chek raqami topilmadi. Eski cheklarni yoping yoki administratorga ayting.');
}

/** Kodni bir ko'rinishga keltiradi: "12345" → "AVS-12345" */
function normCode(v) {
  const s = String(v || '').toUpperCase().replace(/\s+/g, '');
  if (/^\d{5}$/.test(s)) return CODE_PREFIX + s;
  return s;
}

/* =========================================================================
   KASSA — chek chiqarish
   ========================================================================= */
/* ---------------- Chek beriladigan avtoshkola (sozlama) ----------------
   Bazada bir nechta avtoshkola bor. Chek FAQAT bittasiga beriladi va uni
   operator o'zi belgilaydi. Shu sabab tanlov sozlamada saqlanadi. */
async function getConfig(user) {
  const r = await pool.query(`SELECT school_id, default_minutes FROM receipt_config WHERE user_id=$1`, [user]);
  return r.rows[0] || { school_id: null, default_minutes: 60 };
}

async function readConfig(req, res, user) {
  const cfg = await getConfig(user);
  let school = null;
  if (cfg.school_id) {
    const s = await pool.query(`SELECT id, name FROM driving_schools WHERE id=$1 AND owner_key=$2`, [cfg.school_id, user]);
    school = s.rows[0] || null;
  }
  return send(res, 200, { school_id: cfg.school_id, school, default_minutes: Number(cfg.default_minutes || 60) });
}

async function writeConfig(req, res, user) {
  const b = await readBody(req);
  const schoolId = text(b.school_id || b.schoolId) || null;
  const minutes = Math.min(600, Math.max(15, Math.round(num(b.default_minutes || b.defaultMinutes) || 60)));
  if (schoolId) {
    const s = await pool.query(`SELECT id FROM driving_schools WHERE id=$1 AND owner_key=$2`, [schoolId, user]);
    if (!s.rows[0]) return send(res, 404, { error: 'Avtoshkola topilmadi' });
  }
  await pool.query(`
    INSERT INTO receipt_config(user_id, school_id, default_minutes, updated_at)
    VALUES($1,$2,$3,NOW())
    ON CONFLICT (user_id) DO UPDATE SET school_id=EXCLUDED.school_id,
      default_minutes=EXCLUDED.default_minutes, updated_at=NOW()`,
    [user, schoolId, minutes]);
  return await readConfig(req, res, user);
}

/* ---------------- Chek chiqarish ----------------
   Chek TEKIN: avtoshkola o'quvchisi pul to'lamaydi, shu sabab summa ham,
   to'lov turi ham so'ralmaydi va kunlik hisobotga pul yozilmaydi.
   Instruktor ham tanlanmaydi — chekni KIM skanerlasa o'sha instruktor
   biriktiriladi (o'quvchi chekni o'zi istagan instruktorga beradi). */
async function issueReceipt(req, res, user) {
  const b = await readBody(req);

  const cfg = await getConfig(user);
  if (!cfg.school_id) {
    return send(res, 400, { error: 'Avval chek beriladigan avtoshkolani belgilang' });
  }

  const studentId = text(b.student_id || b.studentId) || null;
  if (!studentId) return send(res, 400, { error: 'O‘quvchini tanlang' });

  const minutes = Math.min(600, Math.max(15, Math.round(
    num(b.planned_minutes || b.plannedMinutes) || Number(cfg.default_minutes || 60))));

  const sr = await pool.query(
    `SELECT st.id, st.full_name, st.school_id, st.group_id
       FROM students st WHERE st.id=$1 AND st.owner_key=$2 AND st.active IS NOT FALSE`,
    [studentId, user]);
  const st = sr.rows[0];
  if (!st) return send(res, 404, { error: 'O‘quvchi topilmadi' });
  if (String(st.school_id || '') !== String(cfg.school_id)) {
    return send(res, 400, { error: 'Bu o‘quvchi chek beriladigan avtoshkolaga tegishli emas' });
  }

  /* Ochiq chek ikkilanmasin: bitta o'quvchida bir vaqtda bitta chek */
  const dup = await pool.query(
    `SELECT code FROM receipts WHERE user_id=$1 AND student_id=$2 AND status='issued' LIMIT 1`,
    [user, studentId]);
  if (dup.rows[0]) {
    return send(res, 409, { error: `Bu o‘quvchida ishlatilmagan chek bor: ${dup.rows[0].code}` });
  }

  const code = await nextCode(user);
  const r = await pool.query(`
    INSERT INTO receipts(user_id, code, customer_type, school_id, group_id, student_id,
                         customer_name, planned_minutes, amount, payment_method,
                         cash_amount, terminal_amount, note)
    VALUES($1,$2,'school',$3,$4,$5,$6,$7,0,'none',0,0,$8)
    RETURNING *`,
    [user, code, st.school_id, st.group_id, st.id, st.full_name, minutes, text(b.note) || null]);

  const receipt = r.rows[0];
  const sc = await pool.query(`SELECT name FROM driving_schools WHERE id=$1`, [st.school_id]);
  const gr = st.group_id ? await pool.query(`SELECT name FROM school_groups WHERE id=$1`, [st.group_id]) : null;
  return send(res, 201, {
    receipt: {
      ...receipt,
      student_name: st.full_name,
      school_name: sc.rows[0]?.name || null,
      group_name: gr?.rows[0]?.name || null,
    }
  });
}

/* Kassa ro'yxati / navbat */
async function listReceipts(req, res, user, search) {
  const date = text(search.get('date'));
  const status = text(search.get('status'));
  const params = [user];
  let where = `r.user_id=$1`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    params.push(date);
    where += ` AND r.issued_at >= ($${params.length}::date AT TIME ZONE 'Asia/Tashkent')
               AND r.issued_at <  (($${params.length}::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Tashkent')`;
  }
  if (status) { params.push(status); where += ` AND r.status=$${params.length}`; }

  const r = await pool.query(`
    SELECT r.*, r.scanned_by_name AS instructor_name, st.full_name AS student_name,
           ds.name AS school_name, g.name AS group_name
      FROM receipts r
      LEFT JOIN students st       ON st.id = r.student_id
      LEFT JOIN driving_schools ds ON ds.id = r.school_id
      LEFT JOIN school_groups g   ON g.id  = r.group_id
     WHERE ${where}
     ORDER BY r.issued_at DESC
     LIMIT 300`, params);

  const rows = r.rows.map(x => ({ ...x, amount: Number(x.amount || 0) }));
  /* Cheklar tekin — summa emas, SONI muhim */
  return send(res, 200, {
    receipts: rows,
    summary: {
      total: rows.length,
      open: rows.filter(x => x.status === 'issued').length,
      scanned: rows.filter(x => x.status === 'scanned').length,
      cancelled: rows.filter(x => x.status === 'cancelled').length,
    }
  });
}

async function cancelReceipt(req, res, user, id) {
  const r = await pool.query(
    `UPDATE receipts SET status='cancelled', cancelled_at=NOW()
      WHERE id=$1 AND user_id=$2 AND status='issued' RETURNING *`, [id, user]);
  if (!r.rows[0]) return send(res, 409, { error: 'Chek topilmadi yoki allaqachon ishlatilgan' });
  return send(res, 200, { receipt: r.rows[0] });
}

/* =========================================================================
   AVTODROM SERVERI UCHUN (mashina-mashina)

   Skaner Avtodrom instruktor panelida. U bizga maxfiy kalit bilan
   murojaat qiladi — foydalanuvchi JWT si yo'q. Kalit: RECEIPT_SHARED_KEY.
   ========================================================================= */

const SHARED_KEY = String(process.env.RECEIPT_SHARED_KEY || '');

/** Maxfiy kalitni vaqt-xavfsiz solishtiradi. */
function checkKey(req) {
  if (!SHARED_KEY) return false;
  const given = String(req.headers?.['x-receipt-key'] || '');
  if (given.length !== SHARED_KEY.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(SHARED_KEY)); }
  catch { return false; }
}

/** Chekni ishlatmasdan tekshiradi (skaner darhol ko'rsatishi uchun). */
async function verifyReceipt(req, res, search) {
  const code = normCode(search.get('code'));
  if (!CODE_RE.test(code)) return send(res, 400, { ok: false, error: 'Kod formati: AVS-12345' });

  /* Ochiq chek kodi global yagona — avval o'shani qidiramiz. Topilmasa
     oxirgi holatni ko'rsatamiz ("allaqachon ishlatilgan" deyish uchun). */
  const sql = `
    SELECT r.*, st.full_name AS student_name, ds.name AS school_name, g.name AS group_name
      FROM receipts r
      LEFT JOIN students st        ON st.id = r.student_id
      LEFT JOIN driving_schools ds ON ds.id = r.school_id
      LEFT JOIN school_groups g    ON g.id  = r.group_id
     WHERE r.code=$1`;
  let r = await pool.query(`${sql} AND r.status='issued' LIMIT 1`, [code]);
  if (!r.rows[0]) r = await pool.query(`${sql} ORDER BY r.issued_at DESC LIMIT 1`, [code]);
  const rec = r.rows[0];
  if (!rec) return send(res, 404, { ok: false, error: `${code} — bunday chek topilmadi` });

  return send(res, 200, {
    ok: true,
    receipt: {
      id: rec.id,
      code: rec.code,
      status: rec.status,
      student_name: rec.student_name || rec.customer_name || null,
      student_phone: rec.customer_phone || null,
      school_name: rec.school_name || null,
      group_name: rec.group_name || null,
      planned_minutes: Number(rec.planned_minutes || 60),
      issued_at: rec.issued_at,
      scanned_at: rec.scanned_at,
      scanned_by_name: rec.scanned_by_name || null,
      free: true,
    }
  });
}

/** Chekni ISHLATADI: 'scanned' qiladi va shu bazada ham sessiya ochadi.
    Bir chek faqat bir marta ishlatiladi — tranzaksiya + FOR UPDATE. */
async function redeemReceipt(req, res) {
  const b = await readBody(req);
  const code = normCode(b.code);
  if (!CODE_RE.test(code)) return send(res, 400, { ok: false, error: 'Kod formati: AVS-12345' });

  const insName  = text(b.instructor_name);
  const insRef   = text(b.instructor_ref || b.external_instructor_id);
  const rawPlate = text(b.vehicle_plate);
  const extBooking = text(b.external_booking_id) || null;

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    /* Ochiq chek kodi global yagona, shuning uchun aynan o'shani
       bloklaymiz — boshqa operatorning cheki bilan adashmaydi. */
    let rr = await c.query(
      `SELECT * FROM receipts WHERE code=$1 AND status='issued' LIMIT 1 FOR UPDATE`, [code]);
    let rec = rr.rows[0];
    if (!rec) {
      /* Ochiq chek yo'q — nima bo'lganini aniq aytamiz */
      const last = (await c.query(
        `SELECT status, scanned_by_name FROM receipts WHERE code=$1 ORDER BY issued_at DESC LIMIT 1`, [code])).rows[0];
      await c.query('ROLLBACK');
      if (!last) return send(res, 404, { ok: false, error: `${code} — bunday chek topilmadi` });
      if (last.status === 'cancelled') return send(res, 409, { ok: false, error: 'Bu chek bekor qilingan' });
      return send(res, 409, { ok: false, error: 'Bu chek allaqachon ishlatilgan'
        + (last.scanned_by_name ? ` (${last.scanned_by_name})` : '') });
    }

    /* O'quvchi ma'lumoti */
    const sn = await c.query(`
      SELECT st.full_name, ds.name AS school_name, g.name AS group_name
        FROM students st
        LEFT JOIN driving_schools ds ON ds.id = st.school_id
        LEFT JOIN school_groups g    ON g.id  = st.group_id
       WHERE st.id=$1`, [rec.student_id]);
    const stu = sn.rows[0] || {};
    const personName = text(rec.customer_name) || stu.full_name || null;

    /* Shu bazada ham sessiya ochamiz — dars avtodrom12 hisobotida ham
       ko'rinsin. Avtomobil raqami bo'lmasa sessiya ochilmaydi, ammo chek
       baribir ishlatilgan bo'ladi (Avtodrom tomonda dars boshlanadi). */
    let sessionId = null, note = null;

    /* Avtomobil raqami: Avtodrom yuborgani -> chekdagisi -> shu yerdagi
       instruktorlar ro'yxatidan ism bo'yicha topilgani.
       Uchinchisi kerak, chunki Avtodrom tomonda instruktor profiliga
       avtomobil raqami kiritilmagan bo'lishi mumkin — o'shanda sessiya
       umuman ochilmasdi va dars avtodrom12 hisobotiga tushmasdi. */
    let plateSrc = rawPlate || rec.vehicle_plate;
    if (!splitPlate(plateSrc) && insName) {
      const byName = await c.query(
        `SELECT vehicle_plate FROM instructors
          WHERE owner_key=$1
            AND LOWER(TRIM(full_name)) = LOWER(TRIM($2))
            AND COALESCE(vehicle_plate,'') <> ''
          LIMIT 1`, [rec.user_id, insName]);
      if (byName.rows[0]) plateSrc = byName.rows[0].vehicle_plate;
    }
    const p = splitPlate(plateSrc);
    if (p) {
      /* Avtomobil operatorning o'z yozuvi bo'lsin — user_id siz yozuv
         asosiy ilovaga ko'rinmaydi va ikkinchi nusxa paydo bo'lardi. */
      let vr = await c.query(`SELECT id FROM vehicles WHERE plate=$1 AND user_id::text=$2`, [p.plate, rec.user_id]);
      if (!vr.rows[0]) {
        vr = await c.query(
          `INSERT INTO vehicles(user_id, region_code, first_letter, number, last_letters, plate)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [rec.user_id, p.region, p.firstLetter, p.number, p.lastLetters, p.plate]);
      }
      const vehicleId = vr.rows[0].id;
      const busy = await c.query(
        `SELECT id FROM sessions WHERE vehicle_id=$1 AND status IN ('active','paused','frozen') LIMIT 1`, [vehicleId]);
      if (busy.rows[0]) {
        note = 'Bu avtomobilda avtodrom12 da tugallanmagan dars bor — bu yerda sessiya ochilmadi.';
      } else {
        /* avtodrom12 dagi o'z instruktorini raqam bo'yicha topamiz */
        const mine = await c.query(`
          SELECT id FROM instructors
           WHERE owner_key=$1 AND REGEXP_REPLACE(UPPER(COALESCE(vehicle_plate,'')), '[^A-Z0-9]', '', 'g')=$2
           LIMIT 1`, [rec.user_id, normalizePlate(p.plate)]);
        const st = (await c.query(
          `SELECT hourly_rate, minimum_payment, calculation_mode FROM user_settings WHERE user_id::text=$1`,
          [rec.user_id])).rows[0] || { hourly_rate: 30000, minimum_payment: 0, calculation_mode: 'hour' };

        const ins = await c.query(`
          INSERT INTO sessions(user_id, vehicle_id, hourly_rate, minimum_payment, calculation_mode,
                               school_id, group_id, student_id, instructor_id, planned_minutes,
                               manual_price, receipt_id, customer_type, driver_name, target_duration,
                               amount, cash_amount, terminal_amount, payment_method, duration_seconds)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,'school',$12,$13,0,0,0,'cash',0)
          RETURNING id, started_at`,
          [rec.user_id, vehicleId, st.hourly_rate, st.minimum_payment, st.calculation_mode,
           rec.school_id, rec.group_id, rec.student_id, mine.rows[0]?.id || null,
           rec.planned_minutes, rec.id, personName,
           Math.max(0, Math.round(Number(rec.planned_minutes || 60))) * 60]);
        sessionId = ins.rows[0].id;
      }
    } else {
      note = 'Avtomobil raqami topilmadi — avtodrom12 da sessiya ochilmadi. '
           + 'Instruktorga avtomobil raqamini biriktiring (Avtodrom yoki avtodrom12 → Instruktorlar).';
    }

    await c.query(`
      UPDATE receipts SET status='scanned', scanned_at=NOW(), session_id=$1,
             scanned_by_name=$2, scanned_by_ref=$3, external_booking_id=$4,
             vehicle_plate=COALESCE($5, vehicle_plate),
             note=COALESCE($6, note)
       WHERE id=$7`,
      [sessionId, insName || null, insRef || null, extBooking, p ? p.plate : null, note, rec.id]);

    await c.query('COMMIT');
    return send(res, 200, {
      ok: true,
      receipt: {
        id: rec.id,
        code: rec.code,
        student_name: personName,
        student_phone: rec.customer_phone || null,
        school_name: stu.school_name || null,
        group_name: stu.group_name || null,
        planned_minutes: Number(rec.planned_minutes || 60),
        free: true,
      },
      session_id: sessionId,
      note,
    });
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    console.error('REDEEM:', e);
    return send(res, 500, { ok: false, error: 'Chek ishlatilmadi (server xatosi)' });
  } finally { c.release(); }
}

/** Avtodrom darsni yakunladi — shu yerdagi sessiyani ham yopamiz.
    Dars tekin: summa 0, kunlik hisobotga pul qo'shilmaydi. */
async function completeReceipt(req, res) {
  const b = await readBody(req);
  const code = normCode(b.code);
  if (!CODE_RE.test(code) && !text(b.receipt_id)) return send(res, 400, { ok: false, error: 'Kod formati: AVS-12345' });

  /* receipt_id — redeem javobidan keladi va aynan o'sha chekni topadi.
     Kod bo'yicha qidirish faqat zaxira yo'l. */
  const rid = text(b.receipt_id);
  const r = rid
    ? await pool.query(`SELECT * FROM receipts WHERE id=$1`, [rid])
    : await pool.query(
        `SELECT * FROM receipts WHERE code=$1 AND status='scanned' ORDER BY scanned_at DESC LIMIT 1`, [code]);
  const rec = r.rows[0];
  if (!rec) return send(res, 404, { ok: false, error: 'Chek topilmadi' });
  if (!rec.session_id) return send(res, 200, { ok: true, note: 'Bu chek bo‘yicha avtodrom12 da sessiya yo‘q' });

  const sr = await pool.query(`SELECT * FROM sessions WHERE id=$1`, [rec.session_id]);
  const s = sr.rows[0];
  if (!s) return send(res, 200, { ok: true, note: 'Sessiya topilmadi' });
  if (s.status === 'completed') return send(res, 200, { ok: true, note: 'Allaqachon yakunlangan' });

  const end = new Date();
  /* Vaqt: muzlatish hisobga olingan holda, asosiy ilovadagi
     elapsedSeconds() bilan bir xil mantiq. */
  const base = Number(s.duration_seconds || 0);
  const since = s.resumed_at ? new Date(s.resumed_at) : new Date(s.started_at);
  const live = s.status === 'frozen' ? 0 : Math.max(0, Math.round((end - since) / 1000));
  const given = Number(b.duration_seconds);
  const seconds = (b.duration_seconds !== undefined && b.duration_seconds !== null && Number.isFinite(given) && given > 0)
    ? Math.round(given)
    : Math.max(0, base + live);
  const lessons = s.student_id ? Math.max(1, Math.round(seconds / 3600)) : 0;

  await pool.query(`
    UPDATE sessions SET finished_at=$1, duration_seconds=$2, amount=0, cash_amount=0,
           terminal_amount=0, lessons_counted=$3, status='completed'
     WHERE id=$4`, [end, seconds, lessons, s.id]);

  return send(res, 200, { ok: true, minutes: Math.round(seconds / 60), lessons });
}

/** Chekni QAYTARADI. Avtodrom chekni ishlatib bo'lib, o'z tomonida
    darsni ocholmasa (instruktor vaqti band va h.k.) shu chaqiriladi:
    chek yana 'issued' bo'ladi va o'quvchi darsini yo'qotmaydi. */
async function releaseReceipt(req, res) {
  const b = await readBody(req);
  const rid = text(b.receipt_id);
  const code = normCode(b.code);
  if (!rid && !CODE_RE.test(code)) return send(res, 400, { ok: false, error: 'receipt_id yoki kod kerak' });

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const rr = rid
      ? await c.query(`SELECT * FROM receipts WHERE id=$1 FOR UPDATE`, [rid])
      : await c.query(`SELECT * FROM receipts WHERE code=$1 AND status='scanned' ORDER BY scanned_at DESC LIMIT 1 FOR UPDATE`, [code]);
    const rec = rr.rows[0];
    if (!rec) { await c.query('ROLLBACK'); return send(res, 404, { ok: false, error: 'Chek topilmadi' }); }
    if (rec.status !== 'scanned') { await c.query('ROLLBACK'); return send(res, 200, { ok: true, note: 'Chek allaqachon ochiq yoki bekor' }); }

    /* Shu chek bo'yicha ochilgan sessiyani ham yopamiz — bo'sh dars
       "Jarayonda" ro'yxatida osilib qolmasin. */
    if (rec.session_id) {
      await c.query(
        `DELETE FROM sessions WHERE id=$1 AND receipt_id=$2 AND status IN ('active','paused','frozen')`,
        [rec.session_id, rec.id]);
    }
    /* Ochiq kod global yagona: shu kod boshqa ochiq chekda bo'lsa yangi
       raqam beramiz, aks holda eskisi qaytadi. */
    const taken = (await c.query(
      `SELECT 1 FROM receipts WHERE code=$1 AND status='issued' AND id<>$2 LIMIT 1`, [rec.code, rec.id])).rows[0];
    const newCode = taken ? await nextCode(rec.user_id) : rec.code;
    await c.query(`
      UPDATE receipts SET status='issued', code=$1, scanned_at=NULL, session_id=NULL,
             scanned_by_name=NULL, scanned_by_ref=NULL, external_booking_id=NULL,
             note=COALESCE($2, note)
       WHERE id=$3`, [newCode, text(b.reason) || null, rec.id]);
    await c.query('COMMIT');
    return send(res, 200, { ok: true, code: newCode, changed: newCode !== rec.code });
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    console.error('RELEASE:', e);
    return send(res, 500, { ok: false, error: 'Chek qaytarilmadi' });
  } finally { c.release(); }
}

/* =========================================================================
   DISPATCHER
   ========================================================================= */
export async function handleReceiptRequest(req, res) {
  const url = new URL(String(req.url || ''), 'http://local');
  const path = url.pathname.replace(/^\/api\/restore\//, '/api/');
  const method = (req.method || 'GET').toUpperCase();
  if (!path.startsWith('/api/')) return false;

  const isOurs =
    path === '/api/receipts' ||
    path === '/api/receipts/config' ||
    path === '/api/receipts/verify' ||
    path === '/api/receipts/redeem' ||
    path === '/api/receipts/complete' ||
    path === '/api/receipts/release' ||
    /^\/api\/receipts\/[^/]+\/cancel$/.test(path);
  if (!isOurs) return false;

  try {
    await ensureSchema();

    /* --- Avtodrom serveri (maxfiy kalit; JWT yo'q) --- */
    if (path === '/api/receipts/verify' || path === '/api/receipts/redeem'
        || path === '/api/receipts/complete' || path === '/api/receipts/release') {
      if (!SHARED_KEY) return send(res, 503, { ok: false, error: 'RECEIPT_SHARED_KEY sozlanmagan' });
      if (!checkKey(req)) return send(res, 401, { ok: false, error: 'Kalit noto‘g‘ri' });
      if (path === '/api/receipts/verify'   && method === 'GET')  return await verifyReceipt(req, res, url.searchParams);
      if (path === '/api/receipts/redeem'   && method === 'POST') return await redeemReceipt(req, res);
      if (path === '/api/receipts/complete' && method === 'POST') return await completeReceipt(req, res);
      if (path === '/api/receipts/release'  && method === 'POST') return await releaseReceipt(req, res);
      return send(res, 405, { ok: false, error: 'Bu manzil bu usulni qabul qilmaydi' });
    }

    // --- Operator (JWT) ---
    const user = userId(req);
    if (!user) return send(res, 401, { error: 'Kirish talab qilinadi' });

    if (path === '/api/receipts/config' && method === 'GET') return await readConfig(req, res, user);
    if (path === '/api/receipts/config' && (method === 'PUT' || method === 'POST')) return await writeConfig(req, res, user);

    if (path === '/api/receipts' && method === 'POST') return await issueReceipt(req, res, user);
    if (path === '/api/receipts' && method === 'GET')  return await listReceipts(req, res, user, url.searchParams);

    const cancel = path.match(/^\/api\/receipts\/([^/]+)\/cancel$/);
    if (cancel && method === 'POST') return await cancelReceipt(req, res, user, cancel[1]);

    return send(res, 405, { error: 'Bu manzil bu usulni qabul qilmaydi' });
  } catch (e) {
    console.error('RECEIPT ROUTES:', e);
    /* Xom baza xabari (constraint nomi va h.k.) kassirga ko'rsatilmaydi */
    const msg = /duplicate key|violates|relation|column|syntax|operator does not exist/i.test(String(e.message))
      ? 'Server xatosi. Qayta urinib ko‘ring yoki administratorga ayting.'
      : (e.message || 'Server xatosi');
    return send(res, 500, { error: msg });
  }
}
