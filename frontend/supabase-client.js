/* AVTODROM INDEX — Supabase client foundation
 * Keep the Supabase publishable/anon key here only.
 * NEVER put service_role/secret keys in this file.
 */
(function () {
  const SUPABASE_URL = 'https://izmonnkzyolaqwjwjvzj.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE';

  const load = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  window.AvtodromSupabase = {
    url: SUPABASE_URL,
    key: SUPABASE_PUBLISHABLE_KEY,
    client: null,
    ready: null
  };

  window.AvtodromSupabase.ready = load('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2')
    .then(() => {
      if (SUPABASE_PUBLISHABLE_KEY.includes('PASTE_YOUR_')) {
        console.warn('Supabase publishable key hali kiritilmagan.');
        return null;
      }
      window.AvtodromSupabase.client = window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false
          }
        }
      );
      return window.AvtodromSupabase.client;
    });
})();
