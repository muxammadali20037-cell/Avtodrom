/* AVTODROM SHARED CLIENT
 * One small data layer used by all three Mini Apps.
 * Supabase publishable key is safe for browser use; privileged operations stay server-side.
 */
(function () {
  'use strict';

  const state = window.AvtodromSupabase;
  if (!state) throw new Error('supabase-client.js must be loaded first');

  async function client() {
    return state.ready;
  }

  async function currentTelegramUser() {
    const tg = window.Telegram?.WebApp;
    const initData = tg?.initData || '';
    if (!initData) return null;

    const response = await fetch((window.AVTODROM_API_URL || '') + '/api/telegram/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData })
    });
    if (!response.ok) throw new Error('Telegram autentifikatsiyasi muvaffaqiyatsiz.');
    const data = await response.json();
    return data.user || null;
  }

  async function getProfile(telegramId) {
    const db = await client();
    const { data, error } = await db
      .from('profiles')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function createOrUpdateProfile(user, role) {
    const db = await client();
    const payload = {
      telegram_id: user.id,
      role: role || 'customer',
      full_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || '',
      username: user.username || null,
      avatar_url: user.photo_url || null,
      updated_at: new Date().toISOString()
    };
    const { data, error } = await db
      .from('profiles')
      .upsert(payload, { onConflict: 'telegram_id' })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function myBookings(profileId) {
    const db = await client();
    const { data, error } = await db
      .from('bookings')
      .select('*, instructor:instructor_id(full_name,username), car:car_id(plate_number,brand,model)')
      .eq('customer_id', profileId)
      .order('starts_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function instructorBookings(profileId) {
    const db = await client();
    const { data, error } = await db
      .from('bookings')
      .select('*, customer:customer_id(full_name,username,phone), car:car_id(plate_number,brand,model)')
      .eq('instructor_id', profileId)
      .order('starts_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function subscribeToBookings(callback) {
    const db = await client();
    return db.channel('avtodrom-bookings-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, callback)
      .subscribe();
  }

  async function subscribeToNotifications(profileId, callback) {
    const db = await client();
    return db.channel('avtodrom-notifications-' + profileId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'notifications', filter: 'profile_id=eq.' + profileId
      }, callback)
      .subscribe();
  }

  window.AvtodromAPI = {
    currentTelegramUser,
    getProfile,
    createOrUpdateProfile,
    myBookings,
    instructorBookings,
    subscribeToBookings,
    subscribeToNotifications
  };
})();
