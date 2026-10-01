/**
 * RV Notes: return visit notes stored in the spreadsheet this script is bound to.
 *
 * @OnlyCurrentDoc
 */

// Each table is a sheet whose first row holds these headers. Columns are found
// by header name, so they can be reordered and extra columns can be added.
const TABLES = {
  people: {
    name: 'RVs',
    headers: ['ID', 'Name', 'Address', 'Coordinates', 'Description', 'Created At',
      'Is Study', 'Available Times', 'Pictures', 'Return At']
  },
  visits: {
    name: 'Visits',
    headers: ['ID', 'Person ID', 'Created At', 'Notes']
  },
  pictures: {
    name: 'Pictures',
    headers: ['ID', 'Person ID', 'Created At', 'Mime Type', 'Bytes']
  }
};

// Pictures are stored as base64 split across several cells, because a cell
// holds at most 50,000 characters.
const MAX_PICTURE_BYTES = 120 * 1024;
const PICTURE_CHUNK_SIZE = 45000;
const PICTURE_DATA_COLUMNS = Math.ceil(Math.ceil(MAX_PICTURE_BYTES / 3) * 4 / PICTURE_CHUNK_SIZE);
for (let i = 1; i <= PICTURE_DATA_COLUMNS; i++) TABLES.pictures.headers.push(`Data ${i}`);
const PICTURE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// The most characters a single text cell can hold.
const MAX_TEXT_LENGTH = 50000;

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PERIODS = ['Morning', 'Afternoon', 'Evening'];

const DATE_FORMAT = 'yyyy-mm-dd h:mm am/pm';
const CHECKBOX_RULE = SpreadsheetApp.newDataValidation().requireCheckbox().build();

/**
 * @returns {HtmlOutput}
 */
function doGet() {
  const url = ScriptApp.getService().getUrl();
  const props = PropertiesService.getScriptProperties();
  if (url && props.getProperty('webAppUrl') !== url) props.setProperty('webAppUrl', url);

  const template = HtmlService.createTemplateFromFile('Index');
  template.initData = {
    people: getPeople(),
    maxPictureBytes: MAX_PICTURE_BYTES,
    days: DAYS,
    periods: PERIODS
  };
  return template.evaluate()
    .setTitle('RV Notes')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Adds the RV Notes menu when the spreadsheet opens.
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('RV Notes')
    .addItem('Open Web App', 'showWebAppLink')
    .addItem('Set Up Sheets', 'setUpSheets')
    .addToUi();
}

function showWebAppLink() {
  const url = PropertiesService.getScriptProperties().getProperty('webAppUrl');
  const body = url
    ? `<p style="font-family: Arial, sans-serif"><a href="${url}" target="_blank">Open RV Notes</a></p>`
    : '<p style="font-family: Arial, sans-serif">Deploy the web app and open its URL once, then this link will appear here.</p>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(body).setWidth(320).setHeight(100), 'RV Notes');
}

/**
 * Creates any missing sheets and headers.
 */
function setUpSheets() {
  Object.keys(TABLES).forEach(getTable_);
}

/* ------------------------------------------------------------------------ */
/* People                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * @returns {Object[]} Every person, with how many visits they have and when
 *     the latest one was.
 */
function getPeople() {
  const stats = {};
  readColumns_(getTable_('visits'), ['Person ID', 'Created At']).forEach(row => {
    const personId = String(row['Person ID']);
    const createdAt = toIso_(row['Created At']);
    const stat = stats[personId] || (stats[personId] = { count: 0, last: '' });
    stat.count++;
    if (createdAt > stat.last) stat.last = createdAt;
  });

  return readRecords_(getTable_('people'))
    .filter(record => record['ID'])
    .map(record => {
      const person = toPerson_(record);
      const stat = stats[person.id];
      person.visitCount = stat ? stat.count : 0;
      person.lastVisitAt = stat ? stat.last : '';
      return person;
    });
}

/**
 * @param {string} id
 * @returns {{person: Object, visits: Object[]}} The person and their visits,
 *     most recent first.
 */
function getPerson(id) {
  const table = getTable_('people');
  const row = findRow_(table, 'ID', id);
  if (!row) throw new Error('This person no longer exists. They may have been deleted.');

  const visits = readRecords_(getTable_('visits'))
    .filter(record => String(record['Person ID']) === id)
    .map(toVisit_)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const person = toPerson_(readRow_(table, row));
  person.visitCount = visits.length;
  person.lastVisitAt = visits.length ? visits[0].createdAt : '';
  return { person: person, visits: visits };
}

/**
 * Adds a person (when input.id is empty) or updates one. Pictures are added
 * separately with addPicture(); any picture missing from input.pictures is
 * deleted.
 *
 * @param {Object} input
 * @returns {Object} The saved person.
 */
function savePerson(input) {
  return withLock_(() => {
    const table = getTable_('people');
    const name = cleanText_(input.name, 'Name', 500);
    if (!name) throw new Error('Name is required.');

    let row = 0;
    let existing = null;
    if (input.id) {
      row = findRow_(table, 'ID', input.id);
      if (!row) throw new Error('This person no longer exists. They may have been deleted.');
      existing = readRow_(table, row);
    }

    const currentPictures = existing ? splitList_(existing['Pictures']) : [];
    const keptPictures = (input.pictures || []).filter(id => currentPictures.indexOf(id) >= 0);
    deletePictures_(currentPictures.filter(id => keptPictures.indexOf(id) < 0));

    const record = {
      'Name': name,
      'Address': cleanText_(input.address, 'Address', 2000),
      'Coordinates': normalizeCoordinates_(input.coordinates),
      'Description': cleanText_(input.description, 'Description'),
      'Is Study': !!input.isStudy,
      'Available Times': normalizeTimes_(input.availableTimes).join(', '),
      'Pictures': keptPictures.join(','),
      'Return At': toDate_(input.returnAt)
    };
    if (!row) {
      row = table.sheet.getLastRow() + 1;
      record['ID'] = Utilities.getUuid();
      record['Created At'] = new Date();
    }
    writeRecord_(table, row, record);
    return toPerson_(readRow_(table, row));
  });
}

/**
 * Deletes a person along with their visits and pictures.
 *
 * @param {string} id
 */
function deletePerson(id) {
  withLock_(() => {
    const table = getTable_('people');
    const row = findRow_(table, 'ID', id);
    if (!row) return;
    deleteRowsWhere_(getTable_('visits'), 'Person ID', id);
    deleteRowsWhere_(getTable_('pictures'), 'Person ID', id);
    table.sheet.deleteRow(row);
  });
}

/* ------------------------------------------------------------------------ */
/* Visits                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Adds a visit (when input.id is empty) or updates one. When
 * input.updateReturnAt is true, the person's Return At is set to
 * input.returnAt (blank clears it).
 *
 * @param {Object} input
 * @returns {{visit: Object, person: Object}}
 */
function saveVisit(input) {
  return withLock_(() => {
    const people = getTable_('people');
    const personRow = findRow_(people, 'ID', input.personId);
    if (!personRow) throw new Error('This person no longer exists. They may have been deleted.');

    const table = getTable_('visits');
    const record = {
      'Created At': toDate_(input.createdAt) || new Date(),
      'Notes': cleanText_(input.notes, 'Notes')
    };
    let row = 0;
    if (input.id) {
      row = findRow_(table, 'ID', input.id);
      if (!row) throw new Error('This visit no longer exists. It may have been deleted.');
    } else {
      row = table.sheet.getLastRow() + 1;
      record['ID'] = Utilities.getUuid();
      record['Person ID'] = input.personId;
    }
    writeRecord_(table, row, record);

    if (input.updateReturnAt) {
      writeRecord_(people, personRow, { 'Return At': toDate_(input.returnAt) });
    }
    return {
      visit: toVisit_(readRow_(table, row)),
      person: toPerson_(readRow_(people, personRow))
    };
  });
}

/**
 * @param {string} id
 */
function deleteVisit(id) {
  withLock_(() => {
    const table = getTable_('visits');
    const row = findRow_(table, 'ID', id);
    if (row) table.sheet.deleteRow(row);
  });
}

/* ------------------------------------------------------------------------ */
/* Pictures                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Stores a picture and attaches it to a person.
 *
 * @param {string} personId
 * @param {string} dataUrl A base64 data URL such as "data:image/jpeg;base64,...".
 * @returns {Object} The person, including the new picture ID.
 */
function addPicture(personId, dataUrl) {
  const match = /^data:([\w\/+.-]+);base64,([A-Za-z0-9+\/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!match || PICTURE_MIME_TYPES.indexOf(match[1]) < 0) {
    throw new Error('Pictures must be JPEG, PNG, WebP, or GIF images.');
  }
  const mimeType = match[1];
  const base64 = match[2];
  const bytes = base64.length / 4 * 3 - (base64.match(/=*$/)[0].length);
  if (bytes > MAX_PICTURE_BYTES) {
    throw new Error(`Pictures can be at most ${Math.round(MAX_PICTURE_BYTES / 1024)} KB.`);
  }

  return withLock_(() => {
    const people = getTable_('people');
    const personRow = findRow_(people, 'ID', personId);
    if (!personRow) throw new Error('This person no longer exists. They may have been deleted.');

    const table = getTable_('pictures');
    const id = Utilities.getUuid();
    const values = table.headers.map(() => '');
    values[table.col['ID']] = toCell_(id);
    values[table.col['Person ID']] = toCell_(personId);
    values[table.col['Created At']] = new Date();
    values[table.col['Mime Type']] = toCell_(mimeType);
    values[table.col['Bytes']] = bytes;
    for (let i = 0; i < PICTURE_DATA_COLUMNS; i++) {
      values[table.col[`Data ${i + 1}`]] = toCell_(base64.slice(i * PICTURE_CHUNK_SIZE, (i + 1) * PICTURE_CHUNK_SIZE));
    }
    const row = table.sheet.getLastRow() + 1;
    table.sheet.getRange(row, 1, 1, values.length).setValues([values]);
    table.sheet.getRange(row, table.col['Created At'] + 1).setNumberFormat(DATE_FORMAT);

    const pictures = splitList_(readRow_(people, personRow)['Pictures']).concat(id);
    writeRecord_(people, personRow, { 'Pictures': pictures.join(',') });
    return toPerson_(readRow_(people, personRow));
  });
}

/**
 * @param {string} id
 * @returns {string} The picture as a data URL, or an empty string if it no
 *     longer exists.
 */
function getPicture(id) {
  const table = getTable_('pictures');
  const row = findRow_(table, 'ID', id);
  if (!row) return '';
  const record = readRow_(table, row);
  let base64 = '';
  for (let i = 1; i <= PICTURE_DATA_COLUMNS; i++) base64 += String(record[`Data ${i}`] || '');
  return `data:${record['Mime Type']};base64,${base64}`;
}

function deletePictures_(ids) {
  if (!ids.length) return;
  const table = getTable_('pictures');
  const rows = readColumns_(table, ['ID'])
    .filter(record => ids.indexOf(String(record['ID'])) >= 0)
    .map(record => record._row);
  deleteRows_(table.sheet, rows);
}

/* ------------------------------------------------------------------------ */
/* Converting records                                                       */
/* ------------------------------------------------------------------------ */

function toPerson_(record) {
  return {
    id: String(record['ID']),
    name: String(record['Name']),
    address: String(record['Address']),
    coordinates: String(record['Coordinates']),
    description: String(record['Description']),
    createdAt: toIso_(record['Created At']),
    isStudy: record['Is Study'] === true || String(record['Is Study']).toUpperCase() === 'TRUE',
    availableTimes: normalizeTimes_(splitList_(record['Available Times'])),
    pictures: splitList_(record['Pictures']),
    returnAt: toIso_(record['Return At'])
  };
}

function toVisit_(record) {
  return {
    id: String(record['ID']),
    personId: String(record['Person ID']),
    createdAt: toIso_(record['Created At']),
    notes: String(record['Notes'])
  };
}

function cleanText_(value, label, maxLength) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  const limit = maxLength || MAX_TEXT_LENGTH;
  if (text.length > limit) {
    throw new Error(`${label} is too long (${text.length.toLocaleString()} characters). The limit is ${limit.toLocaleString()}.`);
  }
  return text;
}

/**
 * Accepts "latitude, longitude" and returns it with six decimal places, which
 * is precise to about 10 cm.
 */
function normalizeCoordinates_(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  const lat = match && Number(match[1]);
  const lng = match && Number(match[2]);
  if (!match || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('Coordinates must be "latitude, longitude", for example "35.046900, -85.309700".');
  }
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/**
 * Keeps only valid "Day Period" values (such as "Mon Morning"), in calendar
 * order.
 */
function normalizeTimes_(times) {
  const wanted = (times || []).map(time => String(time).trim().toLowerCase());
  const result = [];
  DAYS.forEach(day => PERIODS.forEach(period => {
    const time = `${day} ${period}`;
    if (wanted.indexOf(time.toLowerCase()) >= 0) result.push(time);
  }));
  return result;
}

function splitList_(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

function toDate_(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date.getTime()) ? '' : date;
}

function toIso_(value) {
  if (isDate_(value)) return value.toISOString();
  const date = toDate_(value);
  return date ? date.toISOString() : '';
}

/**
 * Prefixes text with an apostrophe so Sheets stores it exactly as typed
 * instead of turning it into a formula, number, or date.
 */
function toCell_(value) {
  return typeof value === 'string' && value !== '' ? `'${value}` : value;
}

/* ------------------------------------------------------------------------ */
/* Sheet access                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Returns the sheet for a table, creating it or any missing headers first.
 *
 * @param {string} key A key of TABLES.
 * @returns {{sheet: Sheet, headers: string[], col: Object<string, number>}}
 *     col maps each header to its zero-based column index.
 */
function getTable_(key) {
  const def = TABLES[key];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(h => String(h).trim());
  const missing = def.headers.filter(h => headers.indexOf(h) < 0);
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    headers.push.apply(headers, missing);
  }

  const col = {};
  headers.forEach((header, index) => {
    if (header && !(header in col)) col[header] = index;
  });
  return { sheet: sheet, headers: headers, col: col };
}

function readRow_(table, row) {
  const values = table.sheet.getRange(row, 1, 1, table.headers.length).getValues()[0];
  return toRecord_(table, values, row);
}

function readRecords_(table) {
  const lastRow = table.sheet.getLastRow();
  if (lastRow < 2) return [];
  return table.sheet.getRange(2, 1, lastRow - 1, table.headers.length).getValues()
    .map((values, index) => toRecord_(table, values, index + 2));
}

/**
 * Reads only the given columns, which is much faster than readRecords_() on
 * the Pictures sheet.
 */
function readColumns_(table, headers) {
  const lastRow = table.sheet.getLastRow();
  if (lastRow < 2) return [];
  const records = [];
  for (let i = 0; i < lastRow - 1; i++) records.push({ _row: i + 2 });
  headers.forEach(header => {
    table.sheet.getRange(2, table.col[header] + 1, lastRow - 1, 1).getValues()
      .forEach((values, i) => records[i][header] = values[0]);
  });
  return records;
}

function toRecord_(table, values, row) {
  const record = { _row: row };
  table.headers.forEach((header, index) => {
    if (header && !(header in record)) record[header] = values[index];
  });
  return record;
}

/**
 * Writes only the given fields so other columns (including any of your own)
 * are left alone.
 */
function writeRecord_(table, row, record) {
  Object.keys(record).forEach(header => {
    const value = record[header];
    const cell = table.sheet.getRange(row, table.col[header] + 1);
    if (isDate_(value)) cell.setNumberFormat(DATE_FORMAT);
    if (typeof value === 'boolean') cell.setDataValidation(CHECKBOX_RULE);
    cell.setValue(toCell_(value));
  });
}

/**
 * @returns {number} The row number whose column exactly matches value, or 0.
 */
function findRow_(table, header, value) {
  const lastRow = table.sheet.getLastRow();
  if (!value || lastRow < 2) return 0;
  const cell = table.sheet.getRange(2, table.col[header] + 1, lastRow - 1, 1)
    .createTextFinder(String(value))
    .matchEntireCell(true)
    .findNext();
  return cell ? cell.getRow() : 0;
}

function deleteRowsWhere_(table, header, value) {
  const rows = readColumns_(table, [header])
    .filter(record => String(record[header]) === value)
    .map(record => record._row);
  deleteRows_(table.sheet, rows);
}

/**
 * Deletes rows from the bottom up, grouping neighbors into one call.
 */
function deleteRows_(sheet, rows) {
  const sorted = rows.slice().sort((a, b) => b - a);
  let i = 0;
  while (i < sorted.length) {
    let start = sorted[i];
    let count = 1;
    while (i + count < sorted.length && sorted[i + count] === start - 1) {
      start--;
      count++;
    }
    sheet.deleteRows(start, count);
    i += count;
  }
}

function withLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Another save is in progress. Please try again.');
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}
