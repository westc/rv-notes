// A small in-memory stand-in for the Apps Script services Code.gs uses, so the
// real backend can run in Node for tests and for trying the app locally.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }

  getValues() {
    const values = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = this.sheet.rows[this.row - 1 + r] || [];
      const out = [];
      for (let c = 0; c < this.numCols; c++) {
        const value = row[this.col - 1 + c];
        out.push(value === undefined ? '' : value);
      }
      values.push(out);
    }
    return values;
  }

  setValues(values) {
    if (values.length !== this.numRows || values.some(row => row.length !== this.numCols)) {
      throw new Error(`setValues: expected ${this.numRows}x${this.numCols}`);
    }
    values.forEach((row, r) => row.forEach((value, c) => {
      const rowIndex = this.row - 1 + r;
      this.sheet.rows[rowIndex] = this.sheet.rows[rowIndex] || [];
      this.sheet.writes.push(value);
      // Like Sheets: a leading apostrophe keeps text as typed and isn't stored.
      this.sheet.rows[rowIndex][this.col - 1 + c] =
        typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
    }));
    return this;
  }

  setValue(value) {
    return this.setValues([[value]]);
  }

  setFontWeight() { return this; }
  setNumberFormat() { return this; }
  setDataValidation() { return this; }

  createTextFinder(text) {
    const range = this;
    return {
      matchEntireCell() { return this; },
      findNext() {
        const values = range.getValues();
        for (let r = 0; r < values.length; r++) {
          for (let c = 0; c < values[r].length; c++) {
            if (String(values[r][c]) === text) return { getRow: () => range.row + r };
          }
        }
        return null;
      }
    };
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.writes = [];
  }

  getName() { return this.name; }
  setFrozenRows() {}

  getRange(row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error('getRange: out of bounds');
    return new FakeRange(this, row, col, numRows, numCols);
  }

  getLastRow() {
    for (let r = this.rows.length - 1; r >= 0; r--) {
      if ((this.rows[r] || []).some(value => value !== '' && value !== undefined)) return r + 1;
    }
    return 0;
  }

  getLastColumn() {
    return this.rows.reduce((max, row) => {
      let last = 0;
      (row || []).forEach((value, c) => { if (value !== '' && value !== undefined) last = c + 1; });
      return Math.max(max, last);
    }, 0);
  }

  deleteRows(start, count) {
    this.rows.splice(start - 1, count);
  }

  deleteRow(row) {
    this.deleteRows(row, 1);
  }
}

/**
 * @returns {{context: Object, spreadsheet: Object, properties: Map}} context
 *     holds Code.gs's globals, such as doPost.
 */
export function loadBackend({ codePath = new URL('../apps-script/Code.gs', import.meta.url), apiKey = 'test-key' } = {}) {
  const sheets = new Map();
  const spreadsheet = {
    getName: () => 'Test RVs',
    getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => {
      const sheet = new FakeSheet(name);
      sheets.set(name, sheet);
      return sheet;
    },
    sheets
  };
  const properties = new Map(apiKey ? [['apiKey', apiKey]] : []);

  const context = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      newDataValidation: () => ({ requireCheckbox() { return this; }, build: () => ({}) })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.has(key) ? properties.get(key) : null,
        setProperty: (key, value) => properties.set(key, String(value))
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { getUuid: () => randomUUID() },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ setMimeType() { return this; }, getContent: () => text })
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
    Maps: {
      newGeocoder: () => ({
        setBounds() { return this; },
        geocode: text => ({
          status: 'OK',
          results: [{ formatted_address: `${text} (test match)`, geometry: { location: { lat: 35.0469, lng: -85.3097 } } }]
        }),
        reverseGeocode: () => ({ results: [{ formatted_address: '1 Test St' }] })
      })
    },
    UrlFetchApp: {
      fetch: () => ({ getHeaders: () => ({}) })
    }
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(codePath, 'utf8'), context, { filename: 'Code.gs' });
  return { context, spreadsheet, properties };
}

/**
 * Calls doPost the way the web app would and returns the parsed response.
 */
export function post(backend, body) {
  const output = backend.context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
  return JSON.parse(output.getContent());
}
