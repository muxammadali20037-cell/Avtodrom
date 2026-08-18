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
