# AVTODROM INDEX

Production architecture for the AVTODROM Telegram Mini App system.

## Repository

`muxammadali20037-cell/Avtodrom`

## Three Mini Apps

- Customer: `frontend/index.html`
- Instructor: `instructor/index.html`
- Admin: `admin/index.html`

The three apps share one backend and one Supabase PostgreSQL database.

## Backend

- Node.js + TypeScript + Fastify
- Telegram Mini App `initData` verification on the server
- Supabase REST using the server-only service-role key
- Rate limiting and CORS
- Booking conflict protection
- Telegram notification/reminder service

GitHub Pages is only for static frontend files. The API must run on a server host.

## Database

The project already contains a Supabase client and server integration. The shared schema migration is stored in:

`supabase/migrations/20260820100000_avtodrom_core.sql`

Core entities:

`profiles`, `instructors`, `cars`, `bookings`, `lessons`, `notifications`, `reviews`, `audit_logs`

Booking lifecycle:

`pending -> confirmed -> customer_confirmed -> in_progress -> completed`

Terminal states: `rejected`, `cancelled`, `no_show`, `expired`.

Only Admin can approve or reject a pending booking. Instructors can manage only their assigned lessons/bookings.

## No-deposit policy

Booking does not require payment or a deposit. Reliability is handled through customer confirmation, reminders, no-show tracking and admin moderation.

## Notifications

Telegram reminders are generated server-side. The reminder service must never expose the bot token to frontend code.

## Secrets

Never commit:

- `SUPABASE_SERVICE_ROLE_KEY`
- `CUSTOMER_BOT_TOKEN`
- any private signing secret

These belong in the backend hosting provider's secret/environment settings.

## Current rollout

1. Repository structure: complete
2. Shared database schema: added on feature branch
3. Backend foundation: present, needs production credential configuration and final role/admin routes
4. Customer UI: present, needs final API integration verification
5. Instructor UI: present, needs real profile/approval/schedule integration
6. Admin UI: present, needs real admin authentication and management routes
7. Telegram bot: backend hooks present, bot token/webhook or polling configuration still required
8. Reminder scheduler: present, needs production deployment and database credentials
9. End-to-end testing: pending
10. Production deployment: pending

## Important security rule

Frontend visibility is not authorization. Every protected operation must be checked server-side, with ownership checks for customer/instructor resources and Admin-only moderation endpoints.
