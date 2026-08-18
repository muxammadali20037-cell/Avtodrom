# Backend

Recommended production stack:

- Node.js + TypeScript
- Fastify or Express
- PostgreSQL
- Prisma or Drizzle ORM
- Zod request validation
- JWT/access + refresh sessions or secure server sessions
- Telegram Bot API integration
- Background scheduler/queue for reminders

Required modules:

`auth`, `users`, `customers`, `instructors`, `bookings`, `reviews`, `notifications`, `reliability`, `audit`, `settings`.

Critical rules:

1. Only Admin can approve/reject pending bookings.
2. Instructor can access only own bookings and permitted customer fields.
3. Instructor cannot access individual/private reviews.
4. Customer can access only own bookings/profile.
5. Review approval is Admin-only.
6. Deposit is not required for booking.
7. No-show/reliability policy replaces deposit as the primary attendance control.
8. All sensitive actions are audited.
9. API responses must omit unauthorized sensitive fields.
10. All resource IDs require ownership/permission checks.
