import { supabase } from "../supabase.js";

export async function queueTwoHourReminders() {
  const now = new Date();
  const until = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const { data: bookings, error } = await supabase
    .from("bookings")
    .select("id,user_id,start_at,status")
    .gte("start_at", now.toISOString())
    .lte("start_at", until.toISOString())
    .in("status", ["pending", "confirmed"]);
  if (error) throw error;
  if (!bookings?.length) return 0;

  let created = 0;
  for (const b of bookings) {
    const { data: existing } = await supabase.from("notifications").select("id").eq("booking_id", b.id).eq("type", "two_hour_reminder").maybeSingle();
    if (existing) continue;
    const { error: insertError } = await supabase.from("notifications").insert({ booking_id: b.id, user_id: b.user_id, type: "two_hour_reminder", scheduled_at: b.start_at, status: "pending" });
    if (!insertError) created++;
  }
  return created;
}
