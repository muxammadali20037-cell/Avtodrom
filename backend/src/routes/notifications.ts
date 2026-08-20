import type { FastifyInstance } from "fastify";
import { supabase } from "../supabase.js";

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/api/notifications/pending", async () => {
    const { data, error } = await supabase.from("notifications").select("*").eq("status", "pending").lte("scheduled_at", new Date().toISOString()).order("scheduled_at", { ascending: true });
    if (error) throw app.httpErrors.internalServerError(error.message);
    return { notifications: data ?? [] };
  });

  app.post<{ Params: { id: string } }>("/api/notifications/:id/mark-sent", async (req) => {
    const { data, error } = await supabase.from("notifications").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", req.params.id).select().single();
    if (error) throw app.httpErrors.badRequest(error.message);
    return { notification: data };
  });
}
