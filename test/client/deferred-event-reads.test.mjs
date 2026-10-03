import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// React clears event.currentTarget as soon as the handler returns. A state updater function runs
// later, so reading the event inside one reads null and crashes the screen (it blanked the voice
// editor the first time someone typed). Read the value first, then pass it in.
const CLIENT = new URL('../../client/', import.meta.url).pathname;
const DEFERRED_READ = /set[A-Za-z]*\(\s*\(?[A-Za-z]+\)?\s*=>[^;\n]*\bevent\.(currentTarget|target)\b/;

test('no interface file reads an event inside a deferred state update', () => {
  const offenders = [];
  for (const file of readdirSync(CLIENT).filter(name => /\.(jsx|mjs)$/.test(name))) {
    readFileSync(join(CLIENT, file), 'utf8').split('\n').forEach((line, index) => { if (DEFERRED_READ.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`); });
  }
  assert.deepEqual(offenders, [], `read event.currentTarget.value into a variable first:\n${offenders.join('\n')}`);
});

test('the check itself recognises the mistake it guards against', () => {
  assert.equal(DEFERRED_READ.test('onChange={event => setEditor(current => ({ ...current, yaml: event.currentTarget.value }))}'), true);
  assert.equal(DEFERRED_READ.test('onChange={event => { const yaml = event.currentTarget.value; setEditor(current => ({ ...current, yaml })); }}'), false);
  assert.equal(DEFERRED_READ.test('onChange={event => setName(event.currentTarget.value)}'), false, 'reading it directly is fine');
});
