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

An instructor can be booked only when all three are true:
1. **Work schedule** (Admin → *Ish grafigi*): a weekly template (Mon–Sun: working day or day off, plus closed hours such as lunch) and optional per-date overrides. Stored in `admin_settings` as `instructor_schedule:<instructor_id>`. No schedule = the whole global work day (`work_start`–`work_end`).
2. **Own closed hours**: slots the instructor closes in the panel (*Bo‘sh vaqtlarim*), stored as `instructor_busy:<instructor_id>`.
3. **No overlapping active booking**.

Every booking path enforces this server-side (`instructorBlockedAt` in `backend/src/instructor-blocks.ts`): Mini App, operator manual booking, cashier walk-in/issue and 5-hour packages. The Mini App availability endpoint returns schedule time off as busy, so customers only see instructors who work and are free at the chosen time.

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
