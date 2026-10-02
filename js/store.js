// Connections, the active connection's data, and syncing.
//
// Every change is saved on this device first and added to the outbox. Syncing
// sends the outbox to the spreadsheet (pictures first, then records) and gets
// back whatever changed there since the last sync.
import { reactive } from '../vendor/vue.esm-browser.prod.js';
import { callApi } from './api.js';
import { db, promisify } from './db.js';
import { nowIso, storage, uuid } from './util.js';

const ACTIVE_KEY = 'rv-notes/activeConnection';
const RECORDS_PER_SYNC = 200;
const PICTURES_PER_REQUEST = 10;
const SYNC_DELAY = 1500;
// The record tables that sync. Scripts from before reports only know the
// first two, so the rest wait in the outbox until the script is updated.
export const TABLES = ['people', 'visits', 'time', 'studies', 'reports'];
const OLD_SCRIPT_TABLES = ['people', 'visits'];

// IndexedDB can't store Vue's reactive proxies, so records are copied first.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function withoutConn(record) {
  const { conn, ...rest } = record;
  return rest;
}

export function createStore() {
  const state = reactive({
    connections: [],
    active: null,
    people: [],
    visits: [],
    time: [],
    studies: [],
    reports: [],
    // Data URLs of pictures the UI asked for, by ID. '' means loading or not
    // downloaded yet.
    pictures: {},
    pending: 0,
    // idle, syncing, offline, error, or auth (the key was rejected).
    status: 'idle',
    statusMessage: '',
    // Changes are waiting for tables the spreadsheet's script doesn't have yet.
    needsScriptUpdate: false,
    ready: false
  });

  // Outbox entries being sent right now. New changes to the same record get
  // their own entry instead of being merged into one of these.
  const inFlight = new Set();
  // Pictures the spreadsheet no longer has, so they aren't asked for again.
  const missingPictures = new Set();
  let syncPromise = null;
  let syncAgain = false;
  let syncTimer = null;
  const listeners = { rejected: [] };

  function emit(name, value) {
    listeners[name].forEach(fn => fn(value));
  }

  /* -- Connections -------------------------------------------------- */

  async function init() {
    state.connections = (await db.getConnections()).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    const activeId = storage.get(ACTIVE_KEY);
    const active = state.connections.find(c => c.id === activeId) || state.connections[0] || null;
    await activate(active);
    state.ready = true;
  }

  async function activate(connection) {
    state.active = connection;
    state.pictures = {};
    state.status = 'idle';
    state.statusMessage = '';
    state.needsScriptUpdate = false;
    missingPictures.clear();
    if (connection) storage.set(ACTIVE_KEY, connection.id);
    await reload();
  }

  async function reload() {
    const conn = state.active && state.active.id;
    if (!conn) {
      TABLES.forEach(table => state[table] = []);
      state.pending = 0;
      return;
    }
    const [pending, ...tables] = await Promise.all([
      db.getAll('outbox', conn), ...TABLES.map(table => db.getAll(table, conn))
    ]);
    if (!state.active || state.active.id !== conn) return;
    TABLES.forEach((table, i) => state[table] = tables[i].map(withoutConn));
    state.pending = pending.length;
  }

  async function saveConnection(connection) {
    await db.putConnection(plain(connection));
    const index = state.connections.findIndex(c => c.id === connection.id);
    if (index < 0) {
      state.connections.push(connection);
    } else {
      Object.assign(state.connections[index], connection);
    }
    return state.connections.find(c => c.id === connection.id);
  }

  async function addConnection({ name, url, key }) {
    const connection = await saveConnection({
      id: uuid(), name, url, key, cursor: '', lastSyncAt: '', addedAt: nowIso()
    });
    await activate(connection);
    return connection;
  }

  async function updateConnection(id, fields) {
    const connection = state.connections.find(c => c.id === id);
    await saveConnection({ ...connection, ...fields });
    if (state.active && state.active.id === id && 'key' in fields) {
      state.status = 'idle';
      state.statusMessage = '';
    }
  }

  async function switchTo(id) {
    if (state.active && state.active.id === id) return;
    await activate(state.connections.find(c => c.id === id) || null);
  }

  async function removeConnection(id) {
    await db.deleteConnection(id);
    state.connections = state.connections.filter(c => c.id !== id);
    if (state.active && state.active.id === id) {
      storage.remove(ACTIVE_KEY);
      await activate(state.connections[0] || null);
    }
  }

  async function pendingCount(id) {
    return (await db.getAll('outbox', id)).length;
  }

  /* -- Outbox ------------------------------------------------------- */

  /**
   * Adds changes to the outbox inside a transaction. A put is skipped when the
   * record already has a waiting change, because records are read when sent.
   * A delete replaces a waiting put.
   */
  async function queue(stores, conn, changes) {
    const waiting = (await promisify(stores.outbox.index('conn').getAll(conn)))
      .filter(entry => !inFlight.has(entry.seq));
    for (const change of changes) {
      const entry = { conn, ...change };
      const same = waiting.filter(e => e.kind === entry.kind && e.table === entry.table && e.id === entry.id);
      if (entry.op === 'delete') {
        same.filter(e => e.op === 'put').forEach(e => stores.outbox.delete(e.seq));
        if (!same.some(e => e.op === 'delete')) stores.outbox.add(entry);
      } else if (!same.length) {
        stores.outbox.add(entry);
      }
    }
  }

  /** Drops waiting changes (not ones being sent) that match. */
  async function unqueue(stores, conn, match) {
    const waiting = await promisify(stores.outbox.index('conn').getAll(conn));
    waiting.filter(e => !inFlight.has(e.seq) && match(e)).forEach(e => stores.outbox.delete(e.seq));
  }

  async function afterChange() {
    await reload();
    scheduleSync();
  }

  /* -- Changes ------------------------------------------------------ */

  /**
   * Saves a person on this device.
   *
   * @param {Object} input The person's fields. Without an id, a new person is
   *     added.
   * @param {{dataUrl: string}[]} newPictures Pictures to add.
   * @returns {Promise<Object>} The saved person.
   */
  async function savePerson(input, newPictures = []) {
    const conn = state.active.id;
    const now = nowIso();
    const existing = input.id ? state.people.find(p => p.id === input.id) : null;
    const added = newPictures.map(picture => ({ id: uuid(), dataUrl: picture.dataUrl }));
    const person = plain({
      id: input.id || uuid(),
      name: input.name.trim(),
      address: input.address.trim(),
      phones: input.phones || [],
      coordinates: input.coordinates.trim(),
      description: input.description.trim(),
      isStudy: !!input.isStudy,
      availableTimes: input.availableTimes,
      pictures: [...input.pictures, ...added.map(p => p.id)],
      returnAt: input.returnAt,
      tags: input.tags || [],
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    });
    const removed = existing ? existing.pictures.filter(id => !person.pictures.includes(id)) : [];

    await db.transaction(['people', 'pictures', 'outbox'], 'readwrite', async s => {
      s.people.put({ conn, ...person });
      added.forEach(p => s.pictures.put({ conn, id: p.id, personId: person.id, dataUrl: p.dataUrl }));
      removed.forEach(id => s.pictures.delete([conn, id]));
      await unqueue(s, conn, e => e.kind === 'picture' && removed.includes(e.id));
      await queue(s, conn, [
        ...added.map(p => ({ kind: 'picture', id: p.id, personId: person.id })),
        { kind: 'record', table: 'people', op: 'put', id: person.id }
      ]);
    });
    added.forEach(p => state.pictures[p.id] = p.dataUrl);
    removed.forEach(id => delete state.pictures[id]);
    await afterChange();
    return person;
  }

  async function deletePerson(id) {
    const conn = state.active.id;
    const person = state.people.find(p => p.id === id);
    const visitIds = state.visits.filter(v => v.personId === id).map(v => v.id);
    const pictureIds = person ? person.pictures : [];
    await db.transaction(['people', 'visits', 'pictures', 'outbox'], 'readwrite', async s => {
      s.people.delete([conn, id]);
      visitIds.forEach(visitId => s.visits.delete([conn, visitId]));
      pictureIds.forEach(pictureId => s.pictures.delete([conn, pictureId]));
      // The spreadsheet deletes the visits and pictures along with the person.
      await unqueue(s, conn, e => (e.kind === 'picture' && e.personId === id) ||
        (e.table === 'visits' && visitIds.includes(e.id)));
      await queue(s, conn, [{ kind: 'record', table: 'people', op: 'delete', id }]);
    });
    pictureIds.forEach(pictureId => delete state.pictures[pictureId]);
    await afterChange();
  }

  /**
   * Saves a visit on this device. With options.returnAt (a string, possibly
   * empty), the person's Return At is updated too.
   */
  async function saveVisit(input, options = {}) {
    const conn = state.active.id;
    const now = nowIso();
    const visit = plain({
      id: input.id || uuid(),
      personId: input.personId,
      createdAt: input.createdAt || now,
      notes: input.notes.trim(),
      updatedAt: now
    });
    const person = 'returnAt' in options ? state.people.find(p => p.id === visit.personId) : null;

    await db.transaction(['people', 'visits', 'outbox'], 'readwrite', async s => {
      s.visits.put({ conn, ...visit });
      const changes = [{ kind: 'record', table: 'visits', op: 'put', id: visit.id }];
      if (person) {
        s.people.put({ conn, ...plain(person), returnAt: options.returnAt, updatedAt: now });
        changes.push({ kind: 'record', table: 'people', op: 'put', id: person.id });
      }
      await queue(s, conn, changes);
    });
    await afterChange();
    return visit;
  }

  async function deleteVisit(id) {
    const conn = state.active.id;
    await db.transaction(['visits', 'outbox'], 'readwrite', async s => {
      s.visits.delete([conn, id]);
      await queue(s, conn, [{ kind: 'record', table: 'visits', op: 'delete', id }]);
    });
    await afterChange();
  }

  /**
   * Saves a time entry, study, or report on this device. Records need an id
   * and get a new updatedAt.
   */
  async function saveRecord(table, record) {
    const conn = state.active.id;
    const saved = plain({ ...record, updatedAt: nowIso() });
    await db.transaction([table, 'outbox'], 'readwrite', async s => {
      s[table].put({ conn, ...saved });
      await queue(s, conn, [{ kind: 'record', table, op: 'put', id: saved.id }]);
    });
    await afterChange();
    return saved;
  }

  async function deleteRecord(table, id) {
    const conn = state.active.id;
    await db.transaction([table, 'outbox'], 'readwrite', async s => {
      s[table].delete([conn, id]);
      await queue(s, conn, [{ kind: 'record', table, op: 'delete', id }]);
    });
    await afterChange();
  }

  /* -- Pictures ----------------------------------------------------- */

  /** Data URLs of the pictures this device has, in order, skipping the rest. */
  async function pictureData(ids) {
    const conn = state.active.id;
    const pictures = await Promise.all(ids.map(id => db.get('pictures', conn, id)));
    return pictures.filter(Boolean).map(picture => picture.dataUrl);
  }

  /** Loads pictures from this device into state.pictures. */
  async function loadPictures(ids) {
    const conn = state.active && state.active.id;
    for (const id of ids) {
      if (id in state.pictures) continue;
      state.pictures[id] = '';
      db.get('pictures', conn, id).then(picture => {
        if (picture && state.active && state.active.id === conn) state.pictures[id] = picture.dataUrl;
      });
    }
  }

  /**
   * Downloads pictures this device doesn't have yet, so they can be seen
   * offline, and deletes ones no one uses anymore.
   */
  async function syncPictures(connection) {
    const conn = connection.id;
    const [people, have, outbox] = await Promise.all([
      db.getAll('people', conn), db.getIds('pictures', conn), db.getAll('outbox', conn)
    ]);
    const used = new Set(people.flatMap(p => p.pictures));
    const uploading = new Set(outbox.filter(e => e.kind === 'picture').map(e => e.id));
    const unused = have.filter(id => !used.has(id) && !uploading.has(id));
    if (unused.length) {
      await db.transaction(['pictures'], 'readwrite', s => unused.forEach(id => s.pictures.delete([conn, id])));
    }

    const haveSet = new Set(have);
    const missing = [...used].filter(id => !haveSet.has(id) && !missingPictures.has(id));
    const owners = {};
    people.forEach(p => p.pictures.forEach(id => owners[id] = p.id));
    for (let i = 0; i < missing.length; i += PICTURES_PER_REQUEST) {
      const ids = missing.slice(i, i + PICTURES_PER_REQUEST);
      const result = await callApi(connection, 'getPictures', { ids });
      const found = ids.filter(id => result[id]);
      ids.filter(id => !result[id]).forEach(id => missingPictures.add(id));
      await db.transaction(['pictures'], 'readwrite', s => found.forEach(id =>
        s.pictures.put({ conn, id, personId: owners[id], dataUrl: result[id] })));
      if (state.active && state.active.id === conn) {
        found.forEach(id => { if (id in state.pictures) state.pictures[id] = result[id]; });
      }
    }
  }

  /* -- Syncing ------------------------------------------------------ */

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync().catch(() => {}), SYNC_DELAY);
  }

  /**
   * Syncs the active connection. If a sync is already running, another one
   * runs right after it.
   */
  function sync() {
    clearTimeout(syncTimer);
    if (syncPromise) {
      syncAgain = true;
      return syncPromise;
    }
    syncPromise = (async () => {
      try {
        do {
          syncAgain = false;
          const active = state.active;
          let activeError = null;
          if (active) await syncOnce(active).catch(err => activeError = err);
          // Other spreadsheets only sync when they have changes to send.
          for (const connection of state.connections.filter(c => !active || c.id !== active.id)) {
            if (await pendingCount(connection.id)) await syncOnce(connection).catch(() => {});
          }
          if (activeError) throw activeError;
        } while (syncAgain);
      } finally {
        syncPromise = null;
      }
    })();
    return syncPromise;
  }

  async function syncOnce(connection) {
    const conn = connection.id;
    const isActive = () => state.active && state.active.id === conn;
    if (isActive()) {
      state.status = 'syncing';
      state.statusMessage = '';
    }
    try {
      await sendPictures(connection);
      let more = true;
      while (more) more = await syncRecords(connection);
      await syncPictures(connection);
      connection.lastSyncAt = nowIso();
      await saveConnection({ ...connection });
      if (isActive()) state.status = 'idle';
    } catch (err) {
      if (isActive()) {
        state.status = err.code === 'network' ? 'offline' : err.code === 'auth' ? 'auth' : 'error';
        state.statusMessage = err.message;
      }
      throw err;
    } finally {
      inFlight.clear();
      if (isActive()) await reload();
    }
  }

  async function sendPictures(connection) {
    const conn = connection.id;
    const entries = (await db.getAll('outbox', conn)).filter(e => e.kind === 'picture');
    for (const entry of entries) {
      inFlight.add(entry.seq);
      const picture = await db.get('pictures', conn, entry.id);
      if (picture) {
        await callApi(connection, 'putPicture', { id: entry.id, personId: entry.personId, dataUrl: picture.dataUrl });
      }
      await db.transaction(['outbox'], 'readwrite', s => s.outbox.delete(entry.seq));
      inFlight.delete(entry.seq);
    }
  }

  /**
   * Sends up to RECORDS_PER_SYNC waiting changes and applies what comes back.
   *
   * @returns {Promise<boolean>} Whether more changes are waiting.
   */
  async function syncRecords(connection) {
    const conn = connection.id;
    const supported = connection.tables || OLD_SCRIPT_TABLES;
    const records = (await db.getAll('outbox', conn)).filter(e => e.kind === 'record');
    const waiting = records.filter(e => supported.includes(e.table));
    const entries = waiting.slice(0, RECORDS_PER_SYNC);
    const changes = [];
    for (const entry of entries) {
      inFlight.add(entry.seq);
      if (entry.op === 'delete') {
        changes.push({ table: entry.table, op: 'delete', id: entry.id });
        continue;
      }
      const record = await db.get(entry.table, conn, entry.id);
      // Deleted on this device since; that change is in the outbox too.
      if (!record) continue;
      changes.push({ table: entry.table, op: 'put', id: entry.id, updatedAt: record.updatedAt, record: withoutConn(record) });
    }

    const result = await callApi(connection, 'sync', { since: connection.cursor || '', changes });
    await applySync(connection, result, entries);
    if (result.rejected.length) emit('rejected', result.rejected);

    // An updated script says which tables it has, so changes that were
    // waiting for it can go now.
    const nowSupported = connection.tables || OLD_SCRIPT_TABLES;
    const unsent = records.filter(e => !supported.includes(e.table));
    const canSendMore = unsent.some(e => nowSupported.includes(e.table));
    if (state.active && state.active.id === conn) {
      state.needsScriptUpdate = unsent.some(e => !nowSupported.includes(e.table));
    }
    return waiting.length > entries.length || canSendMore;
  }

  async function applySync(connection, result, sent) {
    const conn = connection.id;
    const sentSeqs = new Set(sent.map(e => e.seq));
    // Scripts from before reports only send people and visits.
    const tables = TABLES.filter(table => Array.isArray(result[table]));
    await db.transaction(['connections', 'outbox', ...TABLES], 'readwrite', async s => {
      sent.forEach(entry => s.outbox.delete(entry.seq));
      // Records changed on this device during the sync keep the local version
      // until that change is sent.
      const waiting = (await promisify(s.outbox.index('conn').getAll(conn)))
        .filter(e => !sentSeqs.has(e.seq) && e.kind === 'record');
      const isWaiting = (table, id) => waiting.some(e => e.table === table && e.id === id);

      const visits = await promisify(s.visits.index('conn').getAll(conn));
      for (const table of tables) {
        if (result.full) {
          // Everything the spreadsheet has came back, so anything else is gone.
          const keep = new Set(result[table].map(record => record.id));
          const keys = await promisify(s[table].index('conn').getAllKeys(conn));
          keys.filter(([, id]) => !keep.has(id) && !isWaiting(table, id)).forEach(key => s[table].delete(key));
        }
        let records = result[table].filter(record => !isWaiting(table, record.id));
        if (table === 'people' && records.some(person => !('phones' in person))) {
          // Scripts from before phone numbers don't send them back, so the
          // ones on this device are kept until the script is updated.
          const local = new Map((await promisify(s.people.index('conn').getAll(conn))).map(person => [person.id, person]));
          records = records.map(person => 'phones' in person ? person : { ...person, phones: (local.get(person.id) || {}).phones || [] });
        }
        records.forEach(record => s[table].put({ conn, ...record }));
      }
      result.deleted.forEach(({ table, id }) => {
        if (!TABLES.includes(table)) return;
        s[table].delete([conn, id]);
        if (table === 'people') visits.filter(v => v.personId === id).forEach(v => s.visits.delete([conn, v.id]));
      });

      connection.cursor = result.cursor;
      if (Array.isArray(result.tables)) connection.tables = result.tables;
      s.connections.put(plain(connection));
    });
  }

  return {
    state,
    init,
    addConnection,
    updateConnection,
    switchTo,
    removeConnection,
    pendingCount,
    savePerson,
    deletePerson,
    saveVisit,
    deleteVisit,
    saveRecord,
    deleteRecord,
    loadPictures,
    pictureData,
    sync,
    scheduleSync,
    onRejected: fn => listeners.rejected.push(fn),
    /** Downloads everything again, keeping changes that haven't been sent. */
    async redownload() {
      if (!state.active) return;
      await updateConnection(state.active.id, { cursor: '' });
      return sync();
    }
  };
}
