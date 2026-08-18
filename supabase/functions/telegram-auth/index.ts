import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders,
  });
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function verifyTelegramInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date") || 0);
  const userRaw = params.get("user");

  if (!receivedHash || !authDate || !userRaw) {
    throw new Error("Telegram initData incomplete");
  }

  // Reject stale/replayed Mini App payloads.
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < -60 || age > 86400) {
    throw new Error("Telegram initData expired");
  }

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  // Telegram Mini Apps: secret_key = HMAC-SHA256("WebAppData", bot_token)
  const secretKey = await hmacSha256(
    new TextEncoder().encode("WebAppData"),
    botToken,
  );
  const calculated = hex(await hmacSha256(secretKey, dataCheckString));

  if (!constantTimeEqual(calculated, receivedHash)) {
    throw new Error("Invalid Telegram initData signature");
  }

  const user = JSON.parse(userRaw);
  if (!user?.id) throw new Error("Telegram user missing");
  return { user, authDate };
}

function getSecretKey() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      if (keys.default) return keys.default;
    } catch (_) {
      // Fall through to legacy variable.
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const initData = String(body?.initData || "");
    if (!initData) return json({ ok: false, error: "initData required" }, 400);

    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
    if (!botToken) return json({ ok: false, error: "Telegram auth is not configured" }, 503);

    const { user: tgUser } = await verifyTelegramInitData(initData, botToken);

    const secretKey = getSecretKey();
    if (!secretKey) return json({ ok: false, error: "Supabase server secret is not configured" }, 503);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      secretKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const fullName = [tgUser.first_name, tgUser.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() || tgUser.username || `Telegram ${tgUser.id}`;

    const { data, error } = await supabaseAdmin
      .from("users")
      .upsert(
        {
          telegram_id: Number(tgUser.id),
          full_name: fullName,
          role: "customer",
          is_active: true,
          is_blocked: false,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "telegram_id" },
      )
      .select("id, telegram_id, full_name, phone, role, is_active, is_blocked")
      .single();

    if (error) throw error;
    if (data.is_blocked || !data.is_active) {
      return json({ ok: false, error: "Account blocked or inactive" }, 403);
    }

    return json({
      ok: true,
      user: data,
      telegram: {
        id: tgUser.id,
        username: tgUser.username || null,
      },
    });
  } catch (error) {
    console.error("telegram-auth:", error);
    return json({ ok: false, error: error instanceof Error ? error.message : "Authentication failed" }, 401);
  }
});
