/**
 * O'QUVCHINI QAYTARISH — instruktor «sotuvchi» sifatida.
 *
 * Qoida (rahbariyat bilan kelishilgan):
 *  · YANGI PULLIK O'QUVCHI — avtodromdagi BIRINCHI pullik darsi.
 *    Avtoshkola darslari (avtodrom12 cheki) hisobga kirmaydi.
 *    Shu birinchi dars kimga tushsa — o'sha instruktor uni «jalb qilgan».
 *  · QAYTDI — birinchi darsdan keyin 7 kun ichida (boshqa kuni) AYNAN
 *    o'sha instruktor bilan yana darsga kelgan.
 *  · KUTILMOQDA — 7 kun hali o'tmagan. «Band qilgan» — o'sha instruktorga
 *    keyingi bron allaqachon bor.
 *  · BOSHQAGA O'TDI — 7 kun ichida keldi, lekin boshqa instruktor bilan.
 *    Bu instruktorga «qaytdi» deb yozilmaydi.
 *  · QAYTMADI — 7 kun o'tdi, o'sha instruktor bilan kelmadi.
 *  · TAKRORIY KELISHLAR — o'quvchi keyinchalik shu instruktor bilan necha
 *    KUN darsga kelgani (hozirgacha) — «nechta kelishiga sababchi bo'ldi».
 *
 * Qaytish foizi = qaytdi / (qaytdi + boshqaga o'tdi + qaytmadi).
 * Kutilayotganlar foizga kirmaydi — ularning 7 kuni hali tugamagan.
 *
 * Bitta odam kassada ikki marta yozilib qolgan bo'lsa (har xil yozuv,
 * bitta telefon) — telefon raqami bo'yicha birlashtiriladi, aks holda
 * u ikki «yangi o'quvchi» bo'lib qolardi va qaytishi ko'rinmasdi.
 */

export const RETURN_DAYS = 7;

export type RStatus = 'returned' | 'waiting' | 'moved' | 'lost';

export interface RLesson {
  id: string;
  customer_id: string;
  instructor_id: string;
  /** Toshkent kuni YYYY-MM-DD */
  day: string;
  /** ISO vaqt — bir kundagi tartib uchun */
  at: string;
  minutes: number;
}
export interface RUpcoming { customer_id: string; instructor_id: string; day: string; at: string }
export interface RPerson { name?: string | null; phone?: string | null }

export interface RStudent {
  key: string;
  customer_id: string;
  name: string;
  phone: string | null;
  first_at: string;
  first_day: string;
  status: RStatus;
  /** o'sha instruktorga keyingi bron bor (kutilayotganlar uchun muhim) */
  booked: boolean;
  next_at: string | null;
  return_day: string | null;
  days_to_return: number | null;
  /** 7 kun ichida boshqa instruktor bilan kelgan bo'lsa — o'sha instruktor */
  moved_to: string | null;
  /** shu instruktor bilan keyingi kelishlar (kunlar soni) */
  visits: number;
  minutes: number;
  /** takroriy darslar ID'lari — tushumni hisoblash uchun */
  repeat_ids: string[];
}

export interface RAgg {
  new: number; returned: number; waiting: number; booked: number; moved: number; lost: number;
  rate: number | null; visits: number; minutes: number;
}

const dayAdd = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** Telefon bo'yicha odam kaliti: oxirgi 9 raqam. Telefon yo'q — mijoz ID. */
export function personKey(customerId: string, phone?: string | null): string {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 9 ? `p:${d.slice(-9)}` : `c:${customerId}`;
}

export function emptyAgg(): RAgg {
  return { new: 0, returned: 0, waiting: 0, booked: 0, moved: 0, lost: 0, rate: null, visits: 0, minutes: 0 };
}
export function finishAgg(a: RAgg): RAgg {
  const done = a.returned + a.moved + a.lost;
  return { ...a, rate: done ? Math.round((a.returned / done) * 1000) / 10 : null };
}

/**
 * Asosiy hisob. Faqat hisoblaydi — bazaga murojaat qilmaydi (sinash oson).
 * `lessons` — barcha davrdagi O'TILGAN pullik darslar (avtoshkola emas).
 * `upcoming` — kelajakdagi kutilayotgan/tasdiqlangan pullik bronlar.
 * Kogorta — birinchi darsi [fromDay, toDay] oralig'iga tushgan o'quvchilar.
 */
export function computeRetention(o: {
  lessons: RLesson[];
  upcoming: RUpcoming[];
  people: Map<string, RPerson>;
  fromDay: string;
  toDay: string;
  today: string;
  windowDays?: number;
}) {
  const W = o.windowDays ?? RETURN_DAYS;
  const keyOf = (cid: string) => personKey(cid, o.people.get(cid)?.phone);

  const byPerson = new Map<string, RLesson[]>();
  for (const l of o.lessons) {
    if (!l.customer_id || !l.instructor_id || !l.day) continue;
    const k = keyOf(l.customer_id);
    (byPerson.get(k) || byPerson.set(k, []).get(k)!).push(l);
  }
  const upByPerson = new Map<string, RUpcoming[]>();
  for (const u of o.upcoming) {
    if (!u.customer_id || !u.instructor_id) continue;
    const k = keyOf(u.customer_id);
    (upByPerson.get(k) || upByPerson.set(k, []).get(k)!).push(u);
  }

  const perIns = new Map<string, { agg: RAgg; students: RStudent[] }>();
  const ensure = (id: string) => {
    if (!perIns.has(id)) perIns.set(id, { agg: emptyAgg(), students: [] });
    return perIns.get(id)!;
  };
  const total = emptyAgg();

  for (const [key, list] of byPerson) {
    list.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const first = list[0];
    if (first.day < o.fromDay || first.day > o.toDay) continue;

    const ins = first.instructor_id;
    const endDay = dayAdd(first.day, W);
    const later = list.filter((l) => l.day > first.day);
    const same = later.filter((l) => l.instructor_id === ins);
    const ret = same.find((l) => l.day <= endDay) || null;
    const otherIn = later.find((l) => l.instructor_id !== ins && l.day <= endDay) || null;
    const ups = (upByPerson.get(key) || [])
      .filter((u) => u.instructor_id === ins && u.day > first.day && u.day >= o.today)
      .sort((a, b) => a.at.localeCompare(b.at));

    let status: RStatus;
    if (ret) status = 'returned';
    else if (o.today <= endDay) status = 'waiting';
    else if (otherIn) status = 'moved';
    else status = 'lost';

    const visitDays = new Set(same.map((l) => l.day));
    const p = o.people.get(first.customer_id) || {};
    const st: RStudent = {
      key,
      customer_id: first.customer_id,
      name: String(p.name || 'Mijoz'),
      phone: p.phone || null,
      first_at: first.at,
      first_day: first.day,
      status,
      booked: status === 'waiting' && ups.some((u) => u.day <= endDay),
      next_at: ups[0]?.at || null,
      return_day: ret?.day || null,
      days_to_return: ret ? dayDiff(first.day, ret.day) : null,
      moved_to: status === 'moved' && otherIn ? otherIn.instructor_id : null,
      visits: visitDays.size,
      minutes: same.reduce((a, l) => a + (Number(l.minutes) || 0), 0),
      repeat_ids: same.map((l) => l.id),
    };

    const g = ensure(ins);
    g.students.push(st);
    for (const a of [g.agg, total]) {
      a.new++;
      a[status]++;
      if (st.booked) a.booked++;
      a.visits += st.visits;
      a.minutes += st.minutes;
    }
  }

  for (const g of perIns.values()) {
    g.agg = finishAgg(g.agg);
    g.students.sort((a, b) => b.first_at.localeCompare(a.first_at));
  }
  return { windowDays: W, total: finishAgg(total), perIns };
}
