/* AVTODROM INDEX — Supabase client
 * Public/publishable key only. NEVER put service_role/secret keys here.
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://bxgevyghvkuekbwbcsna.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_REVq-3nTJ-SDUEJQmDP7Bw_Xxg5Uqrx';

  const state = {
    url: SUPABASE_URL,
    key: SUPABASE_PUBLISHABLE_KEY,
    client: null,
    ready: null
  };

  window.AvtodromSupabase = state;

  function loadSupabase() {
    return new Promise((resolve, reject) => {
      if (window.supabase && typeof window.supabase.createClient === 'function') {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      script.async = false;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Supabase JS kutubxonasi yuklanmadi.'));
      document.head.appendChild(script);
    });
  }

  state.ready = loadSupabase().then(() => {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('Supabase client kutubxonasi mavjud emas.');
    }
    if (!SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY.includes('PASTE_YOUR_')) {
      throw new Error('Supabase publishable key kiritilmagan.');
    }
    state.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    console.info('[AVTODROM] Supabase client tayyor:', SUPABASE_URL);
    return state.client;
  }).catch((error) => {
    console.error('[AVTODROM] Supabase ulanish xatosi:', error);
    throw error;
  });
})();
