import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { MESSAGES } from '../js/messages.js';

const LANGUAGES = Object.keys(MESSAGES);
const placeholders = message => {
  const text = typeof message === 'object' ? Object.values(message).join(' ') : message;
  return [...new Set(text.match(/\{\w+\}/g) || [])].sort();
};

test('every language has the same messages with the same {placeholders}', () => {
  const keys = Object.keys(MESSAGES.en).sort();
  for (const language of LANGUAGES) {
    assert.deepEqual(Object.keys(MESSAGES[language]).sort(), keys, `${language} keys`);
    for (const key of keys) {
      const message = MESSAGES[language][key];
      assert.ok(message && (typeof message === 'string' || message.other), `${language} ${key}`);
      // {count} may be left out of a "one" form, so plural messages are
      // compared as a whole.
      assert.deepEqual(placeholders(message), placeholders(MESSAGES.en[key]), `${language} ${key} placeholders`);
    }
  }
});

test('every message key the app uses exists', () => {
  const files = ['index.html', ...readdirSync('js').map(name => `js/${name}`)].filter(name => !name.endsWith('messages.js'));
  const namespaces = new Set(Object.keys(MESSAGES.en).map(key => key.split('.')[0]));
  const used = new Set();
  for (const file of files) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(/'([a-z][a-zA-Z]*\.[a-zA-Z.]+)'/g)) {
      if (namespaces.has(key.split('.')[0]) && !key.endsWith('.')) used.add(key);
    }
  }
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) used.add(`day.${day}`);
  for (const period of ['Morning', 'Afternoon', 'Evening']) used.add(`period.${period}`);
  const missing = [...used].filter(key => !(key in MESSAGES.en)).filter(key => !/\.(js|html|css|gs|png|webmanifest)$/.test(key));
  assert.deepEqual(missing, []);
  assert.ok(used.size > 200, `found ${used.size} keys`);
});
