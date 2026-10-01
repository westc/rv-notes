import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadBackend, newExecution, post } from './fake-apps-script.js';

const KEY = 'test-key';
const LOADER = new URL('../apps-script/Loader.gs', import.meta.url);
const CODE = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');

function loaderWith(answer) {
  const state = { answer };
  const backend = loadBackend({ codePath: LOADER, fetch: url => state.answer(url) });
  return { backend, state };
}

const ok = () => ({ status: 200, body: CODE });

test('runs the downloaded backend', () => {
  const { backend } = loaderWith(ok);
  const response = post(backend, { key: KEY, action: 'sync', params: { since: '', changes: [
    { table: 'people', op: 'put', id: 'person-0000-0001', updatedAt: new Date().toISOString(), record: { name: 'Ann' } }
  ] } });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(response.result.people.map(p => p.name), ['Ann']);
  assert.equal(post(backend, { key: 'wrong', action: 'info' }).code, 'auth');
  assert.match(backend.fetches[0], /^https:\/\/westc\.github\.io\/rv-notes\/apps-script\/Code\.gs\?t=\d+$/);
});

test('uses the cached copy for 10 minutes', () => {
  const { backend } = loaderWith(ok);
  post(backend, { key: KEY, action: 'info' });
  newExecution(backend);
  post(backend, { key: KEY, action: 'info' });
  assert.equal(backend.fetches.length, 1);
  // The code is split into pieces that fit Apps Script's limits.
  assert.ok([...backend.cache.values()].every(item => item.value.length <= 90000));
  assert.ok([...backend.properties.entries()].filter(([k]) => k.startsWith('loader.code.')).every(([, v]) => v.length <= 9000));
});

test('keeps running the last good copy when the download fails or looks wrong', () => {
  const { backend, state } = loaderWith(ok);
  post(backend, { key: KEY, action: 'info' });
  const bad = [
    () => { throw new Error('DNS error'); },
    () => ({ status: 404, body: '<html>Not found</html>' }),
    () => ({ status: 200, body: '<html>Some page</html>' }),
    () => ({ status: 200, body: '// RV Notes backend\nfunction doPost( {' })
  ];
  for (const answer of bad) {
    state.answer = answer;
    backend.cache.clear();
    newExecution(backend);
    const response = post(backend, { key: KEY, action: 'info' });
    assert.equal(response.ok, true, response.error);
  }
});

test('explains the problem when there is no copy yet', () => {
  const { backend } = loaderWith(() => ({ status: 500, body: '' }));
  const response = post(backend, { key: KEY, action: 'info' });
  assert.equal(response.ok, false);
  assert.match(response.error, /Couldn’t download RV Notes \(HTTP 500\)/);
});

test('picks up a new version after the cache expires', () => {
  const { backend, state } = loaderWith(ok);
  post(backend, { key: KEY, action: 'info' });
  const firstHash = backend.properties.get('loader.hash');
  state.answer = () => ({ status: 200, body: CODE.replace("name: SpreadsheetApp.getActiveSpreadsheet().getName(),", "name: 'New version',") });
  backend.cache.clear();
  newExecution(backend);
  assert.equal(post(backend, { key: KEY, action: 'info' }).result.name, 'New version');
  assert.notEqual(backend.properties.get('loader.hash'), firstHash);
  // Old pieces are replaced, not left behind.
  const count = Number(backend.properties.get('loader.code.count'));
  assert.ok(!backend.properties.has(`loader.code.${count}`));
});

test('the backend code does not leak into the loader', () => {
  const { backend } = loaderWith(ok);
  post(backend, { key: KEY, action: 'info' });
  // Code.gs's own doPost stays inside the loader's function.
  assert.match(String(backend.context.doPost), /backend_\(\)/);
});

test('the menu comes from the saved backend, so new items need no new loader', () => {
  const { backend } = loaderWith(ok);
  // Before anything is saved, the menu still works.
  backend.context.onOpen();
  assert.deepEqual(backend.ui.menus[0].items.filter(Boolean).map(i => i.functionName),
    ['showConnectDialog', 'resetKey', 'setUpSheets', 'updateNow']);

  post(backend, { key: KEY, action: 'info' });
  newExecution(backend);
  backend.context.onOpen();
  const items = backend.ui.menus[1].items.filter(Boolean);
  assert.deepEqual(items.map(i => i.label), ['Connect app', 'Reset key', 'Set up sheets', 'RV Notes on GitHub', 'Update now']);
  const github = items.find(i => i.label === 'RV Notes on GitHub');
  newExecution(backend);
  backend.context[github.functionName]();
  assert.match(backend.ui.dialogs[0].html, /github\.com\/westc\/rv-notes/);
  // onOpen never downloads.
  assert.equal(backend.fetches.length, 1);
});
