/* AVTODROM INDEX — secure Telegram Mini App auth bridge */
(function () {
  window.AvtodromTelegramAuth = {
    status: "idle",
    user: null,
    error: null,
    ready: null
  };

  function setState(status, user, error) {
    window.AvtodromTelegramAuth.status = status;
    window.AvtodromTelegramAuth.user = user || null;
    window.AvtodromTelegramAuth.error = error || null;
  }

  window.AvtodromTelegramAuth.ready = (async function () {
    try {
      if (!window.AvtodromSupabase?.client) {
        await window.AvtodromSupabase?.ready;
      }

      const tg = window.Telegram?.WebApp;
      if (!tg?.initData) {
        setState("outside_telegram", null, null);
        return null;
      }

      tg.ready();
      tg.expand();

      const client = window.AvtodromSupabase?.client;
      if (!client) throw new Error("Supabase client is not ready");

      setState("authenticating", null, null);

      const { data, error } = await client.functions.invoke("telegram-auth", {
        body: { initData: tg.initData }
      });

      if (error) throw new Error(error.message || "Telegram authentication failed");
      if (!data?.ok || !data?.user) throw new Error(data?.error || "Authentication failed");

      setState("authenticated", data.user, null);
      window.dispatchEvent(new CustomEvent("avtodrom:authenticated", { detail: data }));
      return data;
    } catch (error) {
      console.error("Avtodrom Telegram auth:", error);
      setState("error", null, error?.message || "Authentication failed");
      window.dispatchEvent(new CustomEvent("avtodrom:auth-error", { detail: error }));
      return null;
    }
  })();
})();
