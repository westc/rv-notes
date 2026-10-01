// Translating the app: t('key', {name: …}) returns the message for the
// current language. The language follows the device unless one is chosen.
import { reactive } from '../vendor/vue.esm-browser.prod.js';
import { MESSAGES } from './messages.js';
import { setCurrentLocale } from './locale.js';

const STORAGE_KEY = 'rv-notes/language';

export const LANGUAGE_NAMES = { en: 'English', es: 'Español', 'pt-BR': 'Português (Brasil)' };

/** The supported language closest to the device's languages. */
export function detectLanguage(languages = navigator.languages || [navigator.language]) {
  for (const language of languages) {
    const lower = String(language || '').toLowerCase();
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('pt')) return 'pt-BR';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

function storedChoice() {
  try {
    const choice = localStorage.getItem(STORAGE_KEY) || '';
    return choice in LANGUAGE_NAMES ? choice : '';
  } catch (err) {
    return '';
  }
}

// choice is '' to follow the device.
export const i18n = reactive({ choice: '', locale: 'en' });

function apply(choice) {
  i18n.choice = choice;
  i18n.locale = choice || detectLanguage();
  setCurrentLocale(i18n.locale);
  if (typeof document !== 'undefined') document.documentElement.lang = i18n.locale;
}
apply(storedChoice());

export function setLanguage(choice) {
  try {
    if (choice) localStorage.setItem(STORAGE_KEY, choice); else localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    // The choice still applies until the app is closed.
  }
  apply(choice in LANGUAGE_NAMES ? choice : '');
}

const pluralRules = {};

export function t(key, params = {}, locale = i18n.locale) {
  let message = MESSAGES[locale][key] ?? MESSAGES.en[key];
  if (message == null) return key;
  if (typeof message === 'object') {
    const rules = pluralRules[locale] || (pluralRules[locale] = new Intl.PluralRules(locale));
    message = message[rules.select(params.count)] ?? message.other;
  }
  return message.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
}
