/**
 * RV Notes loader. Paste this into your spreadsheet's Apps Script once, in
 * place of Code.gs. It downloads the latest RV Notes backend (Code.gs) from
 * the RV Notes site and runs it, so updates reach your spreadsheet without
 * pasting anything again or deploying a new version.
 *
 * The downloaded code can only use the permissions you approve for this
 * script: this spreadsheet (@OnlyCurrentDoc), dialogs in it, and internet
 * requests. It can't open your other files.
 *
 * Downloads are cached for 10 minutes. If the site can't be reached, the last
 * copy that worked keeps running. RV Notes → Update now downloads right away.
 *
 * @OnlyCurrentDoc
 */

const RV_NOTES_CODE_URL = 'https://westc.github.io/rv-notes/apps-script/Code.gs';
const CODE_CACHE_SECONDS = 600;
// CacheService holds up to 100 KB per value and PropertiesService 9 KB, so
// the code is stored in pieces.
const CACHE_PIECE_SIZE = 90000;
const PROPERTY_PIECE_SIZE = 8000;

/* ------------------------------------------------------------------------ */
/* Entry points (each passes straight through to the downloaded code)       */
/* ------------------------------------------------------------------------ */

function doGet(e) {
  return backend_().doGet(e);
}

function doPost(e) {
  let backend;
  try {
    backend = backend_();
  } catch (err) {
    // Answers the app the way Code.gs does, so it can show the problem.
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message, code: 'server' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return backend.doPost(e);
}

/**
 * Builds the menu from the backend's MENU, so new items show up without
 * pasting this file again. Simple triggers can't download anything, so this
 * uses the copy already saved, if there is one.
 */
function onOpen() {
  const menu = SpreadsheetApp.getUi().createMenu('RV Notes');
  let saved = null;
  try {
    saved = backend_(true);
  } catch (err) {
    // Nothing saved yet, or this copy of the backend has no menu.
  }
  if (saved && saved.buildMenu) {
    saved.buildMenu(menu, (name, index) => `menuItem${index}`);
  } else {
    menu.addItem('Connect app', 'showConnectDialog')
      .addItem('Reset key', 'resetKey')
      .addSeparator()
      .addItem('Set up sheets', 'setUpSheets');
  }
  menu.addSeparator().addItem(loaderText_('update'), 'updateNow').addToUi();
}

// Menu items run these, which run the backend's item at the same index. They
// can't end in an underscore, because menus can't run private functions.
function menuItem0() { backend_().runMenuItem(0); }
function menuItem1() { backend_().runMenuItem(1); }
function menuItem2() { backend_().runMenuItem(2); }
function menuItem3() { backend_().runMenuItem(3); }
function menuItem4() { backend_().runMenuItem(4); }
function menuItem5() { backend_().runMenuItem(5); }
function menuItem6() { backend_().runMenuItem(6); }
function menuItem7() { backend_().runMenuItem(7); }
function menuItem8() { backend_().runMenuItem(8); }
function menuItem9() { backend_().runMenuItem(9); }

// For menus built before the backend had its own menu.
function showConnectDialog() {
  return backend_().showConnectDialog();
}

function resetKey() {
  return backend_().resetKey();
}

function setUpSheets() {
  return backend_().setUpSheets();
}

/**
 * Downloads the latest backend right away instead of waiting for the cache.
 */
function updateNow() {
  const ui = SpreadsheetApp.getUi();
  try {
    loadCode_(true);
    const props = PropertiesService.getScriptProperties();
    ui.alert(loaderText_('upToDate'),
      loaderText_('version').replace('{version}', props.getProperty('loader.hash'))
        .replace('{date}', new Date(props.getProperty('loader.fetchedAt')).toLocaleString()),
      ui.ButtonSet.OK);
  } catch (err) {
    ui.alert(loaderText_('failed'), err.message, ui.ButtonSet.OK);
  }
}

const LOADER_TEXT = {
  en: { update: 'Update now', upToDate: 'RV Notes is up to date', version: 'Version {version}, downloaded {date}.', failed: 'Couldn’t update RV Notes' },
  es: { update: 'Actualizar ahora', upToDate: 'RV Notes está actualizado', version: 'Versión {version}, descargada el {date}.', failed: 'No se pudo actualizar RV Notes' },
  pt: { update: 'Atualizar agora', upToDate: 'O RV Notes está atualizado', version: 'Versão {version}, baixada em {date}.', failed: 'Não foi possível atualizar o RV Notes' }
};

function loaderText_(key) {
  let locale = '';
  try {
    locale = Session.getActiveUserLocale() || '';
  } catch (err) {
    // English it is.
  }
  return LOADER_TEXT[/^es/i.test(locale) ? 'es' : /^pt/i.test(locale) ? 'pt' : 'en'][key];
}

/* ------------------------------------------------------------------------ */
/* Loading                                                                  */
/* ------------------------------------------------------------------------ */

let backend = null;

/**
 * Runs the backend code inside a function, so its doPost, doGet, and the rest
 * don't replace this file's, and returns its entry points.
 *
 * @param {boolean=} savedOnly Use the cached or saved copy without
 *     downloading (simple triggers like onOpen can't download).
 */
function backend_(savedOnly) {
  if (!backend) {
    const code = savedOnly ? savedCode_() : loadCode_(false);
    if (!code) throw new Error('No saved copy of RV Notes yet.');
    // Older backends don't have a menu of their own.
    backend = new Function(code + `
      ;return {
        doGet: doGet, doPost: doPost, showConnectDialog: showConnectDialog, resetKey: resetKey, setUpSheets: setUpSheets,
        buildMenu: typeof buildMenu_ === 'function' ? buildMenu_ : null,
        runMenuItem: typeof runMenuItem_ === 'function' ? runMenuItem_ : null
      };`)();
  }
  return backend;
}

function savedCode_() {
  const cache = CacheService.getScriptCache();
  return readPieces_(key => cache.get(key), 'loader.cache') ||
    readPieces_(key => PropertiesService.getScriptProperties().getProperty(key), 'loader.code');
}

/**
 * @param {boolean} force Download even if a recent copy is cached.
 * @returns {string} The backend's code.
 */
function loadCode_(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    const cached = readPieces_(key => cache.get(key), 'loader.cache');
    if (cached) return cached;
  }
  let code;
  try {
    code = download_();
  } catch (err) {
    // Keeps running the last copy that worked, and tries again in a minute.
    const lastGood = readPieces_(key => PropertiesService.getScriptProperties().getProperty(key), 'loader.code');
    if (!lastGood || force) throw err;
    cachePieces_(cache, lastGood, 60);
    return lastGood;
  }
  cachePieces_(cache, code, CODE_CACHE_SECONDS);
  saveLastGood_(code);
  return code;
}

function download_() {
  let response;
  try {
    // The query skips copies cached along the way.
    response = UrlFetchApp.fetch(`${RV_NOTES_CODE_URL}?t=${Date.now()}`, { muteHttpExceptions: true });
  } catch (err) {
    throw new Error(`Couldn’t download RV Notes (${err.message}).`);
  }
  if (response.getResponseCode() !== 200) {
    throw new Error(`Couldn’t download RV Notes (HTTP ${response.getResponseCode()}).`);
  }
  const code = response.getContentText();
  if (code.indexOf('RV Notes backend') < 0 || code.indexOf('function doPost(') < 0) {
    throw new Error('The downloaded RV Notes code didn’t look right, so it wasn’t used.');
  }
  try {
    // Compiles without running it, to catch a broken download.
    new Function(code);
  } catch (err) {
    throw new Error(`The downloaded RV Notes code has an error, so it wasn’t used (${err.message}).`);
  }
  return code;
}

/** Stores the code in pieces of up to maxSize under prefix.0, prefix.1, … */
function pieces_(code, prefix, maxSize) {
  const values = {};
  let count = 0;
  for (let i = 0; i < code.length; i += maxSize) values[`${prefix}.${count++}`] = code.slice(i, i + maxSize);
  values[`${prefix}.count`] = String(count);
  return values;
}

function readPieces_(get, prefix) {
  const count = Number(get(`${prefix}.count`));
  if (!count) return '';
  let code = '';
  for (let i = 0; i < count; i++) {
    const piece = get(`${prefix}.${i}`);
    if (piece == null) return '';
    code += piece;
  }
  return code;
}

function cachePieces_(cache, code, seconds) {
  cache.putAll(pieces_(code, 'loader.cache', CACHE_PIECE_SIZE), seconds);
}

/**
 * Keeps the last code that downloaded and compiled, for when the site can't
 * be reached. Only writes when it changed.
 */
function saveLastGood_(code) {
  const props = PropertiesService.getScriptProperties();
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, code, Utilities.Charset.UTF_8)
    .map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('').slice(0, 12);
  props.setProperty('loader.fetchedAt', new Date().toISOString());
  if (props.getProperty('loader.hash') === hash) return;
  const old = Number(props.getProperty('loader.code.count')) || 0;
  for (let i = 0; i < old; i++) props.deleteProperty(`loader.code.${i}`);
  props.setProperties(pieces_(code, 'loader.code', PROPERTY_PIECE_SIZE));
  props.setProperty('loader.hash', hash);
}

/**
 * Never called. Apps Script decides which permissions to ask for by reading
 * this file, and the downloaded code needs these.
 */
function permissionsUsedByTheBackend_() {
  SpreadsheetApp.getActiveSpreadsheet();
  SpreadsheetApp.getUi();
  HtmlService.createHtmlOutput('');
  UrlFetchApp.fetch('');
  Maps.newGeocoder();
  LockService.getScriptLock();
  ScriptApp.getService();
}
