// The language used for dates and numbers. i18n.js sets it; util.js and
// report.js read it (undefined means the browser's own language).
export let currentLocale;

export function setCurrentLocale(locale) {
  currentLocale = locale;
}
