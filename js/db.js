// The copy of each connection's data kept on this device, in IndexedDB.
//
// Stores:
//   connections  {id, name, url, key, cursor, lastSyncAt, ...}
//   people       {conn, id, ...person}        key [conn, id]
//   visits       {conn, id, ...visit}         key [conn, id]
//   pictures     {conn, id, personId, dataUrl} key [conn, id]
//   outbox       {seq, conn, kind, ...}       changes waiting to be sent

const DB_NAME = 'rv-notes';
const DB_VERSION = 1;
const CONNECTION_STORES = ['people', 'visits', 'pictures', 'outbox'];

let dbPromise = null;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('connections', { keyPath: 'id' });
        for (const name of ['people', 'visits', 'pictures']) {
          db.createObjectStore(name, { keyPath: ['conn', 'id'] }).createIndex('conn', 'conn');
        }
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }).createIndex('conn', 'conn');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close RV Notes in your other tabs, then reload.'));
    });
  }
  return dbPromise;
}

/**
 * Runs fn(stores) in one transaction and resolves with its result once the
 * transaction has committed.
 */
async function transaction(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
    let result;
    Promise.resolve(fn(stores)).then(value => result = value, err => {
      reject(err);
      try { tx.abort(); } catch (e) {}
    });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Saving on this device was cancelled.'));
  });
}

export const db = {
  transaction,

  async getConnections() {
    return transaction(['connections'], 'readonly', s => promisify(s.connections.getAll()));
  },

  async putConnection(connection) {
    return transaction(['connections'], 'readwrite', s => promisify(s.connections.put(connection)));
  },

  /** Every record in a store for one connection. */
  async getAll(store, conn) {
    return transaction([store], 'readonly', s => promisify(s[store].index('conn').getAll(conn)));
  },

  async get(store, conn, id) {
    return transaction([store], 'readonly', s => promisify(s[store].get([conn, id])));
  },

  /** The IDs a store has for one connection. */
  async getIds(store, conn) {
    const keys = await transaction([store], 'readonly', s => promisify(s[store].index('conn').getAllKeys(conn)));
    return keys.map(key => key[1]);
  },

  /** Deletes a connection and everything stored for it. */
  async deleteConnection(conn) {
    return transaction(['connections', ...CONNECTION_STORES], 'readwrite', async s => {
      s.connections.delete(conn);
      for (const name of CONNECTION_STORES) {
        const keys = await promisify(s[name].index('conn').getAllKeys(conn));
        keys.forEach(key => s[name].delete(key));
      }
    });
  }
};

export { promisify };
