/* =========================================================================
   AI YORDAMCHI — xodimlar uchun dastur qo‘llanmasi (kassa, operator, admin).
   Internetga, AI xizmatiga va bazaga ULANMAYDI: savolni shu qo‘llanmadan
   qidirib, qadam-baqadam tushuntiradi. Aniq ma’lumot (summa, mijoz telefoni,
   parol, hisobot raqamlari) so‘ralsa — «Adminga qo‘ng‘iroq qiling».
   Kirill, lotin, ruscha va xato yozuvni tushunadi (chqarish, qanqlb, otmen).

   Yangi mavzu qo‘shish: KB ga yangi yozuv — t (sarlavha), r (kimlar uchun),
   k (kalit so‘zlar — so‘z o‘zagi yetarli: «chiqar», «bekor»), a (javob),
   w (qayerda), go (panel bo‘limi).
   ========================================================================= */

const KASSA = ['cashier', 'admin'];
const DESK = ['operator', 'admin'];
const ADMIN = ['admin'];
const ALL = ['cashier', 'operator', 'admin'];

export const ADMIN_CALL = 'Bu ma’lumotni men bera olmayman — 📞 Adminga qo‘ng‘iroq qiling.';

export const KB = [
  /* ------------------------------- KASSA ------------------------------- */
  { id: 'chek-chiqarish', r: KASSA, go: 'issue', w: 'Kassa → Chek chiqarish',
    t: 'Chek qanday chiqariladi',
    k: ['chek chiqar', 'chek ber', 'chek yoz', 'yangi chek', 'kvitansiya', 'kvitok', 'chek sot', 'pul ol', 'to‘lov ol', 'sotish', 'chek chop'],
    a: `1. Yon menyuda «Chek chiqarish» (yoki tepadagi yashil «+ Chek chiqarish») ni bosing.
2. Mijoz: ism familiyasini yozing, telefon ixtiyoriy. Bron bilan kelgan bo‘lsa — qidiruvga bron kodi (AVD-1234), ism yoki telefonni yozing.
3. Toifa (A, B, C) va Davomiylikni tanlang: 1 krug, 30 daqiqa, 1 soat, 1,5 soat, 2 soat, 3 soat yoki 5 soatlik paket.
4. Vaqt tanlanmaydi — bronsiz chek hozirgi vaqt bilan chiqadi.
5. Instruktor ixtiyoriy: tanlamasangiz «Instruktorsiz — kim ursa» bo‘ladi.
6. To‘lov: Naqd, Karta yoki Aralash.
7. Yashil «Chek chiqarish» → «Chek tayyor» oynasida «Chop etish».
Klaviatura: Enter — bron kodi bilan topish, F2 — yangi chek.` },

  { id: 'bron-tolov', r: KASSA, go: 'issue', w: 'Kassa → Chek chiqarish → qidiruv',
    t: 'Bron bilan kelgan mijozdan to‘lov olish',
    k: ['bron bilan kel', 'bron kod', 'avd', 'oldindan bron', 'ilovadan bron', 'bron to‘lov', 'bron qilgan mijoz', 'bronni to‘la', 'bron bo‘yicha', 'kassa kod'],
    a: `1. Chek chiqarishda qidiruv maydoniga bron kodini (AVD-1234), mijoz ismi yoki telefonini yozing (Enter).
2. Ro‘yxatdan kerakli bronni tanlang — vaqt va instruktor bron bo‘yicha qo‘yiladi.
3. To‘lov turini tanlab, «Chek chiqarish».
Ilovadagi 5 soatlik paket bo‘lsa — «Butun paketni to‘lash»: har mashg‘ulotga alohida chek chiqadi.
Mijoz bronini aytmasa ham oddiy (bronsiz) chek chiqarsangiz bo‘ladi — chek urilganda shu vaqtdagi bron o‘zi bo‘shatiladi.` },

  { id: 'paket', r: KASSA, go: 'issue', w: 'Kassa → Chek chiqarish → Davomiylik',
    t: '5 soatlik paket',
    k: ['5 soat', 'besh soat', 'paket', '1100000', '1 100 000', '5 ta chek', 'paket chek', '220000'],
    a: `Faqat B toifa. Davomiylikda «5 soatlik paket» (standart 1 100 000 so‘m) tanlansa — 5 ta alohida 1 soatlik OCHIQ chek chiqadi (har biri 220 000).
• Kun va instruktor tanlanmaydi: mijoz istalgan kuni keladi, istalgan instruktor chekni uradi.
• Dars chek urilgan paytdan boshlanadi, 1 soat.
• Muddati yo‘q — urilguncha yaroqli.
• 5 ta chekni ham chop etib, mijozga bering.` },

  { id: 'ochiq-chek', r: ALL, go: 'receipts', w: 'Kassa → Cheklar',
    t: 'Chek muddati va «Ochiq chek»',
    k: ['ochiq chek', 'istalgan kun', 'muddat', 'yaroqli', 'eskir', 'qachongacha', 'kuyib ket', 'yonib ket', 'amal qil', 'kelmadi bo‘lib qol', 'ertaga kelsa', 'boshqa kuni kel'],
    a: `To‘langan chek URILGUNCHA yaroqli — muddati yo‘q, o‘zi «Kelmadi» bo‘lib yopilmaydi.
«Ochiq chek · istalgan kun» — kuni yo‘q chek (5 soatlik paketdan yoki bo‘lingan chekdan). Istalgan instruktor istalgan kuni uradi, dars o‘sha paytdan boshlanadi.
Mijoz bugun kelmasa — chek ertaga ham, keyin ham ishlaydi.` },

  { id: 'test-drive', r: KASSA, go: 'issue', w: 'Kassa → Chek chiqarish → tepada «Test drive»',
    t: 'Test drive',
    k: ['test drive', 'testdrive', 'test drayv', 'тест драйв', 'sinov haydash', '130000', '130 000'],
    a: `1. Chek chiqarish sahifasining eng tepasidagi «Test drive» tugmasini bosing.
2. Chek faqat «1 krug» bo‘ladi: Davomiylik va Vaqt yo‘qoladi, narx — 1 krug + test drive (80 000 + 50 000 = 130 000 so‘m).
3. Mijoz ismi, to‘lov → «Chek chiqarish».
• Instruktor hisobotiga 15 daqiqa yoziladi.
• Chekda «1 krug» va «Test drive» alohida qatorda.
• Kassa hisobotida test drive soni va summasi alohida.
• Bron to‘lovida test drive yo‘q. Narxini admin «Narxlar va ish vaqti»da o‘zgartiradi.` },

  { id: 'krug', r: KASSA, go: 'issue', w: 'Kassa → Chek chiqarish → Davomiylik',
    t: '1 krug',
    k: ['krug', 'aylana', 'bir aylana', '1 krug', '15 daqiqa', '80000', '80 000', 'круг'],
    a: `Davomiylikda «1 krug» — avtodrom bo‘ylab bitta aylana: standart 15 daqiqa, 80 000 so‘m. Bronsiz, hozirdan.
Narx va daqiqani admin «Narxlar va ish vaqti → 1 krug»da sozlaydi (0 — o‘chiq).` },

  { id: 'narx-ozgartirish', r: KASSA, go: 'issue', w: 'Chek chiqarish → To‘lov → «Narxni o‘zgartirish (maxsus parol)»',
    t: 'Chekda narxni o‘zgartirish (chegirma)',
    k: ['narx o‘zgartir', 'narxni o‘zgartir', 'summa o‘zgartir', 'chegirma', 'skidka', 'скидка', 'arzon', 'boshqa summa', 'narxni tushir', 'kam pul', 'maxsus parol kirit', 'narx parol'],
    a: `1. To‘lov bo‘limida «Narxni o‘zgartirish (maxsus parol)» ni bosing.
2. Maxsus parolni kiriting → yangi summani yozing.
3. «Chek chiqarish».
• Ruxsat 15 daqiqa ochiq turadi, keyin narx avtomatik narxga qaytadi.
• Kim o‘zgartirgani tarixga yoziladi.
Maxsus parolni bilmasangiz — adminga qo‘ng‘iroq qiling.` },

  { id: 'aralash', r: KASSA, go: 'issue', w: 'Chek chiqarish → To‘lov',
    t: 'Naqd, karta yoki aralash to‘lov',
    k: ['aralash', 'naqd va karta', 'yarmi karta', 'terminal', 'karta bilan', 'plastik', 'naqd pul', 'ikkalasi', 'uzcard', 'humo'],
    a: `To‘lov bo‘limida: «Naqd», «Karta» (terminal) yoki «Aralash».
Aralashda naqd summani yozing — qolgani karta bo‘lib o‘zi hisoblanadi. Naqd + karta jami summaga teng bo‘lishi shart.` },

  { id: 'qayta-chop', r: KASSA, go: 'receipts', w: 'Kassa → Cheklar → chek → «Qayta chop etish»',
    t: 'Chekni qayta chop etish',
    k: ['qayta chop', 'qayta chiqar', 'chekni yana', 'nusxa', 'pechat', 'печать', 'print', 'chop et', 'yo‘qot', 'chekni yo‘qot', 'chek yo‘qoldi', 'printer', 'qayta ber'],
    a: `1. Kassa → Cheklar.
2. Chekni toping: qidiruvga kod, mijoz ismi, telefon yoki instruktor ismini yozing (kerak bo‘lsa davrni o‘zgartiring).
3. Chekni bosing → «Qayta chop etish».
P1 va P2 bir-birining chekini ham chop eta oladi — «Hammasi (P1 + P2)» tanlangan bo‘lsin.` },

  { id: 'chek-bekor', r: KASSA, go: 'receipts', w: 'Kassa → Cheklar → chek → «Chekni bekor qilish»',
    t: 'Chekni bekor qilish (pul qaytarish)',
    k: ['chekni bekor', 'chek bekor', 'chek otmen', 'chek atmen', 'otmen qil', 'otmen', 'atmen', 'otmena', 'отмен', 'pul qaytar', 'xato chek', 'ikki marta', 'voz kech', 'chekni o‘chir', 'annul', 'vozvrat', 'возврат', 'qaytarib ber'],
    a: `1. Kassa → Cheklar → chekni bosing.
2. «Chekni bekor qilish» → sababni tanlang: «Xato chek chiqarildi», «Mijoz voz kechdi, pul qaytarildi» yoki «Ikki marta chiqarildi».
3. Kassir maxsus parolni kiritadi.
• Faqat hali ishlatilmagan (Faol) yoki «Kelmadi» chek bekor bo‘ladi.
• Kassir — faqat o‘z kassasidagi va oxirgi 12 soatdagi chekni. Eskisini — administrator.
• Bekor qilingan chek summasi kassa hisobotidan chiqadi.` },

  { id: 'chek-bolish', r: KASSA, go: 'receipts', w: 'Kassa → Cheklar → chek → «5 ta 1 soatlik chekka bo‘lish»',
    t: '5 soatlik bitta chekni 5 taga bo‘lish',
    k: ['bo‘lish', '5 ga bo‘l', '5 taga', 'bitta chek 5 soat', 'chekni bo‘l', 'ajrat', 'eski paket'],
    a: `Eski 5 soatlik BITTA chek bo‘lsa: Cheklar → chekni bosing → «5 ta 1 soatlik chekka bo‘lish» → maxsus parol.
Natija: 5 ta ochiq chek (istalgan kun, istalgan instruktor). Summa va to‘lov kuni o‘zgarmaydi.` },

  { id: 'cheklar', r: KASSA, go: 'receipts', w: 'Kassa → Cheklar · jami tushum — Hisobot’da',
    t: 'Cheklar bo‘limi',
    k: ['cheklar', 'chek qidir', 'chekni top', 'faol', 'ishlatilgan', 'kecha cheklari', 'chek ro‘yxat', 'qaysi chek', 'chek holati', 'p2 cheklari', 'p1 cheklari'],
    a: `Kassa → Cheklar:
• Tepada davr: Kun, Hafta, Oy, Yil, Oraliq (strelkalar bilan oldinga-orqaga).
• «Hammasi (P1 + P2)» yoki «Faqat P1».
• Qidiruv: kod, ism, telefon, instruktor.
• Holatlar: Faol — hali urilmagan; Ishlatilgan — dars bo‘lgan; Kelmadi; Bekor — pul qaytarilgan.
• Chekni bosing — tafsilot, qayta chop etish, bekor qilish.
• Har chekning summasi ko‘rinadi, JAMI tushum esa — faqat «Hisobot» bo‘limida (maxsus parol bilan).` },

  { id: 'p1-p2', r: ALL, go: 'receipts', w: 'Yon menyu → Kassa',
    t: 'P1 va P2 kassalar',
    k: ['p1', 'p2', 'birinchi kassa', 'ikkinchi kassa', 'boshqa kassa', 'kassa almash', 'qaysi kassa', 'kassani tanla'],
    a: `Kassir login bilan kirganda o‘z kassasiga (P1 yoki P2) ulanadi.
• Cheklar: ikkala kassaning cheklari ko‘rinadi va qayta chop etiladi.
• Bekor qilish va bo‘lish — faqat o‘z kassasida.
• Tushum va hisobotlar — «Hisobot» bo‘limida, maxsus parol bilan: Jami (P1 + P2), P1 va P2 alohida-alohida.
Administrator yon menyudagi «P1 / P2» tugmasi bilan kassani tanlaydi.` },

  { id: 'jarayonda', r: KASSA, go: 'live', w: 'Kassa → Jarayonda',
    t: 'Jarayonda: kim darsda, kim tugatdi',
    k: ['jarayonda', 'kim darsda', 'hozir darsda', 'qancha qoldi', 'dars ketyapti', 'tugagan', 'yopilmagan', 'kim tugatdi', 'bugun tugagan', 'urilgan vaqt'],
    a: `Kassa → Jarayonda, 3 bo‘lim:
• «Jarayonda» — hozir darsdagilar va qolgan daqiqa (10 daqiqadan kam — qizil).
• «Tugagan» — tanlangan kunda (Bugun, Kecha yoki sana) tugagan darslar: mijoz, instruktor, chek urilgan va tugagan vaqt, summa.
• «Yopilmagan» — vaqti 2 soatdan oshib ketgan darslar.` },

  { id: 'dars-tugatish', r: ALL, go: 'live', w: 'Kassa → Jarayonda → «Darsni tugatish»',
    t: 'Darsni tugatish / vaqt tugadi',
    k: ['darsni tugat', 'yakunla', 'dars tugamadi', 'yopilmadi', 'vaqt tugadi', 'oshib ket', 'finish', 'tugatish', '+42', 'vaqti o‘tdi'],
    a: `Dars vaqti tugashi bilan tizim uni O‘ZI yopadi (1 daqiqa ichida) — hech narsa qilish shart emas.
Oldinroq tugatish:
• Kassa → Jarayonda → kerakli dars → «Darsni tugatish» (tugash vaqti — hozir, tarixga yoziladi).
• Instruktor o‘z ilovasida «Yakunlash» tugmasi.
Instruktor ilovasida «vaqt tugadi» qolib ketsa — ilovani yopib, bot orqali qayta ochsin.` },

  { id: 'kassa-hisoboti', r: KASSA, go: 'report', w: 'Hisobot → Kassa hisoboti (maxsus parol bilan)',
    t: 'Kassa hisoboti',
    k: ['kassa hisobot', 'hisobotni qayerda', 'kunlik hisobot', 'smena hisobot', 'naqd va karta qayerda', 'hisobot qanday', 'oylik hisobot qayerda'],
    a: `Yon menyu → «Hisobot» → Kassa hisoboti. Avval maxsus parol so‘raladi (15 daqiqa amal qiladi, keyin o‘zi qulflanadi).
• Tepada: «Jami (P1 + P2)», «P1», «P2» — alohida-alohida.
• Davr: Kun, Hafta, Oy, Yil yoki Oraliq.
• Tushum, naqd, karta, cheklar soni, soatlar, mijozlar; oldingi davr bilan solishtirish.
• Soatlar bo‘yicha grafik, toifalar, instruktorlar; test drive alohida.
• Pul qaytarilgan cheklar hisobga olinmaydi.` },

  { id: 'hisobot', r: KASSA, go: 'hisobot', w: 'Yon menyu → Hisobot (maxsus parol bilan)',
    t: 'Hisobot bo‘limi: tushum qayerda',
    k: ['tushum qayerda', 'umumiy hisobot', 'jami tushum', 'hisobot bo‘lim', 'tushum ko‘rinmayapti', 'tushum yo‘q', 'summa ko‘rinmayapti', 'jami summa', 'hisobot qulf', 'hisobot parol', 'qulflash'],
    a: `Tushum (pul) endi Bosh sahifa va Cheklar’da ko‘rinmaydi — hammasi yon menyudagi «Hisobot» bo‘limida:
• Umumiy hisobot — P1 + P2 + platniy: jami va har biri alohida.
• Kassa hisoboti — Jami, P1, P2.
• Instruktorlar hisoboti — kim nechta o‘quvchi haydadi.
• Platniy hisoboti — avtodrom12 (vaqt ochib kiradigan mashinalar).
Kirishda maxsus parol so‘raladi (kassir ham, administrator ham). 15 daqiqadan keyin o‘zi qulflanadi; «Qulflash» bilan darhol yopiladi.
Parolni bilmasangiz — adminga qo‘ng‘iroq qiling.` },

  { id: 'platniy', r: KASSA, go: 'platniy', w: 'Hisobot → Platniy hisoboti (maxsus parol bilan)',
    t: 'Platniy hisoboti (avtodrom12)',
    k: ['platniy', 'platni', 'platnoy', 'платный', 'avtodrom12', 'avtodrom 12', 'vaqt ochib', 'post', '1-post', '2-post'],
    a: `Hisobot → Platniy hisoboti (maxsus parol bilan): avtodrom12 dagi oddiy mijozlar — vaqt ochib kiradigan mashinalar.
• Tushum, kirishlar soni, mashinalar, o‘rtacha chek va vaqt.
• To‘lov usullari: naqd, terminal, Click.
• Postlar (1-POST, 2-POST): kim qancha olgan.
• Soatlar va kunlar bo‘yicha tushum, qarzlar, eng ko‘p to‘lagan mashinalar.
Umumiy hisobotda platniy P1 va P2 bilan birga — jami va alohida ko‘rinadi.` },

  { id: 'instruktorlar-nazorati', r: KASSA, go: 'nazorat', w: 'Kassa → Instruktorlar nazorati',
    t: 'Kim bo‘sh, kim qachon bo‘shaydi',
    k: ['bo‘sh instruktor', 'kim bo‘sh', 'qachon bo‘sha', 'instruktorlar nazorat', 'tez bo‘sha', 'kimga beray', 'qaysi instruktor bo‘sh', 'instruktor qani'],
    a: `Kassa → Instruktorlar nazorati — eng tez bo‘shaydigani tepada:
• «Bo‘sh · hozir» (yashil) — darhol mijoz berish mumkin.
• Darsdagilar — bo‘shash vaqti va qancha qoldi.
• Tanaffusdagilar, ishni boshlamaganlar; bugun ishlamaydiganlar pastda.
Ro‘yxat o‘zi yangilanib turadi.` },

  { id: 'instruktorlar-hisoboti', r: ALL, go: 'insrep', w: 'Hisobot → Instruktorlar hisoboti (maxsus parol bilan)',
    t: 'Instruktorlar hisoboti va Excel',
    k: ['instruktor hisobot', 'instruktorlar hisobot', 'kim nechta dars', 'excel yuklab', 'excel fayl', 'shkola', 'avtoshkola dars', 'pullik dars', 'instruktor soat'],
    a: `Hisobot → Instruktorlar hisoboti (maxsus parol bilan). Tepada «Jami (P1 + P2)», «P1», «P2». Davr tanlanadi, har instruktor — darslar soni, avtoshkola va pullik, soatlar, summa.
Instruktorni bosing — uning darslari, kunlari, o‘quvchilari.
«Excel · hammasi» yoki «Excel · shu instruktor» — faylga yuklab olish.` },

  { id: 'jadval', r: ALL, go: 'schedule', w: 'Instruktorlar jadvali',
    t: 'Instruktorlar jadvali',
    k: ['jadval', 'bandlik', 'kim band', 'band soat', 'ertangi bron', 'bugungi bron', 'soatlar', 'raspisanie', 'расписание'],
    a: `Instruktorlar jadvali: kunni tanlang — har instruktor qatorida band soatlar: bronlar, Excel yozuvlari, instruktor o‘zi yopgan soatlar, tanaffus va dam olish.
Bo‘sh soatni bosib bron qilish mumkin (operator va admin).` },

  { id: 'excel-bron', r: ALL, go: 'xbron', w: 'Excel bron',
    t: 'Excel bron — jadvalga yozish',
    k: ['excel', 'eksel', 'excel bron', 'excel yoz', 'katak', 'jadvalga yoz', 'raqam yoz', 'band yoz', 'yacheyka', 'ячейка'],
    a: `Excel bron: ustunlar — instruktorlar, qatorlar — soatlar (6:00–21:00), har kun alohida.
• Katakka telefon raqam yozilsa — haqiqiy bron (AVD kodi bilan, tasdiqlangan).
• Ketma-ket soatlarga bir xil raqam — bitta uzun bron.
• «/A», «/C» — toifa; «30 MIN» — yarim soat; «avtomat» — avtomat mashina.
• Raqamsiz yozuv (BAND, ism, izoh) — faqat soat band bo‘ladi, bron yaratilmaydi.
• Katakni o‘chirsangiz yoki raqamni almashtirsangiz — eski bron bekor bo‘ladi.
• Boshlanib ketgan soatga yangi bron yozilmaydi — mijoz kelgan bo‘lsa kassada chek bering.
Saqlash: «Saqlash» yoki Ctrl+S; Ctrl+Z — qaytarish; Excel’dan nusxa qo‘yish ham ishlaydi.` },

  { id: 'avtomat', r: ALL, go: 'xbron', w: 'Excel bron · Nazorat paneli · instruktor boti',
    t: 'Avtomat mashina',
    k: ['avtomat', 'akpp', 'автомат', 'aftomat', 'avtomat mashina', 'avtomatik korobka'],
    a: `Avtodromda bitta avtomat mashina bor — bir vaqtda faqat bitta bron.
Bron qilish: Excel bronda katakka raqam bilan «avtomat» yozing (yoki «Mashina: 🚗 Avtomat» tugmasi), Nazorat panelida «Mashina: Avtomat», instruktor botida «ertaga 14:00 901234567 avtomat».
Band bo‘lsa — kimda ekanini aytadi. Narx mexanika bilan bir xil. Mini App va kassada avtomat tanlanmaydi.` },

  { id: 'boshlangan-soat', r: ALL, go: 'xbron', w: 'Excel bron · instruktor boti',
    t: 'Boshlanib ketgan soatga bron',
    k: ['boshlangan soat', 'boshlanib ket', 'o‘tib ketgan soat', 'kech yoz', 'bron yaratilmadi', '14:10'],
    a: `Soat boshlanib ketgan bo‘lsa (masalan 14:10 da 14:00 ga), Excel bron va instruktor boti yangi bron yaratmaydi — «boshlanib ketgan» deb yozadi, katak faqat band bo‘ladi.
Mijoz kelgan bo‘lsa — kassada hozirgi vaqtdan chek bering.` },

  { id: 'chek-har-doim', r: ALL, go: 'receipts', w: 'Qoida',
    t: 'Shu vaqtda bron bo‘lsa ham chek uriladi',
    k: ['boshqa bron bor', 'broni bor', 'vaqt band', 'chek urilmayapti bron', 'soat 9 da bron', 'ustma-ust', 'bron to‘qnash', 'vaqt bo‘shatildi'],
    a: `To‘langan chek har doim uriladi. Shu instruktor yoki shu o‘quvchida shu vaqtga to‘lanmagan bron bo‘lsa — u o‘zi bo‘shatiladi (bekor qilinadi), instruktorga «Shu vaqtdagi bron bo‘shatildi» deb chiqadi.
Boshqa instruktorga yozilgan to‘langan chek instruktorsiz bo‘lib qoladi — uni istalgan instruktor uradi.` },

  /* ----------------------------- BRONLAR ----------------------------- */
  { id: 'yangi-bronlar', r: DESK, go: 'bookings/new', w: 'Bronlar → Yangi bronlar',
    t: 'Yangi bronlarni tasdiqlash',
    k: ['yangi bron', 'tasdiqla', 'rad et', 'kutilmoqda', 'pending', 'bron tasdiq', 'bronni qabul', 'otkaz'],
    a: `Bronlar → Yangi bronlar: tasdiq kutayotgan bronlar.
Bronni bosing → «Tasdiqlash» yoki «Rad etish». Bir mijozning bir nechta broni guruhlanadi — hammasini birga tasdiqlash mumkin.
Mini App bronlari odatda o‘zi tasdiqlanadi (admin sozlamasi «Ilovadagi bronlar avtomatik tasdiqlanadi»). Mijozga Telegram’da xabar boradi.` },

  { id: 'bekor-sorovlari', r: DESK, go: 'bookings/cancels', w: 'Bronlar → Bekor so‘rovlari',
    t: 'Mijozning bekor qilish so‘rovi',
    k: ['bekor so‘rov', 'bekor qilmoqchi', 'mijoz bekor', 'otmen so‘rov', 'bronni bekor qil', 'bron bekor'],
    a: `Bronlar → Bekor so‘rovlari: mijoz ilovada bekor qilishni so‘ragan bronlar (sababi bilan).
Bronni oching → «Bekor qilish» (bron bekor bo‘ladi) yoki «Rad etish» (bron qoladi).
Avto-tasdiqlangan, to‘lanmagan va boshlanmagan bronni mijoz o‘zi darhol bekor qila oladi — u so‘rovga tushmaydi.` },

  { id: 'barcha-bronlar', r: DESK, go: 'bookings/all', w: 'Bronlar → Barcha bronlar',
    t: 'Barcha bronlar: qidirish va holat',
    k: ['barcha bron', 'bron qidir', 'bronni top', 'bron holati', 'kelmadi belgila', 'tugadi belgila', 'qayta och', 'bron tarixi'],
    a: `Bronlar → Barcha bronlar: kun va holat bo‘yicha ro‘yxat, qidiruv.
Bronni oching — mijoz, vaqt, instruktor, to‘lov. Holatni o‘zgartirish tugmalari: Tasdiqlash, Rad etish, Tugadi, Kelmadi, Bekor qilish.
Administrator noto‘g‘ri «Kelmadi»/«Bekor» bronni «Qayta ochish» bilan tiklaydi.` },

  { id: 'qolda-bron', r: DESK, go: 'manual', w: 'Bronlar → Qo‘lda bron',
    t: 'Telefon orqali bron (qo‘lda bron)',
    k: ['qo‘lda bron', 'telefon orqali bron', 'bron qil', 'yangi bron qil', 'zapis', 'запис', 'operator bron', 'bron yarat', 'mijozni yoz', 'oldindan yoz'],
    a: `1. Bronlar → Qo‘lda bron.
2. Mijoz telefoni va ismi.
3. Toifa → Davomiylik → Kun va vaqt (faqat bo‘sh vaqtlar chiqadi) → Instruktor.
4. «Bronni saqlash».
Bron tasdiqlangan holda AVD kodi bilan yaratiladi, instruktorga xabar boradi. Mijoz kassada shu kodni aytadi.` },

  { id: 'chat', r: DESK, go: 'chat', w: 'Bronlar → Mijozlar chati',
    t: 'Mijozlar chati va avto-javob',
    k: ['chat', 'mijozlar chat', 'mijoz yozdi', 'javob ber', 'mijoz savol', 'avto-javob', 'avto javob', 'bot javob', 'o‘rgat'],
    a: `Bronlar → Mijozlar chati: mijozlar Mini App «Yordam»ga yoki botga yozgan xabarlar. Mijozni tanlab javob yozing.
Oddiy savollarga (narx, manzil, ish vaqti, bron) bot o‘zi javob beradi; bilmasa — chatga tushadi.
«🤖 Avto-javob» oynasi: yoqish/o‘chirish, sinab ko‘rish, savol-javob qo‘shish. Javob yozayotganda «🤖 Avto-javobga o‘rgatish» belgisi — bot keyin shunday savolga o‘zi javob beradi.` },

  /* ------------------------------ BOSHQARUV ------------------------------ */
  { id: 'narxlar', r: ADMIN, go: 'prices', w: 'Boshqaruv → Narxlar va ish vaqti',
    t: 'Narxlar, ish vaqti va sozlamalar',
    k: ['narxlar', 'tarif', 'soatlik narx', 'narx qo‘y', 'narxni almashtir', 'ish vaqti', '30 daqiqa narx', '3 soat narx', 'paket narx', 'krug narx', 'test drive narx', 'avto-tasdiq', 'avtomatik tasdiq'],
    a: `Boshqaruv → Narxlar va ish vaqti (faqat administrator):
• A, B, C toifalar: 30 daqiqa, 1 soat, 3 soatlik tarif.
• 5 soatlik paket (B), 1 krug (narx va daqiqa), Test drive narxi (0 — o‘chiq).
• Ish boshlanishi va tugashi, eslatma vaqtlari, kechikish qoidasi.
• «Ilovadagi bronlar avtomatik tasdiqlanadi».
O‘zgarish «Saqlash» bosilganda hammaga (Mini App, kassa, bot) birdan ta’sir qiladi.
Xuddi shu narxlarni Kengaytirilgan panel → Sozlamalar’da ham o‘zgartirish mumkin.` },

  { id: 'maxsus-parol', r: ALL, go: 'prices', w: 'Boshqaruv → Narxlar va ish vaqti → Narx paroli',
    t: 'Maxsus parol nima',
    k: ['maxsus parol', 'narx paroli', 'parol qayerda', 'parolni o‘zgartir', 'parol qo‘y'],
    a: `Maxsus parol (narx paroli) kassada to‘rtta ishga kerak: «Hisobot» bo‘limini ochish (tushum, kassa va instruktorlar hisoboti, platniy), narxni o‘zgartirish, chekni bekor qilish va 5 soatlik chekni bo‘lish. Bir marta kiritilsa 15 daqiqa amal qiladi.
Uni faqat administrator «Narxlar va ish vaqti» bo‘limida qo‘yadi va almashtiradi. Parolning o‘zini bilmasangiz — adminga qo‘ng‘iroq qiling.` },

  { id: 'xodimlar', r: ADMIN, go: 'staff', w: 'Boshqaruv → Xodimlar',
    t: 'Xodim qo‘shish (kassir, operator)',
    k: ['xodim qo‘sh', 'kassir qo‘sh', 'operator qo‘sh', 'yangi xodim', 'yangi kassir', 'login yarat', 'xodim parol', 'xodimni o‘chir', 'kassir parol', 'rol'],
    a: `Boshqaruv → Xodimlar → «Yangi xodim»:
1. Ism familiya, login, parol (kamida 4 belgi).
2. Rol: Kassir, Operator yoki Admin. Kassir uchun kassa (P1 yoki P2).
3. «Qo‘shish» — login va parolni xodimga bering.
Xodimni bosib parolini almashtirish yoki o‘chirib qo‘yish mumkin.` },

  { id: 'instruktorlar', r: ADMIN, go: 'instructors', w: 'Boshqaruv → Instruktorlar',
    t: 'Instruktorlar va arizalar',
    k: ['instruktor qo‘sh', 'ariza', 'instruktorni o‘chir', 'blokla', 'nofaol', 'yangi instruktor', 'instruktor tasdiq', 'instruktor ro‘yxat'],
    a: `Boshqaruv → Instruktorlar: faol va o‘chirilgan instruktorlar, yangi arizalar.
Instruktor instruktor botida ariza yuboradi → admin shu yerda «Tasdiqlash» qiladi — instruktor ilovaga kira boshlaydi.
Instruktorni bosib toifa, mashina, rasm, holatni o‘zgartirish yoki o‘chirish mumkin.` },

  { id: 'ish-grafigi', r: ADMIN, go: 'grafik', w: 'Boshqaruv → Ish grafigi',
    t: 'Instruktorlar ish grafigi',
    k: ['ish grafig', 'grafik', 'dam olish', 'tanaffus', 'ishga kel', 'ishlamaydi', 'ta’til', 'otpusk', 'выходной'],
    a: `Boshqaruv → Ish grafigi (faqat admin o‘zgartiradi):
• Haftalik grafik: har kun «Ish kuni / Dam olish», yopiq soatlar (tanaffus), «Ishga keladi / Ketadi».
• Sana bo‘yicha (14 kun oldinga): aniq kun uchun alohida grafik.
• «Saqlash» bosilganda yoziladi.
Grafikdan tashqari vaqtga hech kim bron qila olmaydi. Grafik qo‘yilmagan instruktor butun ish kuni ishlaydi.` },

  { id: 'nazorat-paneli', r: ADMIN, w: 'Boshqaruv → Nazorat paneli',
    t: 'Nazorat paneli (maxfiy havola)',
    k: ['nazorat panel', 'nazorat havola', 'havolani ber', 'to‘liq nazorat'],
    a: `Boshqaruv → Nazorat paneli: hamma instruktor bitta sahifada (Excel ko‘rinishi, bron qilish, sharhlar).
Havolani nusxalash yoki ulashish mumkin; begonaga o‘tib ketsa — «Havolani yangilash» (eskisi darhol yopiladi).
Kassada esa «Instruktorlar nazorati» — faqat kim qachon bo‘shashi.` },

  { id: 'sharhlar', r: ADMIN, go: 'feedback', w: 'Boshqaruv → Sharhlar',
    t: 'Mijozlar sharhlari',
    k: ['sharh', 'fikr', 'otziv', 'отзыв', 'baho', 'reyting', 'yulduz', 'taklif', 'sharh so‘rov'],
    a: `Boshqaruv → Sharhlar: kim yozgani, qaysi instruktor yoki avtodrom haqida, yulduzlar, izoh va taklif; instruktor bo‘yicha filtr.
«Sharh so‘rovi» — Mini App mijozlariga Telegram orqali sharh so‘rovi yuborish (har biriga bir marta).
Nazorat panelida sharhlar ismsiz ko‘rinadi.` },

  { id: 'hisobot-tahlil', r: ADMIN, go: 'analytics', w: 'Hisobot → Hisobot va tahlil (maxsus parol bilan)',
    t: 'Hisobot va tahlil, analitika',
    k: ['hisobot va tahlil', 'analitika', 'statistika', 'umumiy hisobot', 'grafik tushum', 'tahlil'],
    a: `Hisobot → «Hisobot va tahlil» (maxsus parol bilan): istalgan davr uchun tushum, bronlar, darslar.
«Analitika · 2 loyiha» — Avtodrom va Avtodrom12 birga, jonli.
«O‘quvchini qaytarish» — qaysi instruktor yangi o‘quvchini jalb qildi va 7 kun ichida qaytardi.` },

  { id: 'boshliq', r: ADMIN, w: 'Boshqaruv → Boshqaruv ilovasi',
    t: 'Rahbar ilovasi (AVTODROM BOSHQARUV)',
    k: ['boshqaruv ilova', 'rahbar', 'boshliq', 'iphone', 'telefonga ilova', 'direktor'],
    a: `Boshqaruv → Boshqaruv ilovasi: rahbar telefoni uchun panel (avtoshkola, platniy, avtodrom, xarajatlar, sharhlar).
1. PIN qo‘ying (4–8 raqam). 2. Havolani rahbarga yuboring. 3. iPhone’da Safari → Ulashish → «Ekranga qo‘shish».
Faqat ko‘rish uchun. Telefon yo‘qolsa — «Havolani yangilash».` },

  { id: 'kirish-foni', r: ADMIN, w: 'Boshqaruv → Kirish sahifasi foni',
    t: 'Kirish sahifasi foni',
    k: ['kirish sahifa', 'fon', 'fon rasm', 'orqa fon', 'login fon'],
    a: 'Boshqaruv → Kirish sahifasi foni → «Rasm yuklash» (JPG, PNG, WEBP). Xodimlar kirish oynasining orqasida turadi. «Ko‘k fonga qaytarish» — o‘chirish.' },

  { id: 'kengaytirilgan', r: ADMIN, w: 'Boshqaruv → Kengaytirilgan panel',
    t: 'Kengaytirilgan panel',
    k: ['kengaytirilgan', 'eski panel', 'to‘liq panel', 'full panel', 'admin full', 'texnik sozlama', 'barcha sozlama'],
    a: `Kengaytirilgan panel (/admin/full) — to‘liq admin paneli: foydalanuvchilar, mashg‘ulotlar, media, amallar tarixi, sozlamalar.
Sozlamalar: hamma narx (30 daqiqa, 1 soat, 3 soat, 5 soatlik paket, 1 krug, test drive), ish vaqti, eslatmalar, kechikish, avto-tasdiq.
«🛠 Barcha sozlamalar (texnik)» — bazadagi istalgan sozlamani o‘zgartirish (ehtiyot bo‘ling).
Kundalik ish uchun shu (sodda) panel yetarli.` },

  { id: 'eslatma', r: ALL, w: 'Narxlar va ish vaqti → Eslatmalar va kechikish',
    t: 'Eslatmalar va kechikish qoidasi',
    k: ['eslatma', 'napominan', 'напомин', 'kechik', 'kelmadi avtomatik', '15 daqiqa kechik', '60 30 20'],
    a: `Mijozga dars oldidan Telegram’da eslatma boradi (standart 60, 30 va 20 daqiqa oldin).
Kechikish qoidasi (necha daqiqadan keyin to‘lanmagan bron yopiladi) sozlamada; 0 — o‘chiq.
To‘langan chek esa HECH QACHON o‘zi yopilmaydi — urilguncha yaroqli.` },

  /* ------------------------------ INSTRUKTOR ------------------------------ */
  { id: 'chek-urish', r: ALL, w: 'Instruktor ilovasi → Chek skaner',
    t: 'Instruktor chekni qanday uradi',
    k: ['chek ur', 'chekni ur', 'chek ura', 'skaner', 'qr', 'skanerla', '4 xonali', 'to‘rt xonali', 'raqamni yoz', 'dars boshla', 'chek raqam'],
    a: `1. Instruktor «INDEX INSTRUKTOR» ilovasida «Chek skaner» → chekdagi QR kodni skanerlaydi.
2. QR o‘qilmasa — chekdagi katta 4 xonali raqamni qo‘lda kiritadi yoki shu raqamni instruktor botiga yozadi.
3. Chek uriladi — dars shu paytdan boshlanadi, vaqt tugaganda o‘zi yopiladi.
Instruktorsiz chekni istalgan instruktor uradi.` },

  { id: 'chek-urilmayapti', r: ALL, w: 'Cheklar · Instruktor ilovasi',
    t: 'Chek urilmayapti — nima qilish kerak',
    k: ['urilmayapti', 'urilmadi', 'ura olmay', 'urolmay', 'chek ura olmay', 'chek o‘tmadi', 'xato chiqdi', 'skaner ishlamay', 'qr o‘qimay', 'chek ishlamay', 'yuklanmadi', 'eskirgan', 'ilova ishlamay'],
    a: `Tartib bilan tekshiring:
1. Cheklar’da chekni toping: «Faol» bo‘lishi kerak. «Bekor» yoki «Ishlatilgan» chek qayta urilmaydi.
2. QR o‘qilmasa — 4 xonali raqamni kiriting; raqam ikki chekka mos kelsa, QR so‘raladi.
3. Instruktor ilovasi «Yuklanmadi» yoki «eskirgan» desa — ilovani yopib, bot orqali qayta ochsin.
4. Hal bo‘lmasa — adminga qo‘ng‘iroq qiling.` },

  { id: 'instruktor-ilova', r: ALL, w: 'Instruktor ilovasi',
    t: 'Instruktor ilovasi nimalar qiladi',
    k: ['instruktor ilova', 'instruktor panel', 'bo‘sh vaqtlarim', 'hisob-kitob', 'instruktor nima qiladi', 'mijoz kelmadi', 'eslatish', 'bronlarim instruktor'],
    a: `«INDEX INSTRUKTOR» ilovasi (instruktor boti ichida):
• Chek skaner — chek urish; darsdagi o‘quvchi va qolgan vaqt; «Yakunlash».
• Bronlarim — bugungi va keyingi bronlar, qo‘ng‘iroq/Telegram, «Eslatish», «Mijoz kelmadi».
• Bo‘sh vaqtlarim — o‘zi band soatlarni yopishi.
• Hisob-kitob — oy bo‘yicha shkola, pullik darslar va soatlar.` },

  { id: 'instruktor-bot', r: ALL, w: 'Instruktor boti',
    t: 'Instruktor boti orqali bron yozish',
    k: ['instruktor bot', 'botga yoz', 'bot orqali bron', 'ertaga 13:00', 'bugungi jadvalim', 'ertangi jadvalim', 'bot menyu', 'bot bekor'],
    a: `Instruktor botiga shaxsiy chatda yozadi:
• «ertaga 13:00 901234567» — ertaga 13:00, 1 soat; «15-17» — 2 soat; «/C» — toifa; «30 min»; «avtomat».
• «bekor 14:00» — o‘zi yozgan to‘lanmagan bronni bekor qilish.
• Menyu: Bugungi/Ertangi jadvalim (rasm va raqamlar), Bugungi/Ertangi bronlarim.
• 4 xonali chek raqamini yozsa — chek uriladi.
Bron instruktorning Excel bron ustuniga tushadi.` },

  /* ------------------------------ MIJOZ ------------------------------ */
  { id: 'mijoz-ilova', r: ALL, w: 'Mijoz boti @avtodrom_index_bot → Ilova',
    t: 'Mijoz qanday bron qiladi',
    k: ['mijoz qanday bron', 'mini app', 'ilovadan bron', 'mijoz ilova', 'bot orqali bron', 'avtodrom_index_bot', 'mijozga tushuntir', 'onlayn bron'],
    a: `Mijoz @avtodrom_index_bot → «📱 Ilovani ochish» → Toifa → Davomiylik → Kun va vaqt → Instruktor → tasdiq.
• Bron odatda darhol tasdiqlanadi, kassa kodi (AVD-1234) Telegram’ga keladi.
• Dars oldidan eslatma keladi.
• Kassada kodni aytadi → kassir chek chiqaradi.
• To‘lanmagan, boshlanmagan bronni o‘zi ilovada bekor qila oladi; «Profil → Sharh qoldirish».` },

  /* ------------------------------ UMUMIY ------------------------------ */
  { id: 'rollar', r: ALL, w: 'Dastur haqida',
    t: 'Kim nima qiladi (rollar)',
    k: ['kim nima qiladi', 'rollar', 'vazifa', 'kassir nima', 'operator nima', 'admin nima', 'kimning ishi', 'dastur haqida', 'qanday ishlaydi dastur', 'nimalar bor'],
    a: `• Kassir (P1, P2): chek chiqarish, test drive, cheklar (qayta chop etish, bekor qilish), Jarayonda, Instruktorlar nazorati, jadval, Excel bron; «Hisobot» — maxsus parol bilan.
• Operator: yangi bronlarni tasdiqlash, bekor so‘rovlari, qo‘lda bron, Excel bron, mijozlar chati.
• Administrator: hammasi + narxlar, xodimlar, instruktorlar, ish grafigi, hisobotlar, sharhlar, nazorat paneli, rahbar ilovasi.
• Instruktor: ilovada chek uradi, bronlarini ko‘radi, botga bron yozadi.
• Mijoz: Telegram bot va ilova orqali bron qiladi, kassada to‘laydi.` },

  { id: 'chiqish', r: ALL, w: 'Yon menyu pastida',
    t: 'Chiqish va qayta kirish',
    k: ['chiqish', 'logout', 'qayta kir', 'kira olmayapman', 'kirmayapti', 'login xato', 'parol xato'],
    a: `Chiqish — yon menyu pastidagi qizil tugma (ism yonida). Qayta kirish — login va parol bilan.
Parol to‘g‘ri bo‘lsa ham kira olmasangiz yoki parolni unutgan bo‘lsangiz — adminga qo‘ng‘iroq qiling (xodim parolini admin «Xodimlar»da almashtiradi).` },
];

/* ---------------------------- Matnni tekislash ---------------------------- */
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h' };
/** Kichik harf, kirill → lotin, o‘/g‘ → o/g, h → x, q → k (yozuv farqlari bir xil bo‘lsin) */
export function norm(s) {
  let t = String(s || '').toLowerCase().replace(/[а-яёўқғҳ]/g, (c) => CYR[c] ?? c);
  t = t.replace(/[‘’ʻʼ`´']/g, '').replace(/h/g, 'x').replace(/q/g, 'k').replace(/w/g, 'v');
  return t.replace(/[^a-z0-9+:]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const words = (s) => norm(s).split(' ').filter(Boolean);

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
/** So‘z kalitga mosmi: aynan, o‘zak (chek → cheklarni) yoki bitta xato (chqarish → chiqarish) */
function wordHit(tok, kw) {
  if (tok === kw) return 1;
  if ((kw.length >= 3 || tok.length <= 5) && tok.startsWith(kw)) return 1;
  if (tok.length >= 4 && kw.startsWith(tok) && tok.length >= kw.length - 2) return 0.9;
  if (kw.length >= 5 && tok.length >= 4 && tok[0] === kw[0]) {   // xato odatda birinchi harfda bo‘lmaydi
    let best = 9;
    for (const L of [kw.length - 1, kw.length, kw.length + 1]) best = Math.min(best, lev(tok.slice(0, L), kw));
    if (best <= 1) return 0.75;
  }
  return 0;
}
const STOP = new Set(['va', 'yoki', 'bu', 'shu', 'u', 'men', 'biz', 'siz', 'sen', 'ni', 'da', 'ga', 'ham', 'endi', 'iltimos', 'qanday', 'kanday', 'kanaka', 'kanka', 'kanklb', 'kancxa', 'kayerda', 'kayerdan', 'kilib', 'kilaman', 'kilsam', 'nima', 'kerak', 'bor', 'yok', 'bolsa', 'kak', 'gde', 'eto', 'mne', 'nado', 'ka', 'mi', 'chi', 'aka', 'opa', 'ustoz', 'brat']);

/* ---------------------- «Adminga qo‘ng‘iroq qiling» ---------------------- */
const HOWTO = /\b(kanday|kanaka|kanka|kanklb|kanakasiga|kayer|kaysi bolim|kilsam|kilaman|kilish|kilib|kilinadi|mumkinmi|boladimi|nega|nima ucxun|tusxuntir|orgat|kak|gde|pocxemu|zacxem|kuda|kakim|nima degani|nimaga kerak|yordam ber)/;
const SECRET = /\b(parol|pin|login|kalit|maxfiy|xavola)/;
const SECRET_ASK = /\b(ayt|ber|kancxa|necx|bilmay|unut|esim|esdan|yoz|tasxla|kerak|skaj|dai|kakoi)/;
const DATA_NOUN = /\b(pul|tusxum|summa|som|nakd|kassada|daromad|foyda|xarajat|maosx|oylik|isx xaki|zarplat|telefon|rakam|nomer|ismi|familiya|manzili|mijozlar royxat|xisobotni|statistikani|kecxagi|bugungi|xozirgi)/;
const DATA_ASK = /\b(kancxa|necxta|necxa|ayt|ber|yubor|korsat|tasxla|kimniki|kaysi mijoz|skolko|kto|dai|skaj|pokaj)/;

/** Aniq ma’lumot yoki maxfiy narsa so‘rayaptimi (bular qo‘llanmada yo‘q — admin) */
export function asksForData(q) {
  const t = norm(q);
  if (SECRET.test(t) && SECRET_ASK.test(t) && !/\b(kayerga|kanday kirit|kiritaman|ozgartir|almasxtir|kanday koy|nima ucxun|nimaga kerak|nima degani)/.test(t)) return true;
  if (HOWTO.test(t)) return false;
  /* «kecha nechta chek chiqdi», «bugun qancha bron bor» — son + vaqt */
  if (/\b(kancxa|necxta|necxa|skolko)/.test(t) && /\b(bugun|kecxa|xozir|bu oy|sxu oy|xafta|oyda|kunda|segodn|vcxera)/.test(t)) return true;
  /* narx — ochiq ma’lumot (mijozlar ham ko‘radi): qo‘llanma javob beradi */
  if (/\b(narx|tarif|krug|paket|test drive|testdrive|soatlik|turadi|stoit|cena)/.test(t)) return false;
  return DATA_NOUN.test(t) && DATA_ASK.test(t);
}

/* ------------------------------ Qidirish ------------------------------ */
const PREP = KB.map((e) => ({
  e,
  keys: e.k.map((k) => words(k)).filter((w) => w.length),
  title: [...new Set(words(e.t).filter((w) => !STOP.has(w)))],
}));

function scoreEntry(p, toks, role) {
  let s = 0, part = 0;
  for (const kw of p.keys) {
    let hit = 0, n = 0, ok = 0;
    for (const w of kw) {
      if (STOP.has(w)) continue;
      n++;
      let best = 0;
      for (const t of toks) best = Math.max(best, wordHit(t, w));
      hit += best; if (best >= 0.75) ok++;
    }
    if (!n) continue;
    if (ok === n) s += 2 * hit + (n > 1 ? 2 : 0);                // kalitning hamma so‘zi bor (xato yozuv ham)
    else if (n >= 3 && hit >= n - 1) part = Math.max(part, hit); // uzun kalitning ko‘p qismi (bitta, eng yaxshisi)
  }
  s += part;
  for (const w of p.title) for (const t of toks) if (wordHit(t, w) >= 0.9) { s += 0.6; break; }
  if (s > 0 && role && p.e.r.includes(role)) s += 0.5;
  return s;
}

const GREET = /^(salom|assalom|asalom|xayrli|privet|zdravst|salam)/;
const THANKS = /^(raxmat|spasibo|tasxakkur|katta raxmat|ok|okay|xop|tusxundim|yaxsxi|zor)\b/;

/**
 * Savolga javob.
 * kind: 'answer' — topildi (items[0] asosiy, qolgani o‘xshash mavzular);
 *       'admin' — aniq ma’lumot/parol so‘raldi; 'unknown' — topilmadi (items — taklif);
 *       'greet' | 'thanks'.
 */
export function answer(question, role = 'cashier') {
  const q = String(question || '').trim();
  const t = norm(q);
  if (!t) return { kind: 'unknown', items: suggestions(role) };
  if (GREET.test(t) && t.split(' ').length <= 3) return { kind: 'greet', items: suggestions(role) };
  if (THANKS.test(t) && t.split(' ').length <= 3) return { kind: 'thanks', items: [] };
  if (asksForData(q)) return { kind: 'admin', text: ADMIN_CALL, items: [] };
  const toks = words(q).filter((w) => !STOP.has(w));
  const scored = PREP.map((p) => ({ e: p.e, s: scoreEntry(p, toks, role) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (!best || best.s < 2.5) return { kind: 'unknown', items: scored.slice(0, 3).map((x) => x.e).concat(scored.length ? [] : suggestions(role)).slice(0, 3) };
  const rel = scored.slice(1).filter((x) => x.s >= best.s * 0.55).slice(0, 2).map((x) => x.e);
  return { kind: 'answer', items: [best.e, ...rel], own: best.e.r.includes(role) };
}

/** Bosh ekrandagi tayyor savollar — rolga qarab */
export function suggestions(role = 'cashier') {
  const ids = {
    cashier: ['chek-chiqarish', 'test-drive', 'chek-bekor', 'qayta-chop', 'paket', 'instruktorlar-nazorati'],
    operator: ['qolda-bron', 'yangi-bronlar', 'bekor-sorovlari', 'excel-bron', 'chat', 'jadval'],
    admin: ['rollar', 'narxlar', 'xodimlar', 'ish-grafigi', 'sharhlar', 'chek-bekor'],
  }[role] || ['rollar'];
  return ids.map((id) => KB.find((e) => e.id === id)).filter(Boolean);
}
export const QUESTIONS = {
  cashier: ['Chek qanday chiqaraman?', 'Test drive qanday qilinadi?', 'Chekni qanday bekor qilaman?', 'Chekni qayta chop etish', '5 soatlik paket nima?', 'Qaysi instruktor bo‘sh?'],
  operator: ['Telefon orqali bron qanday qilaman?', 'Yangi bronni qanday tasdiqlayman?', 'Mijoz bronni bekor qilmoqchi', 'Excel bronga qanday yozaman?', 'Mijozlar chatiga qanday javob beraman?'],
  admin: ['Kim nima qiladi?', 'Narxni qayerda o‘zgartiraman?', 'Yangi kassir qanday qo‘shaman?', 'Ish grafigini qanday qo‘yaman?', 'Sharhlar qayerda?'],
};
