import { WEEKDAYS } from "./constants";

export const uid = (p = "id") => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fromMinutes = (min) => {
  const h = Math.floor(min / 60).toString().padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
};
export const dateStr = (d) => {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
};
export const addDays = (d, n) => {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
};
export const fmtMoney = (n) => (n || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
export const weekdayKeyOf = (d) => WEEKDAYS[d.getDay()];

// Effective price for a course taught by a given instructor: falls back to the
// course's default price/deposit unless the Admin has set an instructor-specific
// override in instructor.pricing[courseId].
export function getInstructorPrice(instructor, course) {
  if (!course) return { price: 0, deposit: 0 };
  const override = instructor?.pricing?.[course.id];
  return override ? { price: override.price, deposit: override.deposit } : { price: course.price, deposit: course.deposit };
}

export const dateInRange = (ds, start, end) => ds >= start && ds <= end;

// Is this instructor bookable at all on this calendar date (status + vacation + explicit day off)?
export function isInstructorAvailableOnDate(instructor, dObj) {
  if (!instructor || instructor.status !== "active") return false;
  const ds = dateStr(dObj);
  if ((instructor.vacationRanges || []).some((v) => dateInRange(ds, v.start, v.end))) return false;
  const custom = instructor.customAvailability?.[ds];
  if (custom && custom.status === "off") return false;
  return true;
}

export function generateSlots(instructor, dObj, duration, existingBookings) {
  if (!isInstructorAvailableOnDate(instructor, dObj)) return [];
  const ds = dateStr(dObj);
  const wk = weekdayKeyOf(dObj);
  const custom = instructor.customAvailability?.[ds];
  let day;
  if (custom) {
    day = { working: true, start: custom.start, end: custom.end, breakStart: null, breakEnd: null };
  } else {
    day = instructor.schedule?.[wk];
    if (!day || !day.working) return [];
  }
  const dur = duration || day.duration || 90;
  const slots = [];
  let cursor = toMinutes(day.start);
  const endMin = toMinutes(day.end);
  const bStart = day.breakStart ? toMinutes(day.breakStart) : null;
  const bEnd = day.breakEnd ? toMinutes(day.breakEnd) : null;
  const blocks = (instructor.blockedSlots?.[ds] || []).map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }));
  const now = new Date();
  const isToday = ds === dateStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  while (cursor + dur <= endMin) {
    const slotEnd = cursor + dur;
    if (bStart != null && cursor < bEnd && slotEnd > bStart) {
      cursor = bEnd;
      continue;
    }
    const overlapsBlock = blocks.some((b) => cursor < b.end && slotEnd > b.start);
    const overlapsBooking = existingBookings.some(
      (b) =>
        b.date === ds &&
        b.instructorId === instructor.id &&
        b.status !== "cancelled" &&
        cursor < toMinutes(b.time) + (b.duration || 90) &&
        slotEnd > toMinutes(b.time)
    );
    const isPast = isToday && cursor <= nowMin;
    if (!overlapsBlock && !overlapsBooking && !isPast) slots.push(fromMinutes(cursor));
    cursor += dur;
  }
  return slots;
}

export function defaultDaySchedule(working, start = "09:00", end = "18:00", breakStart = "13:00", breakEnd = "14:00", duration = 90) {
  return { working, start, end, breakStart, breakEnd, duration };
}
export function defaultBounds(allowed, min = "08:00", max = "21:00") {
  return { allowed, min, max };
}
export function defaultPermissions() {
  return {
    viewEarnings: true,
    manageAvailability: true,
    viewCustomerPhone: true,
    markCompleted: true,
    markNoShow: true,
    viewReviews: true,
    viewAnalytics: true,
    editBooking: false,
    cancelBooking: false,
    rescheduleBooking: false,
  };
}

export const TERMINAL_STATUSES = ["completed", "no_show", "cancelled"];

// Central place both the Admin panel and the Instructor panel use to change a
// booking's status, keeping customer stats and instructor lesson counts in
// sync no matter which role performed the action.
export function updateBookingStatus(data, bookingId, status, extra = {}) {
  const booking = data.bookings.find((b) => b.id === bookingId);
  if (!booking) return data;
  const prevWasTerminal = TERMINAL_STATUSES.includes(booking.status);
  const nextIsTerminal = TERMINAL_STATUSES.includes(status);

  const bookings = data.bookings.map((b) => (b.id === bookingId ? { ...b, status, ...extra } : b));
  let customers = data.customers;
  let instructors = data.instructors;

  if (!prevWasTerminal && nextIsTerminal) {
    customers = customers.map((c) => {
      if (c.id !== booking.customerId) return c;
      const patch = { lastLesson: status === "completed" ? booking.date : c.lastLesson };
      if (status === "completed") patch.completed = (c.completed || 0) + 1;
      if (status === "no_show") patch.noShow = (c.noShow || 0) + 1;
      if (status === "cancelled") patch.cancelled = (c.cancelled || 0) + 1;
      if (status === "completed" && booking.paymentStatus === "paid") patch.totalSpent = (c.totalSpent || 0) + booking.price;
      return { ...c, ...patch };
    });
    if (status === "completed") {
      instructors = instructors.map((i) => (i.id === booking.instructorId ? { ...i, lessonsCompleted: (i.lessonsCompleted || 0) + 1 } : i));
    }
  }
  return { ...data, bookings, customers, instructors };
}

export function statusTone(s) {
  return { pending: "amber", confirmed: "green", in_progress: "blue", completed: "green", no_show: "red", cancelled: "gray" }[s] || "gray";
}
export function paymentTone(s) {
  return { pending: "amber", paid: "green", refunded: "blue", cancelled: "gray" }[s] || "gray";
}
export function instructorStatusTone(s) {
  return { active: "green", vacation: "amber", inactive: "gray" }[s] || "gray";
}

export function getDefaultData() {
  const loc1 = uid("loc"),
    loc2 = uid("loc"),
    loc3 = uid("loc");
  const cA = uid("course"),
    cB = uid("course"),
    cC = uid("course");
  const i1 = uid("ins"),
    i2 = uid("ins"),
    i3 = uid("ins");
  const boundsWeek = (min, max) => ({
    sun: defaultBounds(false, min, max),
    mon: defaultBounds(true, min, max),
    tue: defaultBounds(true, min, max),
    wed: defaultBounds(true, min, max),
    thu: defaultBounds(true, min, max),
    fri: defaultBounds(true, min, max),
    sat: defaultBounds(true, min, max),
  });
  return {
    settings: {
      companyName: "DRIVE PRO",
      phone: "+998 90 123 45 67",
      address: "Toshkent shahri",
      defaultDeposit: 30000,
      cancellationPolicy: "4-6 soat",
      slotDuration: 90,
      language: "uz",
    },
    locations: [
      { id: loc1, name: "Avtodrom №1", address: "Toshkent, Mirobod tumani", phone: "+998 90 111 11 11", start: "09:00", end: "20:00", capacity: 8, active: true },
      { id: loc2, name: "Avtodrom №2", address: "Chilonzor tumani", phone: "+998 90 222 22 22", start: "09:00", end: "20:00", capacity: 6, active: true },
      { id: loc3, name: "Avtodrom №3", address: "Yunusobod tumani", phone: "+998 90 333 33 33", start: "09:00", end: "20:00", capacity: 5, active: true },
    ],
    courses: [
      { id: cA, name: "A toifa — Amaliy haydash", description: "Mototsikl boshqarish amaliyoti", category: "A", price: 90000, deposit: 20000, duration: 60, lessons: 12, active: true },
      { id: cB, name: "B toifa — Amaliy haydash", description: "Yengil avtomobil boshqarish amaliyoti", category: "B", price: 120000, deposit: 30000, duration: 90, lessons: 18, active: true },
      { id: cC, name: "C toifa — Amaliy haydash", description: "Yuk avtomobili boshqarish amaliyoti", category: "C", price: 150000, deposit: 40000, duration: 90, lessons: 20, active: true },
    ],
    instructors: [
      {
        id: i1,
        firstName: "Dilnoza",
        lastName: "Yusupova",
        phone: "+998 90 444 44 44",
        avatar: "👩‍🏫",
        telegram: "@dilnoza_instructor",
        bio: "5 yillik tajribaga ega, sabr-toqatli va tushunarli o‘qitadi.",
        experience: 5,
        rating: 4.8,
        reviewCount: 127,
        lessonsCompleted: 1240,
        courses: [cA, cB],
        locations: [loc1, loc2],
        status: "active",
        vacationRanges: [],
        schedule: {
          sun: defaultDaySchedule(false),
          mon: defaultDaySchedule(true),
          tue: defaultDaySchedule(true),
          wed: defaultDaySchedule(true),
          thu: defaultDaySchedule(true),
          fri: defaultDaySchedule(true),
          sat: defaultDaySchedule(true, "09:00", "15:00", null, null, 90),
        },
        customAvailability: {},
        blockedSlots: {},
        adminBounds: boundsWeek("08:00", "20:00"),
        pricing: {},
        priceHistory: [],
        permissions: defaultPermissions(),
      },
      {
        id: i2,
        firstName: "Aziz",
        lastName: "Karimov",
        phone: "+998 90 555 55 55",
        avatar: "👨‍🏫",
        telegram: "@aziz_instructor",
        bio: "Yosh haydovchilarga ixtisoslashgan instruktor.",
        experience: 3,
        rating: 4.6,
        reviewCount: 84,
        lessonsCompleted: 640,
        courses: [cB],
        locations: [loc1, loc3],
        status: "active",
        vacationRanges: [],
        schedule: {
          sun: defaultDaySchedule(false),
          mon: defaultDaySchedule(true, "10:00", "19:00"),
          tue: defaultDaySchedule(true, "10:00", "19:00"),
          wed: defaultDaySchedule(true, "10:00", "19:00"),
          thu: defaultDaySchedule(true, "10:00", "19:00"),
          fri: defaultDaySchedule(true, "10:00", "19:00"),
          sat: defaultDaySchedule(false),
        },
        customAvailability: {},
        blockedSlots: {},
        adminBounds: boundsWeek("08:00", "20:00"),
        pricing: { [cB]: { price: 110000, deposit: 30000, history: [{ price: 110000, deposit: 30000, date: dateStr(new Date()) }] } },
        priceHistory: [],
        permissions: { ...defaultPermissions(), viewEarnings: false },
      },
      {
        id: i3,
        firstName: "Madina",
        lastName: "Tosheva",
        phone: "+998 90 666 66 66",
        avatar: "👩‍✈️",
        telegram: "@madina_instructor",
        bio: "Xotin-qizlar orasida ayniqsa mashhur, xotirjam uslub.",
        experience: 7,
        rating: 4.9,
        reviewCount: 203,
        lessonsCompleted: 1890,
        courses: [cB, cC],
        locations: [loc2],
        status: "active",
        vacationRanges: [],
        schedule: {
          sun: defaultDaySchedule(false),
          mon: defaultDaySchedule(true, "08:00", "17:00"),
          tue: defaultDaySchedule(true, "08:00", "17:00"),
          wed: defaultDaySchedule(true, "08:00", "17:00"),
          thu: defaultDaySchedule(true, "08:00", "17:00"),
          fri: defaultDaySchedule(true, "08:00", "17:00"),
          sat: defaultDaySchedule(true, "09:00", "14:00", null, null, 90),
        },
        customAvailability: {},
        blockedSlots: {},
        adminBounds: boundsWeek("08:00", "20:00"),
        pricing: {},
        priceHistory: [],
        permissions: defaultPermissions(),
      },
    ],
    customers: [],
    bookings: [],
    reviews: [],
  };
}
