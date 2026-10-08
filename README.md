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
