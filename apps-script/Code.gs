/**
 * RV Notes backend: keeps return visit notes in the spreadsheet this script is
 * bound to. The RV Notes app (a web page that also works offline) syncs with
 * it by sending JSON requests to doPost() along with this spreadsheet's secret
 * key. Use RV Notes → Connect app in the spreadsheet to connect a device.
 *
 * Only doGet(), doPost(), onOpen(), and the menu items are public. Everything
 * else ends in an underscore so it can't be called with google.script.run.
 *
 * @OnlyCurrentDoc
 */

// Where the RV Notes app is hosted. The Connect app link opens it.
const APP_URL = 'https://westc.github.io/rv-notes/';
const REPO_URL = 'https://github.com/westc/rv-notes';

// Each table is a sheet whose first row holds these headers. Columns are found
// by header name, so they can be reordered and extra columns can be added.
const TABLES = {
  people: {
    name: 'RVs',
    headers: ['ID', 'Name', 'Address', 'Coordinates', 'Description', 'Created At',
      'Is Study', 'Available Times', 'Pictures', 'Return At', 'Tags', 'Updated At', 'Synced At'],
    dates: ['Created At', 'Return At'],
    checkboxes: ['Is Study']
  },
  visits: {
    name: 'Visits',
    headers: ['ID', 'Person ID', 'Created At', 'Notes', 'Updated At', 'Synced At'],
    dates: ['Created At'],
    checkboxes: []
  },
  pictures: {
    name: 'Pictures',
    headers: ['ID', 'Person ID', 'Created At', 'Mime Type', 'Bytes'],
    dates: ['Created At'],
    checkboxes: []
  },
  // Time spent in the ministry. Date is text (yyyy-mm-dd) so it never shifts
  // with time zones. Kind is "service" or "credit".
  time: {
    name: 'Time',
    headers: ['ID', 'Date', 'Minutes', 'Kind', 'Note', 'Updated At', 'Synced At'],
    dates: [],
    checkboxes: []
  },
  // Bible studies conducted each month (yyyy-mm). Person ID links to an RV and
  // may be empty. Name is kept even if the RV is deleted later.
  studies: {
    name: 'Studies',
    headers: ['ID', 'Month', 'Person ID', 'Name', 'Updated At', 'Synced At'],
    dates: [],
    checkboxes: []
  },
  // One row per month (ID "report-yyyy-mm"). Shared is "yes", "no", or empty
  // for automatic. The columns from Sent At on are what was sent.
  reports: {
    name: 'Reports',
    headers: ['ID', 'Month', 'Shared', 'Comments', 'Sent At', 'Hours', 'Credit Hours', 'Studies',
      'Carried Minutes', 'Carried Credit Minutes', 'Report Text', 'Updated At', 'Synced At'],
    dates: [],
    checkboxes: []
  },
  // Lets other devices find out what was deleted since they last synced.
  deleted: {
    name: 'Deleted',
    headers: ['ID', 'Table', 'Deleted At', 'Synced At'],
    dates: [],
    checkboxes: []
  }
};

// Pictures are stored as base64 split across several cells, because a cell
// holds at most 50,000 characters.
const MAX_PICTURE_BYTES = 120 * 1024;
const PICTURE_CHUNK_SIZE = 45000;
const PICTURE_DATA_COLUMNS = Math.ceil(Math.ceil(MAX_PICTURE_BYTES / 3) * 4 / PICTURE_CHUNK_SIZE);
for (let i = 1; i <= PICTURE_DATA_COLUMNS; i++) TABLES.pictures.headers.push(`Data ${i}`);
const PICTURE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_PICTURES_PER_REQUEST = 20;
const MAX_CHANGES_PER_REQUEST = 500;

// The most characters a single text cell can hold.
const MAX_TEXT_LENGTH = 50000;

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PERIODS = ['Morning', 'Afternoon', 'Evening'];

const DATE_FORMAT = 'yyyy-mm-dd h:mm am/pm';
// Letters (in any language), numbers, and hyphens. Must match TAG_PATTERN in
// js/util.js.
const TAG_PATTERN = /^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u;
const MAX_TAG_LENGTH = 40;
const MAX_TAGS = 30;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const DAY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/* ------------------------------------------------------------------------ */
/* Web app                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Opening the web app URL in a browser only shows a short message. It also
 * remembers the URL for the Connect app dialog.
 */
function doGet() {
  const url = ScriptApp.getService().getUrl();
  const props = PropertiesService.getScriptProperties();
  if (url && props.getProperty('webAppUrl') !== url) props.setProperty('webAppUrl', url);
  return ContentService.createTextOutput(
    'RV Notes is running. To use it, open the spreadsheet and choose RV Notes → Connect app.');
}

/**
 * Handles a request from the RV Notes app. The body is JSON:
 * {key, action, params}. The response is JSON: {ok: true, result} or
 * {ok: false, error, code}, where code is "auth" when the key is wrong.
 *
 * The app sends the body as text/plain so browsers don't send a CORS preflight
 * request, which Apps Script can't answer.
 */
function doPost(e) {
  let response;
  try {
    let request;
    try {
      request = JSON.parse(e && e.postData ? e.postData.contents : '');
    } catch (err) {
      throw new Error('The request wasn’t valid JSON.');
    }
    checkKey_(request && request.key);
    const action = ACTIONS[request.action];
    if (!action || !Object.prototype.hasOwnProperty.call(ACTIONS, request.action)) {
      throw new Error('Unknown action. The app may be newer than this script. Update the script and deploy a new version.');
    }
    response = { ok: true, result: action(request.params || {}) };
  } catch (err) {
    response = { ok: false, error: err && err.message ? err.message : String(err), code: (err && err.code) || '' };
  }
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

const ACTIONS = {
  info: info_,
  sync: sync_,
  putPicture: putPicture_,
  getPictures: getPictures_,
  findPlaces: params => findPlaces_(params.query, params.bounds)
};

function apiError_(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function checkKey_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty('apiKey');
  if (!expected) {
    throw apiError_('This spreadsheet isn’t set up for the app yet. In the spreadsheet, choose RV Notes → Connect app.', 'auth');
  }
  if (typeof key !== 'string' || key !== expected) {
    throw apiError_('This spreadsheet’s key has changed. Connect again with the link from RV Notes → Connect app.', 'auth');
  }
}

/**
 * @returns {{name: string, maxPictureBytes: number}}
 */
function info_() {
  return {
    name: SpreadsheetApp.getActiveSpreadsheet().getName(),
    maxPictureBytes: MAX_PICTURE_BYTES,
    tables: Object.keys(SYNC_TABLES)
  };
}

/* ------------------------------------------------------------------------ */
/* Spreadsheet menu                                                         */
/* ------------------------------------------------------------------------ */

// The menu's items: [text key, function], or null for a separator. Loader.gs
// builds its menu from this too, so new items reach every spreadsheet.
const MENU = [
  ['menu.connect', 'showConnectDialog'],
  ['menu.resetKey', 'resetKey'],
  null,
  ['menu.setUp', 'setUpSheets'],
  ['menu.github', 'openGitHub']
];

function onOpen() {
  buildMenu_(SpreadsheetApp.getUi().createMenu('RV Notes'), name => name).addToUi();
}

/**
 * Adds MENU's items to menu. handlerName(functionName, index) returns the
 * name of the global function each item runs.
 */
function buildMenu_(menu, handlerName) {
  MENU.forEach((item, index) => {
    if (item) {
      menu.addItem(sheetText_(item[0]), handlerName(item[1], index));
    } else {
      menu.addSeparator();
    }
  });
  return menu;
}

function runMenuItem_(index) {
  const handlers = { showConnectDialog, resetKey, setUpSheets, openGitHub };
  return handlers[MENU[index][1]]();
}

function setUpSheets() {
  Object.keys(TABLES).forEach(getTable_);
}

/**
 * Shows a link and QR code that add this spreadsheet to the RV Notes app. The
 * QR code is drawn in the dialog by qrcode-generator, which is pinned with a
 * Subresource Integrity hash so a changed copy on the CDN won't run.
 */
function showConnectDialog() {
  setUpSheets();
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('apiKey')) props.setProperty('apiKey', newKey_());
  const data = {
    appUrl: APP_URL,
    key: props.getProperty('apiKey'),
    name: SpreadsheetApp.getActiveSpreadsheet().getName(),
    webAppUrl: props.getProperty('webAppUrl') || ScriptApp.getService().getUrl() || '',
    text: { needUrl: sheetText_('connect.needUrl'), noQr: sheetText_('connect.noQr'), copied: sheetText_('connect.copied') }
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = fillText_(CONNECT_DIALOG_HTML).replace('{{DATA}}', () => json);
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(420).setHeight(620), sheetText_('connect.title'));
}

function resetKey() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(sheetText_('reset.title'), sheetText_('reset.body'), ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty('apiKey', newKey_());
  showConnectDialog();
}

function openGitHub() {
  const html = fillText_(`<!DOCTYPE html>
<html><head><base target="_blank">
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #1e293b; }
  a.button { display: inline-block; margin-top: 8px; padding: 8px 14px; border-radius: 6px; background: #4f46e5; color: #fff; text-decoration: none; }
</style></head>
<body>
  <p>{{github.body}}</p>
  <a class="button" href="${REPO_URL}">{{github.open}}</a>
  <p style="color:#64748b;font-size:12px">${REPO_URL}</p>
</body></html>`);
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(380).setHeight(180), sheetText_('github.title'));
}

/* Spreadsheet text, in the language of the person using the spreadsheet. */

const SHEET_TEXT = {
  en: {
    'menu.connect': 'Connect app',
    'menu.resetKey': 'Reset key',
    'menu.setUp': 'Set up sheets',
    'menu.github': 'RV Notes on GitHub',
    'connect.title': 'Connect the RV Notes app',
    'connect.name': 'Name in the app',
    'connect.nameHint': 'For example "Chris’ RVs". It can be changed in the app.',
    'connect.url': 'Web app URL',
    'connect.urlHint': 'In Apps Script: Deploy → Manage deployments → copy the Web app URL (it ends in /exec).',
    'connect.scan': 'In the RV Notes app, tap <b>Scan QR code</b> and point it at this code. (Your phone’s camera app works too.)',
    'connect.copyLabel': 'Or copy the link',
    'connect.copy': 'Copy',
    'connect.copied': 'Copied',
    'connect.warning': 'Anyone with this link can read and change the RV notes in this spreadsheet, so only share it with people you trust. <b>RV Notes → Reset key</b> disconnects every device.',
    'connect.needUrl': 'Paste the Web app URL above to get the link.',
    'connect.noQr': 'The QR code couldn’t load. Copy the link instead.',
    'reset.title': 'Reset key?',
    'reset.body': 'Every device connected to this spreadsheet will stop syncing until it connects again with the new link. Changes a device hasn’t synced yet are kept on it until then.',
    'github.title': 'RV Notes on GitHub',
    'github.body': 'RV Notes is open source. Its code, setup steps, and instructions are on GitHub.',
    'github.open': 'Open GitHub'
  },
  es: {
    'menu.connect': 'Conectar la app',
    'menu.resetKey': 'Restablecer clave',
    'menu.setUp': 'Preparar hojas',
    'menu.github': 'RV Notes en GitHub',
    'connect.title': 'Conectar la app RV Notes',
    'connect.name': 'Nombre en la app',
    'connect.nameHint': 'Por ejemplo, "Revisitas de Chris". Se puede cambiar en la app.',
    'connect.url': 'URL de la aplicación web',
    'connect.urlHint': 'En Apps Script: Implementar → Gestionar implementaciones → copia la URL de la aplicación web (termina en /exec).',
    'connect.scan': 'En la app RV Notes, toca <b>Escanear código QR</b> y apunta a este código. (La cámara del teléfono también sirve).',
    'connect.copyLabel': 'O copia el enlace',
    'connect.copy': 'Copiar',
    'connect.copied': 'Copiado',
    'connect.warning': 'Cualquier persona con este enlace puede ver y cambiar las notas de revisitas de esta hoja de cálculo, así que compártelo solo con personas de confianza. <b>RV Notes → Restablecer clave</b> desconecta todos los dispositivos.',
    'connect.needUrl': 'Pega arriba la URL de la aplicación web para obtener el enlace.',
    'connect.noQr': 'No se pudo cargar el código QR. Copia el enlace.',
    'reset.title': '¿Restablecer clave?',
    'reset.body': 'Todos los dispositivos conectados a esta hoja de cálculo dejarán de sincronizar hasta que se conecten de nuevo con el enlace nuevo. Los cambios que un dispositivo aún no haya sincronizado se guardan en él hasta entonces.',
    'github.title': 'RV Notes en GitHub',
    'github.body': 'RV Notes es de código abierto. Su código, los pasos para prepararlo y las instrucciones están en GitHub.',
    'github.open': 'Abrir GitHub'
  },
  pt: {
    'menu.connect': 'Conectar o app',
    'menu.resetKey': 'Redefinir chave',
    'menu.setUp': 'Preparar páginas',
    'menu.github': 'RV Notes no GitHub',
    'connect.title': 'Conectar o app RV Notes',
    'connect.name': 'Nome no app',
    'connect.nameHint': 'Por exemplo, "Revisitas do Chris". Dá para mudar no app.',
    'connect.url': 'URL do app da Web',
    'connect.urlHint': 'No Apps Script: Implantar → Gerenciar implantações → copie o URL do app da Web (termina em /exec).',
    'connect.scan': 'No app RV Notes, toque em <b>Ler código QR</b> e aponte para este código. (A câmera do celular também funciona.)',
    'connect.copyLabel': 'Ou copie o link',
    'connect.copy': 'Copiar',
    'connect.copied': 'Copiado',
    'connect.warning': 'Qualquer pessoa com este link pode ver e alterar as anotações de revisitas desta planilha, então compartilhe só com pessoas de confiança. <b>RV Notes → Redefinir chave</b> desconecta todos os aparelhos.',
    'connect.needUrl': 'Cole acima o URL do app da Web para obter o link.',
    'connect.noQr': 'Não foi possível carregar o código QR. Copie o link.',
    'reset.title': 'Redefinir chave?',
    'reset.body': 'Todos os aparelhos conectados a esta planilha vão parar de sincronizar até se conectarem de novo com o novo link. As alterações que um aparelho ainda não sincronizou ficam guardadas nele até lá.',
    'github.title': 'RV Notes no GitHub',
    'github.body': 'O RV Notes é de código aberto. O código, os passos de configuração e as instruções estão no GitHub.',
    'github.open': 'Abrir o GitHub'
  }
};

function sheetLanguage_() {
  let locale = '';
  try {
    locale = Session.getActiveUserLocale() || '';
  } catch (err) {
    // Some contexts can't tell; English it is.
  }
  return /^es/i.test(locale) ? 'es' : /^pt/i.test(locale) ? 'pt' : 'en';
}

function sheetText_(key) {
  return SHEET_TEXT[sheetLanguage_()][key] || SHEET_TEXT.en[key];
}

/** Replaces {{key}} in HTML with the text for key. */
function fillText_(html) {
  return html.replace(/\{\{([\w.]+)\}\}/g, (match, key) => key === 'DATA' ? match : sheetText_(key));
}

// About 244 random bits.
function newKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

const CONNECT_DIALOG_HTML = `<!DOCTYPE html>
<html>
<head>
<base target="_blank">
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #1e293b; margin: 0; }
  label { display: block; font-weight: bold; margin: 12px 0 4px; }
  input { box-sizing: border-box; width: 100%; padding: 6px 8px; font-size: 14px; border: 1px solid #cbd5e1; border-radius: 6px; }
  .hint { color: #64748b; font-size: 12px; margin: 4px 0 0; }
  .error { color: #b91c1c; }
  #qr { text-align: center; margin: 12px 0 4px; min-height: 40px; }
  #qr svg { width: 240px; height: 240px; }
  .row { display: flex; gap: 8px; }
  button { padding: 6px 12px; font-size: 14px; border-radius: 6px; border: 1px solid #4f46e5; background: #4f46e5; color: #fff; cursor: pointer; }
  .warning { background: #fef3c7; border-radius: 6px; padding: 8px; font-size: 12px; margin-top: 12px; }
</style>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"
  integrity="sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k"
  crossorigin="anonymous"></script>
</head>
<body>
  <label for="name">{{connect.name}}</label>
  <input id="name" autocomplete="off">
  <p class="hint">{{connect.nameHint}}</p>

  <label for="url">{{connect.url}}</label>
  <input id="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec">
  <p class="hint">{{connect.urlHint}}</p>

  <div id="qr"></div>
  <p class="hint" style="text-align:center">{{connect.scan}}</p>

  <label for="link">{{connect.copyLabel}}</label>
  <div class="row">
    <input id="link" readonly>
    <button type="button" id="copy">{{connect.copy}}</button>
  </div>

  <div class="warning">{{connect.warning}}</div>

<script>
  var data = {{DATA}};
  var nameInput = document.getElementById('name');
  var urlInput = document.getElementById('url');
  var linkInput = document.getElementById('link');
  var qrBox = document.getElementById('qr');
  nameInput.value = data.name;
  urlInput.value = /\\/exec$/.test(data.webAppUrl) ? data.webAppUrl : '';

  function base64Url(text) {
    var bytes = new TextEncoder().encode(text);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }

  function update() {
    var url = urlInput.value.trim();
    if (!/^https:\\/\\/script\\.google\\.com\\/.+\\/exec$/.test(url)) {
      linkInput.value = '';
      qrBox.innerHTML = '<p class="error"></p>';
      qrBox.firstChild.textContent = data.text.needUrl;
      return;
    }
    var payload = JSON.stringify({ u: url, k: data.key, n: nameInput.value.trim() });
    var link = data.appUrl + '#connect=' + base64Url(payload);
    linkInput.value = link;
    if (typeof qrcode !== 'function') {
      qrBox.innerHTML = '<p class="error"></p>';
      qrBox.firstChild.textContent = data.text.noQr;
      return;
    }
    var qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    qrBox.innerHTML = qr.createSvgTag(4, 8);
  }

  nameInput.addEventListener('input', update);
  urlInput.addEventListener('input', update);
  document.getElementById('copy').addEventListener('click', function () {
    linkInput.select();
    document.execCommand('copy');
    this.textContent = data.text.copied;
  });
  update();
</script>
</body>
</html>`;

/* ------------------------------------------------------------------------ */
/* Sync                                                                     */
/* ------------------------------------------------------------------------ */

// The tables the app syncs. fields() checks the app's record and turns it into
// sheet fields; toApp() turns a sheet row back into the app's record.
const SYNC_TABLES = {
  people: { fields: personFields_, toApp: toPerson_ },
  visits: { fields: visitFields_, toApp: toVisit_ },
  time: { fields: timeFields_, toApp: toTime_ },
  studies: { fields: studyFields_, toApp: toStudy_ },
  reports: { fields: reportFields_, toApp: toReport_ }
};

/**
 * Saves the app's changes, then returns what changed since the app last
 * synced.
 *
 * Each change is {table, op: "put"|"delete", id, record, updatedAt}, where
 * table is a key of SYNC_TABLES. When two devices edit the same record, the
 * edit with the later updatedAt wins. Deleting always wins, and deleting a
 * person also deletes their visits and pictures.
 *
 * @param {{since: string, changes: Object[]}} params since is the cursor from
 *     the previous sync, or empty to get everything.
 * @returns {{cursor: string, full: boolean, tables: string[],
 *     deleted: {table: string, id: string}[], rejected: Object[]}} Also has an
 *     array per table (people, visits, …) with every record changed since the
 *     cursor plus every record the request touched, so the app always ends up
 *     with the saved version. tables lists which tables this script syncs.
 */
function sync_(params) {
  const changes = Array.isArray(params.changes) ? params.changes : [];
  if (changes.length > MAX_CHANGES_PER_REQUEST) throw new Error('Too many changes in one request.');
  const since = typeof params.since === 'string' ? params.since : '';

  return withLock_(() => {
    const tableKeys = Object.keys(SYNC_TABLES);
    const db = { deleted: loadTable_('deleted'), removedPictureIds: [], removedPicturePeople: [] };
    tableKeys.forEach(key => db[key] = loadTable_(key));
    const now = new Date().toISOString();

    // Rows typed into the sheet by hand have no Synced At, so they're marked
    // to reach the app on its next sync.
    tableKeys.forEach(key => db[key].records.forEach(record => {
      if (!record['Synced At']) setFields_(db[key], record, { 'Synced At': now });
    }));

    const touched = {};
    const rejected = [];
    changes.forEach(change => {
      const id = change && typeof change.id === 'string' ? change.id : '';
      try {
        applyChange_(db, change, now);
      } catch (err) {
        rejected.push({ table: change && change.table, id, error: err.message });
      }
      touched[id] = true;
    });

    tableKeys.concat('deleted').forEach(key => saveTable_(db[key]));
    deletePictureRows_(db.removedPictureIds, db.removedPicturePeople);

    const result = { cursor: now, full: !since, tables: tableKeys, deleted: [], rejected };
    const isNew = record => !since || touched[String(record['ID'])] || toIso_(record['Synced At']) >= since;
    tableKeys.forEach(key => {
      result[key] = db[key].records.filter(r => !r._deleted && isNew(r)).map(r => SYNC_TABLES[key].toApp(r));
    });
    if (since) {
      db.deleted.records.filter(isNew).forEach(r => result.deleted.push({ table: String(r['Table']), id: String(r['ID']) }));
    }
    return result;
  });
}

function applyChange_(db, change, now) {
  if (!change || !Object.prototype.hasOwnProperty.call(SYNC_TABLES, change.table)) {
    throw new Error('Unknown table. The app may be newer than this script. Update the script and deploy a new version.');
  }
  const id = checkId_(change.id);
  const table = db[change.table];
  const existing = table.byId[id];

  if (change.op === 'delete') {
    if (existing && !existing._deleted) {
      removeRecord_(db, table, existing, now);
    } else {
      addTombstone_(db, change.table, id, now);
    }
    return;
  }
  if (change.op !== 'put') throw new Error('Unknown change.');

  // Deleted records stay deleted.
  if (db.deleted.byId[id]) return;
  const updatedAt = toIso_(change.updatedAt) || now;
  // A newer edit is already saved.
  if (existing && toIso_(existing['Updated At']) > updatedAt) return;

  const fields = SYNC_TABLES[change.table].fields(change.record || {}, existing);
  if (change.table === 'people') {
    if (existing) {
      const kept = splitList_(fields['Pictures']);
      splitList_(existing['Pictures']).forEach(pictureId => {
        if (kept.indexOf(pictureId) < 0) db.removedPictureIds.push(pictureId);
      });
    }
  } else if (change.table === 'visits') {
    // The person was deleted on another device.
    if (db.deleted.byId[fields['Person ID']]) {
      addTombstone_(db, 'visits', id, now);
      return;
    }
  }
  fields['Updated At'] = updatedAt;
  fields['Synced At'] = now;
  if (existing) {
    setFields_(table, existing, fields);
  } else {
    fields['ID'] = id;
    addRecord_(table, fields);
  }
}

function removeRecord_(db, table, record, now) {
  const id = String(record['ID']);
  record._deleted = true;
  addTombstone_(db, table.key, id, now);
  if (table.key === 'people') {
    db.visits.records
      .filter(visit => !visit._deleted && String(visit['Person ID']) === id)
      .forEach(visit => removeRecord_(db, db.visits, visit, now));
    db.removedPicturePeople.push(id);
  }
}

function addTombstone_(db, tableKey, id, now) {
  if (db.deleted.byId[id]) return;
  addRecord_(db.deleted, { 'ID': id, 'Table': tableKey, 'Deleted At': now, 'Synced At': now });
}

function personFields_(input, existing) {
  const name = cleanText_(input.name, 'Name', 500);
  if (!name) throw new Error('Name is required.');
  return {
    'Name': name,
    'Address': cleanText_(input.address, 'Address', 2000),
    'Coordinates': normalizeCoordinates_(input.coordinates),
    'Description': cleanText_(input.description, 'Description'),
    'Created At': toDate_(input.createdAt) || (existing && toDate_(existing['Created At'])) || new Date(),
    'Is Study': !!input.isStudy,
    'Available Times': normalizeTimes_(input.availableTimes).join(', '),
    'Pictures': (Array.isArray(input.pictures) ? input.pictures : []).filter(isId_).join(','),
    'Return At': toDate_(input.returnAt),
    'Tags': normalizeTags_(input.tags).join(', ')
  };
}

function visitFields_(input, existing) {
  return {
    'Person ID': checkId_(input.personId || (existing && String(existing['Person ID']))),
    'Created At': toDate_(input.createdAt) || (existing && toDate_(existing['Created At'])) || new Date(),
    'Notes': cleanText_(input.notes, 'Notes')
  };
}

function timeFields_(input) {
  const date = String(input.date || '');
  if (!DAY_PATTERN.test(date)) throw new Error('Time entries need a date.');
  const minutes = Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    throw new Error('A time entry must be between 1 minute and 24 hours.');
  }
  return {
    'Date': date,
    'Minutes': minutes,
    'Kind': input.kind === 'credit' ? 'credit' : 'service',
    'Note': cleanText_(input.note, 'Note', 2000)
  };
}

function studyFields_(input) {
  const name = cleanText_(input.name, 'Name', 500);
  if (!name) throw new Error('Studies need a name.');
  return {
    'Month': checkMonth_(input.month),
    'Person ID': input.personId ? checkId_(input.personId) : '',
    'Name': name
  };
}

function reportFields_(input) {
  const count = (value, label) => {
    if (value === '' || value == null) return '';
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 1000000) throw new Error(`${label} must be a whole number.`);
    return number;
  };
  return {
    'Month': checkMonth_(input.month),
    'Shared': input.shared === 'yes' || input.shared === 'no' ? input.shared : '',
    'Comments': cleanText_(input.comments, 'Comments', 5000),
    'Sent At': toIso_(input.sentAt),
    'Hours': count(input.hours, 'Hours'),
    'Credit Hours': count(input.creditHours, 'Credit hours'),
    'Studies': count(input.studies, 'Studies'),
    'Carried Minutes': count(input.carriedMinutes, 'Carried minutes'),
    'Carried Credit Minutes': count(input.carriedCreditMinutes, 'Carried credit minutes'),
    'Report Text': cleanText_(input.text, 'Report text', 10000)
  };
}

function checkMonth_(value) {
  if (!MONTH_PATTERN.test(String(value || ''))) throw new Error('Invalid month.');
  return value;
}

/* ------------------------------------------------------------------------ */
/* Pictures                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Stores a picture. The app makes the ID and lists it in the person's
 * pictures. Sending the same picture again does nothing.
 *
 * @param {{id: string, personId: string, dataUrl: string}} params dataUrl is a
 *     base64 data URL such as "data:image/jpeg;base64,...".
 * @returns {{id: string}}
 */
function putPicture_(params) {
  const id = checkId_(params.id);
  const personId = checkId_(params.personId);
  const match = /^data:([\w\/+.-]+);base64,([A-Za-z0-9+\/]+={0,2})$/.exec(String(params.dataUrl || ''));
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
    const table = getTable_('pictures');
    if (findRow_(table, 'ID', id)) return { id };
    // The person was deleted on another device.
    if (findRow_(getTable_('deleted'), 'ID', personId)) return { id };

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
    return { id };
  });
}

/**
 * @param {{ids: string[]}} params At most MAX_PICTURES_PER_REQUEST IDs.
 * @returns {Object<string, ?string>} Each picture as a data URL, or null if it
 *     no longer exists.
 */
function getPictures_(params) {
  const ids = (Array.isArray(params.ids) ? params.ids : []).filter(isId_).slice(0, MAX_PICTURES_PER_REQUEST);
  const result = {};
  ids.forEach(id => result[id] = null);
  if (!ids.length) return result;

  const table = getTable_('pictures');
  readColumns_(table, ['ID'])
    .filter(record => ids.indexOf(String(record['ID'])) >= 0)
    .forEach(({ _row }) => {
      const record = readRow_(table, _row);
      let base64 = '';
      for (let i = 1; i <= PICTURE_DATA_COLUMNS; i++) base64 += String(record[`Data ${i}`] || '');
      result[String(record['ID'])] = `data:${record['Mime Type']};base64,${base64}`;
    });
  return result;
}

/**
 * Deletes the pictures with the given IDs and every picture of the given
 * people.
 */
function deletePictureRows_(ids, personIds) {
  if (!ids.length && !personIds.length) return;
  const table = getTable_('pictures');
  const rows = readColumns_(table, ['ID', 'Person ID'])
    .filter(record => ids.indexOf(String(record['ID'])) >= 0 || personIds.indexOf(String(record['Person ID'])) >= 0)
    .map(record => record._row);
  deleteRows_(table.sheet, rows);
}

/* ------------------------------------------------------------------------ */
/* Finding places                                                           */
/* ------------------------------------------------------------------------ */

// Only links to these hosts are fetched, e.g. www.google.com, maps.google.co.uk,
// and maps.app.goo.gl.
const GOOGLE_HOST = /^(?:[\w-]+\.)*(?:google\.[a-z]{2,3}(?:\.[a-z]{2})?|goo\.gl)$/i;

/**
 * Finds places for the map picker.
 *
 * @param {string} query An address, a Google Maps link (including share links
 *     such as https://maps.app.goo.gl/…), or "latitude, longitude".
 * @param {number[]=} bounds [south, west, north, east] of the visible map, so
 *     nearby matches are preferred.
 * @returns {{name: string, address: string, coordinates: string}[]} Up to 5
 *     places, best match first.
 */
function findPlaces_(query, bounds) {
  const text = cleanText_(query, 'Search', 2000).replace(/\s+/g, ' ');
  if (!text) throw new Error('Type an address or paste a Google Maps link.');

  const coords = parseLatLng_(text);
  if (coords) return [placeAt_(coords, '')];

  const link = /https?:\/\/\S+/i.exec(text);
  if (link) return placesFromLink_(link[0]);

  return geocode_(text, bounds);
}

function placesFromLink_(link) {
  const urls = resolveLink_(link);
  for (const url of urls) {
    const coords = coordsFromMapsUrl_(url);
    if (coords) return [placeAt_(coords, placeTextFromMapsUrl_(url))];
  }
  // Some links only name the place, e.g. https://maps.google.com/?q=Some+Place
  for (const url of urls) {
    const text = placeTextFromMapsUrl_(url);
    if (text) return geocode_(text);
  }
  throw new Error('Couldn’t find a location in that link. In Google Maps, tap the place, then Share → Copy link.');
}

/**
 * Follows redirects (share links redirect to the full Google Maps URL) and
 * returns each URL along the way.
 */
function resolveLink_(url) {
  const urls = [];
  for (let i = 0; i < 6 && url; i++) {
    const origin = /^https?:\/\/([^/?#:]+)/i.exec(url);
    if (!origin || !GOOGLE_HOST.test(origin[1])) {
      if (!urls.length) throw new Error('Only Google Maps links are supported.');
      break;
    }
    urls.push(url);
    if (coordsFromMapsUrl_(url)) break;
    const response = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
    const headers = response.getHeaders();
    const location = headers['Location'] || headers['location'] || '';
    url = location.charAt(0) === '/' ? origin[0] + location : location;
  }
  return urls;
}

/**
 * Decodes a URL fully, including links nested in it (such as the "continue"
 * parameter of Google's cookie consent page).
 */
function decodeUrl_(url) {
  let text = String(url);
  for (let i = 0; i < 3; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(text.replace(/\+/g, ' '));
    } catch (e) {
      break;
    }
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function coordsFromMapsUrl_(url) {
  const text = decodeUrl_(url);
  const patterns = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, // The place's pin.
    /[?&](?:q|query|ll|destination|daddr)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/,
    /\/(?:place|search)\/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/ // The middle of the map, when there's no pin.
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const coords = match && toLatLng_(match[1], match[2]);
    if (coords) return coords;
  }
  return null;
}

/**
 * @returns {string} The place name or search text in a Google Maps URL, or an
 *     empty string if it only has coordinates.
 */
function placeTextFromMapsUrl_(url) {
  const text = decodeUrl_(url);
  const match = /\/(?:place|search)\/([^/@?#]+)/.exec(text) ||
    /[?&](?:q|query|destination|daddr)=([^&#]+)/.exec(text);
  const place = match ? match[1].trim() : '';
  // Dropped pins are named after their coordinates, e.g. 35°02'48.8"N 85°18'34.9"W.
  return /\d°|^-?\d+(?:\.\d+)?\s*,/.test(place) ? '' : place;
}

function placeAt_(coords, name) {
  let address = '';
  try {
    const result = Maps.newGeocoder().reverseGeocode(coords.lat, coords.lng).results[0];
    if (result) address = result.formatted_address;
  } catch (e) {
    // The address is only a convenience, so the coordinates are still returned.
  }
  return { name: name || '', address, coordinates: formatLatLng_(coords.lat, coords.lng) };
}

function geocode_(text, bounds) {
  const geocoder = Maps.newGeocoder();
  if (Array.isArray(bounds) && bounds.length === 4 &&
      bounds.every(value => typeof value === 'number' && isFinite(value))) {
    geocoder.setBounds(bounds[0], bounds[1], bounds[2], bounds[3]);
  }
  const response = geocoder.geocode(text);
  if (response.status !== 'OK' && response.status !== 'ZERO_RESULTS') {
    throw new Error(`Searching isn’t working right now (${response.status}). Please try again later.`);
  }
  const places = (response.results || []).slice(0, 5).map(result => ({
    name: '',
    address: result.formatted_address,
    coordinates: formatLatLng_(result.geometry.location.lat, result.geometry.location.lng)
  }));
  if (!places.length) throw new Error(`No places found for “${text}”.`);
  return places;
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
    returnAt: toIso_(record['Return At']),
    tags: splitList_(record['Tags']).filter(tag => TAG_PATTERN.test(tag)),
    updatedAt: toIso_(record['Updated At'])
  };
}

function toVisit_(record) {
  return {
    id: String(record['ID']),
    personId: String(record['Person ID']),
    createdAt: toIso_(record['Created At']),
    notes: String(record['Notes']),
    updatedAt: toIso_(record['Updated At'])
  };
}

function toTime_(record) {
  return {
    id: String(record['ID']),
    date: toDay_(record['Date']),
    minutes: Number(record['Minutes']) || 0,
    kind: record['Kind'] === 'credit' ? 'credit' : 'service',
    note: String(record['Note']),
    updatedAt: toIso_(record['Updated At'])
  };
}

function toStudy_(record) {
  return {
    id: String(record['ID']),
    month: toDay_(record['Month']).slice(0, 7),
    personId: String(record['Person ID']),
    name: String(record['Name']),
    updatedAt: toIso_(record['Updated At'])
  };
}

function toReport_(record) {
  const number = value => value === '' || value == null || isNaN(Number(value)) ? '' : Number(value);
  return {
    id: String(record['ID']),
    month: toDay_(record['Month']).slice(0, 7),
    shared: record['Shared'] === 'yes' || record['Shared'] === 'no' ? record['Shared'] : '',
    comments: String(record['Comments']),
    sentAt: toIso_(record['Sent At']),
    hours: number(record['Hours']),
    creditHours: number(record['Credit Hours']),
    studies: number(record['Studies']),
    carriedMinutes: number(record['Carried Minutes']),
    carriedCreditMinutes: number(record['Carried Credit Minutes']),
    text: String(record['Report Text']),
    updatedAt: toIso_(record['Updated At'])
  };
}

/**
 * Dates and months are stored as text, but Sheets turns ones typed by hand
 * into real dates. Either way this returns "yyyy-mm-dd" (or "yyyy-mm" text
 * as is).
 */
function toDay_(value) {
  if (!isDate_(value)) return String(value == null ? '' : value).trim();
  const pad = n => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function isId_(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function checkId_(value) {
  if (!isId_(value)) throw new Error('Invalid ID.');
  return value;
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
  const coords = parseLatLng_(text);
  if (!coords) {
    throw new Error('Coordinates must be "latitude, longitude", for example "35.046900, -85.309700".');
  }
  return formatLatLng_(coords.lat, coords.lng);
}

/**
 * @returns {?{lat: number, lng: number}} Null unless text is exactly
 *     "latitude, longitude" within range.
 */
function parseLatLng_(text) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  return match ? toLatLng_(match[1], match[2]) : null;
}

function toLatLng_(latText, lngText) {
  const lat = Number(latText);
  const lng = Number(lngText);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function formatLatLng_(lat, lng) {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/**
 * Keeps only valid "Day Period" values (such as "Mon Morning"), in calendar
 * order.
 */
function normalizeTimes_(times) {
  const wanted = (Array.isArray(times) ? times : []).map(time => String(time).trim().toLowerCase());
  const result = [];
  DAYS.forEach(day => PERIODS.forEach(period => {
    const time = `${day} ${period}`;
    if (wanted.indexOf(time.toLowerCase()) >= 0) result.push(time);
  }));
  return result;
}

/**
 * Checks tags and drops repeats (ignoring case), keeping the order.
 */
function normalizeTags_(tags) {
  const result = [];
  const seen = {};
  (Array.isArray(tags) ? tags : []).forEach(value => {
    const tag = String(value).trim();
    if (!tag) return;
    if (!TAG_PATTERN.test(tag) || tag.length > MAX_TAG_LENGTH) {
      throw new Error(`"${tag}" isn’t a valid tag. Tags can only have letters, numbers, and hyphens.`);
    }
    if (seen[tag.toLowerCase()]) return;
    seen[tag.toLowerCase()] = true;
    result.push(tag);
  });
  if (result.length > MAX_TAGS) throw new Error(`An RV can have at most ${MAX_TAGS} tags.`);
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
 * @returns {{key: string, def: Object, sheet: Sheet, headers: string[],
 *     col: Object<string, number>}} col maps each header to its zero-based
 *     column index.
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
  return { key, def, sheet, headers, col };
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
 * Loads a whole table so changes can be made in memory and then written with
 * saveTable_().
 */
function loadTable_(key) {
  const table = getTable_(key);
  table.records = readRecords_(table).filter(record => isId_(String(record['ID'])));
  table.byId = {};
  table.records.forEach(record => table.byId[String(record['ID'])] = record);
  return table;
}

function setFields_(table, record, fields) {
  Object.assign(record, fields);
  record._dirty = true;
}

function addRecord_(table, fields) {
  const record = Object.assign({ _row: 0, _dirty: true }, fields);
  table.records.push(record);
  table.byId[String(record['ID'])] = record;
  return record;
}

/**
 * Writes changed and new records, then deletes removed ones. Only the app's
 * own columns are written, so any columns you add (even formulas) are left
 * alone.
 */
function saveTable_(table) {
  const sheet = table.sheet;
  // The app's columns, grouped into runs of neighboring columns.
  const runs = [];
  table.def.headers.map(header => table.col[header]).sort((a, b) => a - b).forEach(index => {
    const last = runs[runs.length - 1];
    if (last && last.end === index - 1) {
      last.end = index;
    } else {
      runs.push({ start: index, end: index });
    }
  });
  const rowValues = (record, run) => {
    const values = [];
    for (let i = run.start; i <= run.end; i++) values.push(toCell_(record[table.headers[i]]));
    return values;
  };

  let wrote = false;
  table.records.filter(r => r._dirty && r._row && !r._deleted).forEach(record => {
    runs.forEach(run => sheet.getRange(record._row, run.start + 1, 1, run.end - run.start + 1)
      .setValues([rowValues(record, run)]));
    wrote = true;
  });

  const added = table.records.filter(r => !r._row && !r._deleted);
  if (added.length) {
    const firstRow = sheet.getLastRow() + 1;
    runs.forEach(run => sheet.getRange(firstRow, run.start + 1, added.length, run.end - run.start + 1)
      .setValues(added.map(record => rowValues(record, run))));
    added.forEach((record, i) => record._row = firstRow + i);
    wrote = true;
  }

  if (wrote) {
    const rows = sheet.getLastRow() - 1;
    table.def.dates.forEach(header => sheet.getRange(2, table.col[header] + 1, rows, 1).setNumberFormat(DATE_FORMAT));
    if (table.def.checkboxes.length) {
      const rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
      table.def.checkboxes.forEach(header => sheet.getRange(2, table.col[header] + 1, rows, 1).setDataValidation(rule));
    }
  }
  deleteRows_(sheet, table.records.filter(r => r._deleted && r._row).map(r => r._row));
  table.records.forEach(record => record._dirty = false);
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
