import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecoverableStreamError } from '../../src/lib/process-guard.mjs';

test('a response body cut short by the remote side is recoverable', () => {
  // The shape undici raises when a media download's connection closes mid-body.
  const error = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(isRecoverableStreamError(error), true);
  assert.equal(isRecoverableStreamError(new TypeError('terminated')), true);
});

test('plain socket failures are recoverable', () => {
  assert.equal(isRecoverableStreamError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(isRecoverableStreamError(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })), true);
});

test('a programming error is not mistaken for a dropped stream', () => {
  assert.equal(isRecoverableStreamError(new TypeError("Cannot read properties of undefined (reading 'id')")), false);
  assert.equal(isRecoverableStreamError(new ReferenceError('x is not defined')), false);
  assert.equal(isRecoverableStreamError(Object.assign(new Error('disk'), { code: 'ENOSPC' })), false);
  assert.equal(isRecoverableStreamError(undefined), false);
});
