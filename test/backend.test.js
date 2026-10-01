import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBackend, post } from './fake-apps-script.js';

const KEY = 'test-key';
const P1 = 'person-0000-0001';
const P2 = 'person-0000-0002';
const V1 = 'visit-0000-0001';
const V2 = 'visit-0000-0002';
const PIC1 = 'picture-0000-0001';
const PIC2 = 'picture-0000-0002';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg bytes').toString('base64');

function call(backend, action, params) {
  const response = post(backend, { key: KEY, action, params });
  assert.equal(response.ok, true, response.error);
  return response.result;
}

function putPerson(id, record, updatedAt = new Date().toISOString()) {
  return { table: 'people', op: 'put', id, updatedAt, record: { name: 'Someone', ...record } };
}

function putVisit(id, personId, record = {}, updatedAt = new Date().toISOString()) {
  return { table: 'visits', op: 'put', id, updatedAt, record: { personId, createdAt: '2026-09-01T15:00:00.000Z', notes: '', ...record } };
}

test('rejects requests without the right key', () => {
  const backend = loadBackend();
  assert.equal(post(backend, { key: 'wrong', action: 'info' }).code, 'auth');
  assert.equal(post(backend, { action: 'info' }).code, 'auth');
  assert.equal(post(backend, 'not json').ok, false);

  const unset = loadBackend({ apiKey: null });
  assert.equal(post(unset, { key: '', action: 'info' }).code, 'auth');
  assert.equal(post(unset, { key: null, action: 'info' }).code, 'auth');
});

test('rejects unknown actions, including inherited properties', () => {
  const backend = loadBackend();
  for (const action of ['nope', 'constructor', '__proto__', 'toString']) {
    const response = post(backend, { key: KEY, action });
    assert.equal(response.ok, false, action);
  }
});

test('info returns the spreadsheet name', () => {
  assert.equal(call(loadBackend(), 'info').name, 'Test RVs');
});

test('saves people and visits, then returns them on a full sync', () => {
  const backend = loadBackend();
  const first = call(backend, 'sync', {
    since: '',
    changes: [
      putPerson(P1, { name: 'Ann', coordinates: '35.0469,-85.3097', availableTimes: ['Sat Morning', 'Mon Evening', 'Bogus'], isStudy: true }),
      putVisit(V1, P1, { notes: 'Talked about the weather' })
    ]
  });
  assert.equal(first.full, true);
  assert.equal(first.people.length, 1);
  assert.equal(first.people[0].name, 'Ann');
  assert.equal(first.people[0].coordinates, '35.046900, -85.309700');
  assert.deepEqual(first.people[0].availableTimes, ['Mon Evening', 'Sat Morning']);
  assert.equal(first.people[0].isStudy, true);
  assert.equal(first.visits[0].notes, 'Talked about the weather');
  assert.ok(first.cursor);

  const again = call(backend, 'sync', { since: '', changes: [] });
  assert.equal(again.people.length, 1);
  assert.equal(again.visits.length, 1);
});

test('an incremental sync returns only what changed since the cursor', async () => {
  const backend = loadBackend();
  const first = call(backend, 'sync', { since: '', changes: [putPerson(P1, { name: 'Ann' })] });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = call(backend, 'sync', { since: first.cursor, changes: [putPerson(P2, { name: 'Bob' })] });
  assert.equal(second.full, false);
  // P1 was written at exactly the old cursor, so it can come back once.
  assert.ok(second.people.some(p => p.id === P2));
  await new Promise(resolve => setTimeout(resolve, 5));
  const third = call(backend, 'sync', { since: second.cursor, changes: [] });
  assert.deepEqual(third.people.map(p => p.id).filter(id => id !== P2), []);
  await new Promise(resolve => setTimeout(resolve, 5));
  const fourth = call(backend, 'sync', { since: third.cursor, changes: [] });
  assert.deepEqual(fourth.people, []);
});

test('the later edit wins, and an older edit gets the saved version back', () => {
  const backend = loadBackend();
  call(backend, 'sync', { since: '', changes: [putPerson(P1, { name: 'Newer' }, '2026-09-02T00:00:00.000Z')] });
  const result = call(backend, 'sync', {
    since: new Date().toISOString(),
    changes: [putPerson(P1, { name: 'Older' }, '2026-09-01T00:00:00.000Z')]
  });
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].name, 'Newer');
});

test('deleting a person deletes their visits and pictures, and other devices hear about it', async () => {
  const backend = loadBackend();
  call(backend, 'putPicture', { id: PIC1, personId: P1, dataUrl: JPEG });
  const first = call(backend, 'sync', {
    since: '',
    changes: [putPerson(P1, { pictures: [PIC1] }), putVisit(V1, P1), putPerson(P2), putVisit(V2, P2)]
  });
  await new Promise(resolve => setTimeout(resolve, 5));

  call(backend, 'sync', { since: first.cursor, changes: [{ table: 'people', op: 'delete', id: P1 }] });
  const other = call(backend, 'sync', { since: first.cursor, changes: [] });
  assert.deepEqual(
    other.deleted.map(d => `${d.table}/${d.id}`).sort(),
    [`people/${P1}`, `visits/${V1}`]);
  assert.deepEqual(call(backend, 'getPictures', { ids: [PIC1] }), { [PIC1]: null });

  const full = call(backend, 'sync', { since: '', changes: [] });
  assert.deepEqual(full.people.map(p => p.id), [P2]);
  assert.deepEqual(full.visits.map(v => v.id), [V2]);
  assert.equal(backend.spreadsheet.getSheetByName('Pictures').getLastRow(), 1);
});

test('deleted records stay deleted', () => {
  const backend = loadBackend();
  call(backend, 'sync', { since: '', changes: [putPerson(P1), { table: 'people', op: 'delete', id: P1 }] });
  const later = call(backend, 'sync', {
    since: '',
    changes: [putPerson(P1, { name: 'Back again' }, '2030-01-01T00:00:00.000Z'), putVisit(V1, P1)]
  });
  assert.deepEqual(later.people, []);
  assert.deepEqual(later.visits, []);
});

test('deleting something that was never synced is remembered', async () => {
  const backend = loadBackend();
  const first = call(backend, 'sync', { since: '', changes: [] });
  await new Promise(resolve => setTimeout(resolve, 5));
  call(backend, 'sync', { since: first.cursor, changes: [{ table: 'visits', op: 'delete', id: V1 }] });
  const other = call(backend, 'sync', { since: first.cursor, changes: [] });
  assert.deepEqual(other.deleted, [{ table: 'visits', id: V1 }]);
});

test('an invalid change is rejected without blocking the others', () => {
  const backend = loadBackend();
  const result = call(backend, 'sync', {
    since: '',
    changes: [
      putPerson(P1, { name: '   ' }),
      putPerson(P2, { coordinates: 'somewhere' }),
      { table: 'people', op: 'put', id: 'bad id!', record: { name: 'X' } },
      { table: 'nope', op: 'put', id: V1 },
      putPerson('person-0000-0003', { name: 'Fine' })
    ]
  });
  assert.deepEqual(result.rejected.map(r => r.id), [P1, P2, 'bad id!', V1]);
  assert.match(result.rejected[0].error, /Name is required/);
  assert.deepEqual(result.people.map(p => p.name), ['Fine']);
});

test('removing a picture from a person deletes it', () => {
  const backend = loadBackend();
  call(backend, 'putPicture', { id: PIC1, personId: P1, dataUrl: JPEG });
  call(backend, 'putPicture', { id: PIC2, personId: P1, dataUrl: JPEG });
  // Sending the same picture twice stores it once.
  call(backend, 'putPicture', { id: PIC2, personId: P1, dataUrl: JPEG });
  call(backend, 'sync', { since: '', changes: [putPerson(P1, { pictures: [PIC1, PIC2] }, '2026-09-01T00:00:00.000Z')] });
  assert.deepEqual(Object.keys(call(backend, 'getPictures', { ids: [PIC1, PIC2] })).length, 2);
  assert.equal(call(backend, 'getPictures', { ids: [PIC2] })[PIC2], JPEG);

  call(backend, 'sync', { since: '', changes: [putPerson(P1, { pictures: [PIC2] }, '2026-09-02T00:00:00.000Z')] });
  assert.deepEqual(call(backend, 'getPictures', { ids: [PIC1, PIC2] }), { [PIC1]: null, [PIC2]: JPEG });
});

test('pictures must be small images', () => {
  const backend = loadBackend();
  const big = 'data:image/jpeg;base64,' + Buffer.alloc(130 * 1024).toString('base64');
  assert.match(post(backend, { key: KEY, action: 'putPicture', params: { id: PIC1, personId: P1, dataUrl: big } }).error, /at most/);
  assert.match(post(backend, { key: KEY, action: 'putPicture', params: { id: PIC1, personId: P1, dataUrl: 'data:text/html;base64,PGI+' } }).error, /JPEG/);
});

test('text that looks like a formula is stored as text', () => {
  const backend = loadBackend();
  call(backend, 'sync', { since: '', changes: [putPerson(P1, { name: '=IMPORTDATA("https://example.com")' })] });
  const sheet = backend.spreadsheet.getSheetByName('RVs');
  assert.ok(sheet.writes.includes(`'=IMPORTDATA("https://example.com")`));
  assert.ok(!sheet.writes.includes(`=IMPORTDATA("https://example.com")`));
});

test('columns added by hand are left alone, even between the app\'s columns', () => {
  const backend = loadBackend();
  call(backend, 'sync', { since: '', changes: [putPerson(P1, { name: 'Ann' }, '2026-09-01T00:00:00.000Z')] });
  const sheet = backend.spreadsheet.getSheetByName('RVs');
  // Insert a column of your own between Name and Address.
  sheet.rows.forEach((row, i) => row.splice(2, 0, i === 0 ? 'My Notes' : '=LEN(B2)'));
  call(backend, 'sync', { since: '', changes: [putPerson(P1, { name: 'Ann B', address: 'Here' }, '2026-09-02T00:00:00.000Z')] });
  assert.deepEqual(sheet.rows[1].slice(0, 4), [P1, 'Ann B', '=LEN(B2)', 'Here']);
});

test('rows typed into the sheet by hand reach the app', async () => {
  const backend = loadBackend();
  const first = call(backend, 'sync', { since: '', changes: [] });
  const sheet = backend.spreadsheet.getSheetByName('RVs');
  sheet.rows.push([P1, 'Typed in']);
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = call(backend, 'sync', { since: first.cursor, changes: [] });
  assert.deepEqual(second.people.map(p => p.name), ['Typed in']);
});

test('finds places by address and by Google Maps link', () => {
  const backend = loadBackend();
  assert.equal(call(backend, 'findPlaces', { query: '1 Main St' })[0].coordinates, '35.046900, -85.309700');
  const fromLink = call(backend, 'findPlaces', {
    query: 'https://www.google.com/maps/place/Coolidge+Park/@35.06,-85.30,17z/data=!3d35.0612345!4d-85.3071234'
  });
  assert.equal(fromLink[0].name, 'Coolidge Park');
  assert.equal(fromLink[0].coordinates, '35.061234, -85.307123');
  assert.match(post(backend, { key: KEY, action: 'findPlaces', params: { query: 'https://example.com/x' } }).error, /Only Google Maps/);
});

test('syncs time entries, studies, and reports', () => {
  const backend = loadBackend();
  const now = new Date().toISOString();
  const result = call(backend, 'sync', {
    since: '',
    changes: [
      { table: 'time', op: 'put', id: 'time-0000-0001', updatedAt: now, record: { date: '2026-10-03', minutes: 95, kind: 'service', note: 'Morning' } },
      { table: 'time', op: 'put', id: 'time-0000-0002', updatedAt: now, record: { date: '2026-10-04', minutes: 60, kind: 'credit' } },
      { table: 'studies', op: 'put', id: 'study-0000-0001', updatedAt: now, record: { month: '2026-10', personId: P1, name: 'Ann' } },
      { table: 'studies', op: 'put', id: 'study-0000-0002', updatedAt: now, record: { month: '2026-10', name: 'Someone else' } },
      { table: 'reports', op: 'put', id: 'report-2026-10', updatedAt: now, record: {
        month: '2026-10', shared: 'yes', comments: 'Hi', sentAt: now, hours: 1, creditHours: 1, studies: 2,
        carriedMinutes: 35, carriedCreditMinutes: 0, text: 'Report text' } }
    ]
  });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.tables, ['people', 'visits', 'time', 'studies', 'reports']);
  assert.deepEqual(result.time.map(t => [t.date, t.minutes, t.kind]), [['2026-10-03', 95, 'service'], ['2026-10-04', 60, 'credit']]);
  assert.deepEqual(result.studies.map(s => [s.month, s.personId, s.name]), [['2026-10', P1, 'Ann'], ['2026-10', '', 'Someone else']]);
  assert.equal(result.reports[0].carriedMinutes, 35);
  assert.equal(result.reports[0].sentAt, now);
  assert.equal(result.reports[0].text, 'Report text');

  // Dates are kept as text, so they don't shift with time zones.
  const sheet = backend.spreadsheet.getSheetByName('Time');
  assert.equal(sheet.rows[1][1], '2026-10-03');

  call(backend, 'sync', { since: '', changes: [{ table: 'time', op: 'delete', id: 'time-0000-0001' }] });
  assert.deepEqual(call(backend, 'sync', { since: '', changes: [] }).time.map(t => t.id), ['time-0000-0002']);
});

test('rejects invalid time entries, studies, and reports', () => {
  const backend = loadBackend();
  const result = call(backend, 'sync', {
    since: '',
    changes: [
      { table: 'time', op: 'put', id: 'time-0000-0001', record: { date: '2026-13-01', minutes: 30 } },
      { table: 'time', op: 'put', id: 'time-0000-0002', record: { date: '2026-10-01', minutes: 0 } },
      { table: 'time', op: 'put', id: 'time-0000-0003', record: { date: '2026-10-01', minutes: 1.5 } },
      { table: 'studies', op: 'put', id: 'study-0000-0001', record: { month: '2026-10', name: ' ' } },
      { table: 'studies', op: 'put', id: 'study-0000-0002', record: { month: 'October', name: 'Ann' } },
      { table: 'reports', op: 'put', id: 'report-2026-10', record: { month: '2026-10', hours: -1 } }
    ]
  });
  assert.equal(result.rejected.length, 6);
});
