# AVTODROM INDEX

Production architecture for the AVTODROM INDEX Telegram Mini App.

## Current UI sources

The project currently has three HTML UI files:
- Customer/public app: `index.html`
- Admin panel: `admin/index.html`
- Instructor panel: `instructor/index.html`

The original UI is being migrated from the uploaded HTML prototypes into this repository without changing the visual design unnecessarily.

## Target architecture

```text
Telegram Mini App
        |
        v
   Web frontend
        |
        v
 REST API / Auth
        |
  +-----+-----+----------------+
  |           |                |
PostgreSQL  Telegram Bot    Scheduler
  |           |                |
  +-----------+----------------+
              |
          Admin / Instructor
```

## Roles

- `customer`: own profile, own bookings, public instructor information, submit reviews.
- `instructor`: own bookings/schedule only; cannot approve or reject bookings; cannot see private review data.
- `admin`: full management, booking approval/rejection, private reviews, moderation, reliability/no-show controls, audit logs.

## Booking lifecycle

`pending -> confirmed -> customer_confirmed -> in_progress -> completed`

Alternative terminal states: `rejected`, `cancelled`, `no_show`, `expired`.

Only Admin can transition `pending -> confirmed/rejected`.

## Instructor availability

An instructor can be booked only when all four are true:
1. **Work schedule** (Admin → *Ish grafigi*): a weekly template (Mon–Sun: working day or day off, plus closed hours such as lunch) and optional per-date overrides. Stored in `admin_settings` as `instructor_schedule:<instructor_id>`. No schedule = the whole global work day (`work_start`–`work_end`).
2. **Own closed hours**: slots the instructor closes in the panel (*Bo‘sh vaqtlarim*), stored as `instructor_busy:<instructor_id>`.
3. **Excel bron notes**: hours an admin/operator marked in *Excel bron* without a phone number (BAND, a name, a note).
4. **No overlapping active booking**.

Every booking path enforces this server-side (`instructorBlockedAt` in `backend/src/instructor-blocks.ts`): Mini App, operator manual booking, cashier walk-in/issue and 5-hour packages. The Mini App availability endpoint returns schedule time off as busy, so customers only see instructors who work and are free at the chosen time.

## Excel bron (booking sheet)

Admin panel → *Excel bron*: the spreadsheet the admins used to keep in Excel — one column per instructor (name, phone), one row per hour 06:00–21:00, one sheet per day.
- **Admin and operator** type into cells and press *Saqlash* (Ctrl+S). **Cashier** sees the sheet read-only.
- A cell with a **phone number** (`994188549`, `99-313-56-26`, `+998 90 …`, `947372906/C`) becomes a real confirmed booking with a pickup code; the cashier finds it by phone or code. The same number in consecutive hours of one column is one longer booking. `/C` (or `A`, `B`) sets the category, `30 MIN` makes a 30-minute booking (the rest of the hour stays blocked).
- A cell **without a number** only blocks that hour.
- Clearing or changing a number cancels the previous booking (only if it is not paid and not started). Paid/started bookings, Mini App bookings, instructor-closed hours and schedule time off are locked cells.
- Each change carries the text the user saw (`prev`); if someone else changed the cell first, it is not overwritten.
- Keyboard: arrows, Enter, Tab, Delete, F2, Ctrl+C / Ctrl+V (paste a block copied from Excel), Ctrl+Z.

Storage: `admin_settings` → `booking_sheet:<YYYY-MM-DD>` (`backend/src/booking-sheet.ts`), API `GET|PUT /api/admin/booking-sheet` (`backend/src/booking-sheet-routes.ts`). No migration needed.

### Booking through the instructor bot

An approved instructor can write to the **instructor bot** in a private chat, and the bot books that instructor's column of the Excel bron sheet (same checks, same code path — `applySheetChanges`), confirmed, with a pickup code in the reply (`backend/src/instructor-sheet-bot.ts`):

| Message | Meaning |
|---|---|
| `901234567 14:00` | today 14:00, 1 hour |
| `ertaga 901234567 15-17` (`завтра … с 15 до 17`) | tomorrow 15:00–17:00 |
| `12.10 994188549 10:00 /C` | 12 October, category C |
| `901234567 9:00 30 min` | 30 minutes |
| `bekor 14:00` / `bekor ertaga 901234567` | cancel a booking the instructor wrote via the bot (not paid, not started) |
| `bugun` / `ertaga` | the instructor's day |

The bot never overwrites a non-empty cell, and if the booking cannot be created (schedule, category, conflict) nothing is written. Cells written by the bot show `Bot · <instructor>` in Excel bron. The instructor bot webhook must point to `/api/telegram/instructor/webhook` (check with `GET /api/telegram/instructor/webhook`).

### Instructor's own students in the bot

Each instructor gets only **their own column** of the sheet in the instructor bot — an Excel-style picture (PNG drawn with `@resvg/resvg-js`, font Carlito in `backend/assets/fonts`, OFL) with the list of students underneath, phone numbers as `+998…` so a tap starts a call (`backend/src/instructor-notify.ts`):
- **20:00** — tomorrow's students, **07:00** — today's (only instructors who have someone that day; once per day, marker `instructor_digest:<kind>:<date>`; driven by the reminders cron and the panels' tick);
- after every **Excel bron save** — what changed for that instructor (new booking, cancelled, BAND/note added or removed) plus the updated picture;
- **manual booking** (operator) and **kassa walk-in** — an immediate "new booking" message;
- on request — the instructor writes `bugun`, `ertaga` or `12.10`.

If the picture cannot be drawn, the same list is sent as text. `vercel.json` includes `backend/assets/**` in the functions.

## Receipts are the source of truth (chek = hisob)

- A lesson starts **only** by scanning the kassa receipt in the instructor panel
  (`POST /api/instructor/scan/start`). The old "KELDI" start-without-receipt
  endpoint returns `410`.
- **Any instructor can scan any receipt.** If the booking belonged to another
  instructor (or the kassa issued it without an instructor), the booking moves
  to the scanning instructor: `instructor_id` changes, the Excel bron cell moves
  to the new column, the previous instructor gets a bot message, and an audit row
  `BOOKING_TRANSFERRED_BY_SCAN` is written. Category must match; the scanner must
  not have another booking in that time range.
- Each scan writes one immutable `attendance_verifications` row (UNIQUE per
  booking) with a `verification_snapshot` (from-instructor, amount, minutes).
  If that write fails, the lesson start is rolled back.
- The lesson closes **automatically** when the paid time on the receipt is over
  (`arrived_at + duration`), on every reminders tick (`finishDueLessons`).
- Instructor reports — admin `/api/admin/instructor-report`, detail
  `/api/admin/instructor-control/:id`, kassa (same endpoints, scoped to its
  register) and the instructor panel `/api/instructor/summary` — are built from
  `backend/src/lesson-ledger.ts`: lesson owner = the instructor who scanned, day =
  scan day, money = that receipt. Paid receipts that nobody scanned are reported
  separately as `totals.unscanned`. Lessons from before the first scan record are
  counted the old way (started + paid, booking instructor).
- Kassa walk-in receipts: choosing an instructor is optional.
- Customer Mini App: the "Farqi yo‘q" (auto-pick any instructor) option is removed.

## No-deposit policy

Deposits are not required for booking creation. Instead the system uses:
- customer confirmation;
- automated reminders;
- no-show tracking;
- reliability score;
- repeated no-show restrictions;
- Admin approval for high-risk customers.

## Review privacy

Individual review text, individual stars, reviewer identity, moderation notes and related private data are Admin-only. Public/instructor views receive only approved aggregate rating data where appropriate.

## Security

Frontend visibility is not authorization. Every protected operation must be checked server-side. Object ownership checks prevent IDOR/BOLA. Sensitive data is omitted from unauthorized API responses.

## Development

Frontend can be deployed as a static site. The API/database must run on a server platform; GitHub Pages is not the backend.
