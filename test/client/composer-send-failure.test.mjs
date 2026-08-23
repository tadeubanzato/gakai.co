import assert from 'node:assert/strict';
import test from 'node:test';
import { nextComposerValue } from '../../client/chat-helpers.mjs';

test('a failed send restores the composer text when the field is still empty', () => {
  assert.equal(nextComposerValue('', 'hello there'), 'hello there');
});

test('a failed send does not overwrite text the reader already typed in the meantime', () => {
  assert.equal(nextComposerValue('something new', 'hello there'), 'something new');
});
