// Helpers shared by the app's modules.
import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';
import { currentLocale } from './locale.js';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const PERIODS = ['Morning', 'Afternoon', 'Evening'];
// Must match MAX_PICTURE_BYTES in Code.gs.
export const MAX_PICTURE_BYTES = 120 * 1024;

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function markdown(text) {
  return text ? DOMPurify.sanitize(marked.parse(text, { breaks: true })) : '';
}

// localStorage can be unavailable (for example in some private browsing
// modes), so failures are ignored.
export const storage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }
};

// Letters (in any language), numbers, and hyphens. Must match TAG_PATTERN in
// apps-script/Code.gs.
export const TAG_PATTERN = /^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u;
export const MAX_TAG_LENGTH = 40;

/**
 * Turns typed text into a tag: spaces become hyphens, other punctuation is
 * dropped, and hyphens are never doubled or at either end.
 */
export function cleanTag(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{M}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

/**
 * Markdown as plain text, for PDFs and previews. List items start with "- ".
 */
export function markdownToText(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.innerHTML = markdown(text);
  div.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  div.querySelectorAll('li').forEach(li => li.prepend('- '));
  div.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr').forEach(el => el.append('\n'));
  return div.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// Decodes the base64url text made by the spreadsheet's Connect app dialog.
export function decodeBase64Url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

// ISO string -> value for <input type="datetime-local"> in local time.
export function toLocalInput(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || isNaN(date)) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value) {
  const date = value ? new Date(value) : null;
  return date && !isNaN(date) ? date.toISOString() : '';
}

export function formatDateTime(iso) {
  const date = new Date(iso);
  const options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return date.toLocaleString(currentLocale, options);
}

export function shortDate(iso) {
  const date = new Date(iso);
  const options = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = '2-digit';
  return date.toLocaleDateString(currentLocale, options);
}

const relativeFormats = {};
// now is passed in by the UI so the text updates as time passes.
export function relative(iso, now = new Date()) {
  const relativeFormat = relativeFormats[currentLocale] ||
    (relativeFormats[currentLocale] = new Intl.RelativeTimeFormat(currentLocale, { numeric: 'auto' }));
  const date = new Date(iso);
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
  if (Math.abs(days) < 1) {
    const minutes = Math.round((date - now) / 60000);
    // "now", "ahora", "agora"
    if (minutes === 0) return relativeFormat.format(0, 'second');
    if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, 'minute');
    return relativeFormat.format(Math.round(minutes / 60), 'hour');
  }
  if (Math.abs(days) < 14) return relativeFormat.format(days, 'day');
  if (Math.abs(days) < 60) return relativeFormat.format(Math.round(days / 7), 'week');
  if (Math.abs(days) < 730) return relativeFormat.format(Math.round(days / 30.4), 'month');
  return relativeFormat.format(Math.round(days / 365), 'year');
}

export function endOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

export function returnBadgeClass(iso) {
  const date = new Date(iso);
  if (date < new Date()) return 'badge-overdue';
  if (date < endOfToday()) return 'badge-today';
  return 'badge-later';
}

export function firstLine(text) {
  return String(text).split('\n')[0];
}

export function parseCoords(text) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text || '');
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
}

export function formatCoords(lat, lng) {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export function mapQuery(person) {
  const coords = parseCoords(person.coordinates);
  return coords ? coords.join(',') : person.address.replace(/\s*\n\s*/g, ', ');
}

export function mapsUrl(person) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapQuery(person));
}

export function directionsUrl(person) {
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(mapQuery(person));
}

/** Straight-line distance in meters between two [lat, lng] points. */
export function distanceMeters([lat1, lng1], [lat2, lng2]) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// Places that measure road distances in miles. The region comes from the
// device, so someone in the US using the app in Spanish still sees miles.
const MILE_REGIONS = ['US', 'GB', 'LR', 'MM'];

export function usesMiles(language = typeof navigator === 'undefined' ? 'en-US' : navigator.language) {
  try {
    return MILE_REGIONS.includes(new Intl.Locale(language).maximize().region);
  } catch (err) {
    return false;
  }
}

/** "350 ft", "1.2 mi", "800 m", or "12 km". */
export function formatDistance(meters, miles = usesMiles()) {
  const format = (value, unit, digits) =>
    new Intl.NumberFormat(currentLocale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits }).format(value);
  if (miles) {
    const mi = meters / 1609.344;
    if (mi < 0.1) return format(Math.max(50, Math.round(meters * 3.28084 / 50) * 50), 'foot', 0);
    return format(mi, 'mile', mi < 10 ? 1 : 0);
  }
  if (meters < 1000) return format(Math.max(10, Math.round(meters / 10) * 10), 'meter', 0);
  return format(meters / 1000, 'kilometer', meters < 10000 ? 1 : 0);
}

// Must match PHONE_PATTERN and the limits in apps-script/Code.gs.
const PHONE_PATTERN = /^\+?[\d\s().\/-]+(?:\s*(?:x|ext\.?|#)\s*\d+)?$/i;
export const MAX_PHONES = 10;

/** Whether typed text is a phone number the spreadsheet will accept. */
export function isPhoneNumber(number) {
  const text = String(number || '').replace(/\s+/g, ' ').trim();
  return PHONE_PATTERN.test(text) && text.replace(/\D/g, '').length >= 3 && text.length <= 40;
}

// "+1 (423) 555-0100 ext. 12" → { dial: "+14235550100", extension: "12" }
function phoneParts(number) {
  const match = String(number).match(/^(.*?)(?:\s*(?:x|ext\.?|#)\s*(\d+))?$/i);
  const main = match[1].trim();
  return { dial: (main.startsWith('+') ? '+' : '') + main.replace(/\D/g, ''), extension: match[2] || '' };
}

/** Calls the number. Phones dial the extension after a pause. */
export function telUrl(number) {
  const { dial, extension } = phoneParts(number);
  return `tel:${dial}${extension ? `,${extension}` : ''}`;
}

export function smsUrl(number) {
  return `sms:${phoneParts(number).dial}`;
}

/**
 * WhatsApp needs the country code, so this is only for numbers that start
 * with +. Returns '' for others.
 */
export function whatsAppUrl(number) {
  const { dial } = phoneParts(number);
  return dial.startsWith('+') ? `https://wa.me/${dial.slice(1)}` : '';
}

/** "Mobile: +1 423 555 0100", as the spreadsheet shows it. */
export function phoneLine(phone) {
  return phone.label ? `${phone.label}: ${phone.number}` : phone.number;
}

export function base64Bytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return base64.length / 4 * 3 - (base64.match(/=*$/)[0].length);
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export function loadImage(src, name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${name} isn't an image this browser can open.`));
    img.src = src;
  });
}

// Re-encodes a photo as a JPEG, lowering the quality and then the size
// until it fits in maxBytes.
export async function shrinkImage(file, maxBytes) {
  const img = await loadImage(await readFileAsDataUrl(file), file.name);
  let maxSide = 1600;
  let quality = 0.85;
  for (let attempt = 0; attempt < 25; attempt++) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const bytes = base64Bytes(dataUrl);
    if (bytes <= maxBytes) return { dataUrl, bytes };
    if (quality > 0.55) {
      quality -= 0.1;
    } else {
      maxSide = Math.round(Math.min(maxSide, Math.max(canvas.width, canvas.height)) * 0.8);
      quality = 0.75;
    }
  }
  throw new Error(`Couldn't shrink ${file.name} enough.`);
}
