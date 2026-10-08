import { telegramApi } from './telegram.js';
import { addDaysYmd } from './instructor-schedule.js';

/**
 * INSTRUKTOR BOTI MENYUSI
 *
 * /start bosilganda pastda doim turadigan tugmalar (katalog) chiqadi:
 *   📅 Bugungi jadvalim   📅 Ertangi jadvalim     — Excel ko'rinishidagi rasm + raqamlar
 *   📋 Bugungi bronlarim  📋 Ertangi bronlarim    — soat va raqam (bosilsa qo'ng'iroq)
 *   ❓ Bron qanday yoziladi
 * Telegram'ning «/» menyusida ham shu buyruqlar bor (/bugun, /ertaga, /bronlarim …).
 */
export const MENU = {
  today: '📅 Bugungi jadvalim',
  tomorrow: '📅 Ertangi jadvalim',
  bookings: '📋 Bugungi bronlarim',
  bookingsTomorrow: '📋 Ertangi bronlarim',
  help: '❓ Bron qanday yoziladi',
} as const;

export const MENU_KEYBOARD = {
  keyboard: [
    [{ text: MENU.today }, { text: MENU.tomorrow }],
    [{ text: MENU.bookings }, { text: MENU.bookingsTomorrow }],
    [{ text: MENU.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Bron: ertaga 14:00 901234567',
};

export const BOT_COMMANDS = [
  { command: 'start', description: 'Bosh menyu' },
  { command: 'bugun', description: 'Bugungi jadvalim (rasm)' },
  { command: 'ertaga', description: 'Ertangi jadvalim (rasm)' },
  { command: 'bronlarim', description: 'Bugungi bronlarim — soat va raqamlar' },
  { command: 'ertangi', description: 'Ertangi bronlarim — soat va raqamlar' },
  { command: 'yordam', description: 'Bron qanday yoziladi' },
];

export type MenuCmd =
  | { kind: 'day'; date: string }
  | { kind: 'bookings'; date: string }
  | { kind: 'help' }
  | { kind: 'menu' };

/**
 * Menyu tugmasi yoki «/» buyrug'ini taniydi. Oddiy bron matni
 * («ertaga 14:00 901234567») — null, uni parseBotText o'qiydi.
 */
export function parseMenu(raw: string, today: string): MenuCmd | null {
  const t = String(raw || '').toLowerCase()
    .replace(/[’'`ʻ‘]/g, "'")
    .replace(/@\w+/g, '')
    .replace(/[^\p{L}\p{N}/'_\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const tomorrow = addDaysYmd(today, 1);
  const map: Array<[RegExp, MenuCmd]> = [
    [/^(\/bugun|bugungi jadval(im)?|\/jadval)$/u, { kind: 'day', date: today }],
    [/^(\/ertaga|ertangi jadval(im)?)$/u, { kind: 'day', date: tomorrow }],
    [/^(\/bronlarim|\/bronlar|bugungi bronlar(im)?|bronlarim)$/u, { kind: 'bookings', date: today }],
    [/^(\/ertangi|\/ertangi_bronlar|ertangi bronlar(im)?)$/u, { kind: 'bookings', date: tomorrow }],
    [/^(\/yordam|\/help|yordam|bron qanday yoziladi)$/u, { kind: 'help' }],
    [/^(\/menu|\/menyu|menyu|menu|katalog|\/katalog)$/u, { kind: 'menu' }],
  ];
  for (const [re, cmd] of map) if (re.test(t)) return cmd;
  return null;
}

/** «/» menyusidagi buyruqlar — har instansiyada bir marta o'rnatiladi */
let commandsSet = false;
export async function ensureBotCommands(token: string): Promise<void> {
  if (commandsSet || !token) return;
  commandsSet = true;
  try {
    await telegramApi(token, 'setMyCommands', { commands: BOT_COMMANDS });
  } catch (e) {
    commandsSet = false;
    console.warn('setMyCommands failed:', e instanceof Error ? e.message : e);
  }
}
export const _resetBotCommands = () => { commandsSet = false; };
