// Sharing an RV as a PDF or a text message, and adding the next return visit
// to a calendar.
import { t } from './i18n.js';
import { formatDateTime, markdownToText, mapsUrl, parseCoords, phoneLine } from './util.js';

let jsPdfPromise = null;

// jsPDF is big, so it's only loaded the first time something is shared.
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  if (!jsPdfPromise) {
    jsPdfPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/jspdf.umd.min.js';
      script.onload = () => resolve(window.jspdf.jsPDF);
      script.onerror = () => {
        jsPdfPromise = null;
        reject(new Error(t('share.loadFailed')));
      };
      document.head.appendChild(script);
    });
  }
  return jsPdfPromise;
}

/**
 * The PDF's built-in fonts only have Western European characters, which cover
 * English, Spanish, and Portuguese. Typographic quotes and dashes are
 * swapped for plain ones, and anything else (like emoji) is dropped.
 */
export function pdfSafe(text) {
  return String(text || '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/\u00a0/g, ' ')
    .normalize('NFC')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, '');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('share.badPicture')));
    img.src = src;
  });
}

// jsPDF embeds JPEGs as they are. Anything else is re-encoded as a JPEG.
async function jpegFor(dataUrl) {
  const img = await loadImage(dataUrl);
  if (dataUrl.startsWith('data:image/jpeg')) return { dataUrl, width: img.naturalWidth, height: img.naturalHeight };
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(img, 0, 0);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height };
}

/**
 * @param {Object} options
 * @param {Object} options.person
 * @param {Object[]} options.visits Newest first.
 * @param {string[]} options.pictures Data URLs.
 * @param {string[]} options.times Available times, as shown in the app.
 * @returns {Promise<Blob>}
 */
export async function personPdf({ person, visits, pictures, times }) {
  const JsPdf = await loadJsPdf();
  const doc = new JsPdf({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 48;
  const width = pageWidth - margin * 2;
  const bottom = pageHeight - margin - 16;
  let y = margin;

  const ensure = height => {
    if (y + height > bottom) {
      doc.addPage();
      y = margin;
    }
  };
  const write = (text, { size = 11, style = 'normal', color = [30, 41, 59], gap = 4, indent = 0 } = {}) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lineHeight = size * 1.35;
    for (const line of doc.splitTextToSize(pdfSafe(text), width - indent)) {
      ensure(lineHeight);
      doc.text(line, margin + indent, y + size);
      y += lineHeight;
    }
    y += gap;
  };
  const heading = text => {
    ensure(40);
    y += 10;
    write(text, { size: 14, style: 'bold', gap: 2 });
    doc.setDrawColor(203, 213, 225);
    doc.line(margin, y, margin + width, y);
    y += 8;
  };
  const field = (label, value) => {
    if (!value) return;
    ensure(30);
    write(label, { size: 9, style: 'bold', color: [100, 116, 139], gap: 0 });
    write(value, { gap: 6 });
  };

  write(person.name, { size: 22, style: 'bold', gap: 2 });
  write(t('pdf.subtitle', { date: formatDateTime(new Date().toISOString()) }), { size: 9, color: [100, 116, 139], gap: 10 });

  field(t('pdf.address'), person.address);
  if (person.phones && person.phones.length) field(t('pdf.phones'), person.phones.map(phoneLine).join('\n'));
  const coords = parseCoords(person.coordinates);
  if (coords || person.address) {
    ensure(30);
    write(t('pdf.location'), { size: 9, style: 'bold', color: [100, 116, 139], gap: 0 });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(79, 70, 229);
    const label = pdfSafe(coords ? `${person.coordinates} - ${t('pdf.openMap')}` : t('pdf.openMap'));
    doc.textWithLink(label, margin, y + 11, { url: mapsUrl(person) });
    y += 11 * 1.35 + 6;
  }
  if (person.isStudy) field(t('pdf.status'), t('pdf.studying'));
  if (person.returnAt) field(t('pdf.returnAt'), formatDateTime(person.returnAt));
  if (times.length) field(t('pdf.available'), times.join('\n'));
  if (person.tags && person.tags.length) field(t('pdf.tags'), person.tags.join(', '));
  if (person.description) field(t('pdf.description'), markdownToText(person.description));

  if (pictures.length) {
    heading(t('pdf.pictures'));
    const gap = 12;
    const cellWidth = (width - gap) / 2;
    const maxHeight = 300;
    let column = 0;
    let rowHeight = 0;
    for (const source of pictures) {
      let image;
      try {
        image = await jpegFor(source);
      } catch (err) {
        continue;
      }
      const scale = Math.min(cellWidth / image.width, maxHeight / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      if (column === 0) ensure(h);
      doc.addImage(image.dataUrl, 'JPEG', margin + column * (cellWidth + gap), y, w, h);
      rowHeight = Math.max(rowHeight, h);
      if (column === 1) {
        y += rowHeight + gap;
        rowHeight = 0;
      }
      column = 1 - column;
    }
    if (column === 1) y += rowHeight + gap;
  }

  heading(t('pdf.visits', { count: visits.length }));
  if (!visits.length) write(t('pdf.noVisits'), { color: [100, 116, 139] });
  for (const visit of visits) {
    ensure(40);
    write(formatDateTime(visit.createdAt), { style: 'bold', gap: 2 });
    const notes = markdownToText(visit.notes);
    write(notes || t('pdf.noNotes'), notes ? { gap: 12 } : { color: [148, 163, 184], gap: 12 });
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text(pdfSafe(`${person.name} - ${t('pdf.page', { page, pages })}`), pageWidth / 2, pageHeight - 24, { align: 'center' });
  }
  return doc.output('blob');
}

/**
 * The RV as plain text for a message: details first, then every visit.
 * Takes the same options as personPdf, without pictures.
 */
export function personText({ person, visits, times }) {
  const sections = [];
  const details = [person.name];
  if (person.address) details.push(person.address);
  (person.phones || []).forEach(phone => details.push(`${phone.label || t('text.phone')}: ${phone.number}`));
  if (person.address || person.coordinates) details.push(mapsUrl(person));
  sections.push(details.join('\n'));

  const more = [];
  if (person.isStudy) more.push(`${t('pdf.status')}: ${t('pdf.studying')}`);
  if (person.returnAt) more.push(`${t('pdf.returnAt')}: ${formatDateTime(person.returnAt)}`);
  if (times.length) more.push(`${t('pdf.available')}:\n${times.join('\n')}`);
  if (person.tags && person.tags.length) more.push(`${t('pdf.tags')}: ${person.tags.join(', ')}`);
  if (more.length) sections.push(more.join('\n'));

  const description = markdownToText(person.description);
  if (description) sections.push(description);

  if (visits.length) {
    sections.push(`${t('pdf.visits', { count: visits.length })}`);
    visits.forEach(visit => sections.push(`${formatDateTime(visit.createdAt)}\n${markdownToText(visit.notes) || t('pdf.noNotes')}`));
  }
  return sections.join('\n\n');
}

/** Whether this browser's share menu can take pictures along with text. */
export function canSharePictures() {
  const file = new File([new Uint8Array(1)], 'picture.jpg', { type: 'image/jpeg' });
  return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file], text: 'x' }));
}

/** Pictures (data URLs) as files named after the RV, such as "Ana 1.jpg". */
export function pictureFiles(dataUrls, name) {
  const base = String(name).replace(/[\\/:*?"<>|]+/g, '').trim() || 'RV';
  return dataUrls.map((dataUrl, index) => {
    const type = dataUrl.slice(5, dataUrl.indexOf(';'));
    const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), c => c.charCodeAt(0));
    const extension = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type] || 'jpg';
    return new File([bytes], `${base} ${index + 1}.${extension}`, { type });
  });
}

/**
 * Opens the share sheet with text (and pictures, if given), or copies the
 * text where sharing isn't supported. If the pictures are refused, the text
 * is shared on its own.
 *
 * @returns {Promise<'shared'|'textOnly'|'cancelled'|'copied'>}
 */
export async function shareText(text, title, files = []) {
  let refusedPictures = false;
  if (files.length && navigator.canShare && navigator.canShare({ files, text })) {
    try {
      await navigator.share({ title, text, files });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      refusedPictures = true;
    }
  } else if (files.length) {
    refusedPictures = true;
  }
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return refusedPictures ? 'textOnly' : 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      if (err.name !== 'NotAllowedError' && err.name !== 'TypeError') throw err;
    }
  }
  await navigator.clipboard.writeText(text);
  return 'copied';
}

/** A file name without characters that file systems or apps reject. */
export function pdfFileName(name) {
  const safe = t('pdf.fileName', { name }).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
  return `${safe || 'RV'}.pdf`;
}

/**
 * Shares a file with the system share sheet when it can, or downloads it.
 *
 * @returns {Promise<'shared'|'cancelled'|'downloaded'>}
 */
export async function shareOrDownload(file, title) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      // NotAllowedError means too much time passed since the tap; the caller
      // can offer another button to tap.
      throw err;
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

/* -------------------------------------------------------------------- */
/* Calendar reminders                                                   */
/* -------------------------------------------------------------------- */

const VISIT_MINUTES = 30;
const pad = n => String(n).padStart(2, '0');

// 20261015T164600Z
function calendarTime(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function eventDetails(person) {
  const start = new Date(person.returnAt);
  const end = new Date(start.getTime() + VISIT_MINUTES * 60000);
  const location = person.address ? person.address.replace(/\s*\n\s*/g, ', ') : person.coordinates;
  const phones = (person.phones || []).map(phoneLine).join('\n');
  const description = [person.address || person.coordinates ? mapsUrl(person) : '', phones, markdownToText(person.description)]
    .filter(Boolean).join('\n\n');
  return { title: t('calendar.eventTitle', { name: person.name }), start, end, location, description };
}

/** A link that opens Google Calendar with the visit filled in. */
export function googleCalendarUrl(person) {
  const event = eventDetails(person);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${calendarTime(event.start)}/${calendarTime(event.end)}`,
    details: event.description,
    location: event.location || ''
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function icsText(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// iCalendar lines are folded at 75 bytes; folding at 70 characters keeps
// most multi-byte text under that.
function fold(line) {
  const parts = [];
  for (let i = 0; i < line.length; i += 70) parts.push((i ? ' ' : '') + line.slice(i, i + 70));
  return parts.join('\r\n');
}

/** An .ics file with the visit and a reminder an hour before. */
export function calendarFile(person) {
  const event = eventDetails(person);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RV Notes//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${person.id}-${calendarTime(event.start)}@rv-notes`,
    `DTSTAMP:${calendarTime(new Date())}`,
    `DTSTART:${calendarTime(event.start)}`,
    `DTEND:${calendarTime(event.end)}`,
    `SUMMARY:${icsText(event.title)}`,
    event.location ? `LOCATION:${icsText(event.location)}` : '',
    event.description ? `DESCRIPTION:${icsText(event.description)}` : '',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(event.title)}`,
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).map(fold);
  const name = `${t('calendar.eventTitle', { name: person.name }).replace(/[\\/:*?"<>|]+/g, '').trim()}.ics`;
  return new File([lines.join('\r\n') + '\r\n'], name, { type: 'text/calendar' });
}
