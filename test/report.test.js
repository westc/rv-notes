import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMonths, formatMinutes, reportText, summarize, uniqueStudies } from '../js/report.js';

const empty = { time: [], studies: [], reports: [], visits: [] };
let n = 0;
const entry = (date, minutes, kind = 'service') => ({ id: `t${n++}`, date, minutes, kind, note: '', updatedAt: '' });

test('addMonths crosses years', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
});

test('formatMinutes', () => {
  assert.equal(formatMinutes(45), '45 min');
  assert.equal(formatMinutes(120), '2 h');
  assert.equal(formatMinutes(135), '2 h 15 min');
});

test('leftover minutes carry into the next month', () => {
  const data = { ...empty, time: [entry('2026-09-10', 130), entry('2026-10-02', 50), entry('2026-10-20', 25)] };
  const september = summarize(data, '2026-09');
  assert.deepEqual([september.service.liveHours, september.service.carriedOut], [2, 10]);
  const october = summarize(data, '2026-10');
  // 10 carried + 75 logged = 85 minutes.
  assert.deepEqual([october.service.carriedIn, october.service.minutes, october.service.liveHours, october.service.carriedOut], [10, 75, 1, 25]);
  // Carrying continues through months with no time.
  assert.equal(summarize(data, '2026-12').service.carriedIn, 25);
});

test('a sent report keeps what it sent for the next month', () => {
  const data = {
    ...empty,
    time: [entry('2026-09-10', 130), entry('2026-09-11', 45), entry('2026-10-02', 30)],
    // Sent before the 45 minutes on the 11th were added.
    reports: [{ month: '2026-09', sentAt: '2026-10-01T00:00:00Z', hours: 2, creditHours: 0, carriedMinutes: 10, carriedCreditMinutes: 0, shared: '', comments: '' }]
  };
  const october = summarize(data, '2026-10');
  assert.equal(october.service.carriedIn, 10);
  assert.equal(october.service.liveHours, 0);
});

test('credit hours are counted separately', () => {
  const data = { ...empty, time: [entry('2026-10-01', 60), entry('2026-10-02', 90, 'credit')] };
  const s = summarize(data, '2026-10');
  assert.equal(s.service.liveHours, 1);
  assert.equal(s.credit.liveHours, 1);
  assert.equal(s.credit.carriedOut, 30);
});

test('studies count each person or name once', () => {
  const studies = [
    { month: '2026-10', personId: 'p1', name: 'Ann' },
    { month: '2026-10', personId: 'p1', name: 'Ann' },
    { month: '2026-10', personId: '', name: 'Bob' },
    { month: '2026-10', personId: '', name: 'bob ' },
    { month: '2026-09', personId: 'p2', name: 'Cy' }
  ];
  assert.deepEqual(uniqueStudies(studies, '2026-10').map(s => s.name), ['Ann', 'Bob']);
});

test('shared in the ministry is automatic unless set', () => {
  assert.equal(summarize(empty, '2026-10').shared, false);
  assert.equal(summarize({ ...empty, time: [entry('2026-10-01', 15)] }, '2026-10').shared, true);
  assert.equal(summarize({ ...empty, visits: [{ createdAt: new Date(2026, 9, 5).toISOString() }] }, '2026-10').shared, true);
  assert.equal(summarize({ ...empty, time: [entry('2026-10-01', 15)], reports: [{ month: '2026-10', shared: 'no', comments: '' }] }, '2026-10').shared, false);
});

test('report text', () => {
  const data = {
    ...empty,
    time: [entry('2026-10-01', 125), entry('2026-10-02', 180, 'credit')],
    studies: [{ month: '2026-10', personId: 'p1', name: 'Ann' }],
    reports: [{ month: '2026-10', shared: '', comments: 'Thanks!' }]
  };
  assert.equal(reportText(summarize(data, '2026-10'), { name: 'Chris' }), [
    'Ministry report for October 2026',
    'Name: Chris',
    'Shared in the ministry: Yes',
    'Bible studies: 1',
    'Hours: 2',
    'Credit hours: 3',
    'Comments: Thanks!'
  ].join('\n'));
  assert.ok(!reportText(summarize(empty, '2026-10')).includes('Credit'));
});
