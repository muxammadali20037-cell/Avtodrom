// Shared visual + calendar constants used by the customer, admin and
// instructor apps. Kept in one place so the three apps can never drift out
// of sync with each other.

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const GREEN = "#16A34A";
export const GREEN_DARK = "#15803D";
export const GREEN_SOFT = "#F0FDF4";
export const CHARCOAL = "#1F2937";

export const WD_LABEL = {
  uz: { sun: "Yakshanba", mon: "Dushanba", tue: "Seshanba", wed: "Chorshanba", thu: "Payshanba", fri: "Juma", sat: "Shanba" },
  ru: { sun: "Воскресенье", mon: "Понедельник", tue: "Вторник", wed: "Среда", thu: "Четверг", fri: "Пятница", sat: "Суббота" },
};
export const WD_SHORT = {
  uz: { sun: "Yak", mon: "Du", tue: "Se", wed: "Chor", thu: "Pay", fri: "Ju", sat: "Sha" },
  ru: { sun: "Вс", mon: "Пн", tue: "Вт", wed: "Ср", thu: "Чт", fri: "Пт", sat: "Сб" },
};
export const MONTH_LABEL = {
  uz: ["Yan", "Fev", "Mar", "Apr", "May", "Iyun", "Iyul", "Avg", "Sen", "Okt", "Noy", "Dek"],
  ru: ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"],
};
