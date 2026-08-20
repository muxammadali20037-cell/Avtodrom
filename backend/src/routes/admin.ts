import type { FastifyInstance } from "fastify";
import { supabase } from "../supabase.js";

function tgId(req: any): string | null {
  return req.headers["x-telegram-init-data"] ? null : null;
}

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/admin/dashboard", async () => {
    const [u, i, c, b] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("instructors").select("id", { count: "exact", head: true }),
      supabase.from("cars").select("id", { count: "exact", head: true }),
      supabase.from("bookings").select("id", { count: "exact", head: true }),
    ]);
    return { users: u.count ?? 0, instructors: i.count ?? 0, cars: c.count ?? 0, bookings: b.count ?? 0 };
  });

  app.get("/api/admin/users", async () => {
    const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
    if (error) throw app.httpErrors.internalServerError(error.message);
    return { users: data ?? [] };
  });

  app.get("/api/admin/instructors", async () => {
    const { data, error } = await supabase.from("instructors").select("*").order("created_at", { ascending: false });
    if (error) throw app.httpErrors.internalServerError(error.message);
    return { instructors: data ?? [] };
  });

  app.patch<{ Params: { id: string }; Body: { status: "approved" | "rejected" | "blocked" } }>("/api/admin/instructors/:id/status", async (req) => {
    const { data, error } = await supabase.from("instructors").update({ status: req.body.status }).eq("id", req.params.id).select().single();
    if (error) throw app.httpErrors.badRequest(error.message);
    return { instructor: data };
  });

  app.get("/api/admin/cars", async () => {
    const { data, error } = await supabase.from("cars").select("*").order("created_at", { ascending: false });
    if (error) throw app.httpErrors.internalServerError(error.message);
    return { cars: data ?? [] };
  });

  app.get("/api/admin/bookings", async () => {
    const { data, error } = await supabase.from("bookings").select("*").order("start_at", { ascending: true });
    if (error) throw app.httpErrors.internalServerError(error.message);
    return { bookings: data ?? [] };
  });
}
