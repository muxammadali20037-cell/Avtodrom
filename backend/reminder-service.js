/**
 * AVTODROM — reminder scheduling service
 * No payments/deposits. Reminders are delivered through Telegram + in-app notifications.
 *
 * This module is intentionally provider-agnostic: wire sendTelegram() to the existing
 * Telegram bot transport and createInAppNotification() to Supabase in the server.
 */
'use strict';

const REMINDER_MINUTES = [120, 60, 30, 10];

function reminderTimes(startAt) {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw new Error('Invalid booking start time');
  return REMINDER_MINUTES.map((minutes) => ({
    type: `booking_${minutes}m`,
    sendAt: new Date(start.getTime() - minutes * 60_000)
  }));
}

function buildReminder(booking, minutes) {
  return {
    title: minutes === 120 ? 'Mashg‘ulotingiz yaqinlashmoqda' : 'Mashg‘ulot eslatmasi',
    body: `Sizning mashg‘ulotingiz ${minutes} daqiqadan keyin boshlanadi.`,
    bookingId: booking.id,
    minutes,
    startAt: booking.start_at,
    channels: ['telegram', 'in_app']
  };
}

async function processDueReminders({ bookings, now = new Date(), sendTelegram, createInAppNotification }) {
  const due = [];
  for (const booking of bookings || []) {
    if (booking.status !== 'confirmed') continue;
    for (const minutes of REMINDER_MINUTES) {
      const sendAt = new Date(new Date(booking.start_at).getTime() - minutes * 60_000);
      if (sendAt <= now && now.getTime() - sendAt.getTime() < 90_000) {
        const payload = buildReminder(booking, minutes);
        if (typeof createInAppNotification === 'function') {
          await createInAppNotification(booking.user_id, payload);
        }
        if (typeof sendTelegram === 'function' && booking.telegram_id) {
          await sendTelegram(booking.telegram_id, `${payload.title}\n\n${payload.body}`);
        }
        due.push(payload);
      }
    }
  }
  return due;
}

module.exports = { REMINDER_MINUTES, reminderTimes, buildReminder, processDueReminders };
