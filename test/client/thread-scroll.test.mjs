import assert from 'node:assert/strict';
import test from 'node:test';
import { aspectOf, compensation, distanceFromBottom, entryNeedsCorrection, followsIncoming, modeAfterIntent, modeAfterScroll, settlesToBottom } from '../../client/thread-scroll.mjs';

test('distance from the bottom', () => {
  assert.equal(distanceFromBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 500 }), 100);
});

test('a conversation entering is locked: scroll events alone never release the lock', () => {
  for (const event of [{ top: 100, lastTop: 400, distance: 900 }, { top: 480, lastTop: 400, distance: 20 }, { top: 399, lastTop: 400, distance: 0.4 }])
    assert.equal(modeAfterScroll({ mode: 'entry', ...event }), 'entry');
  assert.equal(entryNeedsCorrection({ mode: 'entry', distance: 250 }), true, 'something moved us off the bottom without intent: put it back');
  assert.equal(entryNeedsCorrection({ mode: 'entry', distance: 0 }), false);
  assert.equal(entryNeedsCorrection({ mode: 'pinned', distance: 250 }), false);
  assert.equal(entryNeedsCorrection({ mode: 'reading', distance: 250 }), false, 'a reader is never corrected');
});

test('pinned: the reader moving up leaves it; our own downward moves and the bottom itself do not', () => {
  assert.equal(modeAfterScroll({ mode: 'pinned', top: 300, lastTop: 400, distance: 600 }), 'reading');
  assert.equal(modeAfterScroll({ mode: 'pinned', top: 400, lastTop: 400, distance: 600 }), 'pinned', 'content grew below, nobody scrolled');
  assert.equal(modeAfterScroll({ mode: 'pinned', top: 450, lastTop: 400, distance: 300 }), 'pinned', 'a downward move is not the reader leaving');
  assert.equal(modeAfterScroll({ mode: 'pinned', top: 399.5, lastTop: 400, distance: 600 }), 'pinned', 'sub-pixel jitter is ignored');
  assert.equal(modeAfterScroll({ mode: 'pinned', top: 380, lastTop: 400, distance: 0 }), 'pinned', 'the browser clamping at the bottom');
  assert.equal(modeAfterScroll({ mode: 'pinned', top: 395, lastTop: 400, distance: 5 }), 'reading', 'even a small nudge up');
});

test('reading: only scrolling down to the bottom resumes following', () => {
  assert.equal(modeAfterScroll({ mode: 'reading', top: 480, lastTop: 400, distance: 20 }), 'pinned');
  assert.equal(modeAfterScroll({ mode: 'reading', top: 380, lastTop: 400, distance: 20 }), 'reading', 'a nudge up near the bottom stays reading');
  assert.equal(modeAfterScroll({ mode: 'reading', top: 100, lastTop: 400, distance: 900 }), 'reading');
  assert.equal(modeAfterScroll({ mode: 'reading', top: 480, lastTop: 400, distance: 0.5 }), 'pinned');
});

test('wheel or touch upward stops following at once; downward changes nothing', () => {
  assert.equal(modeAfterIntent('pinned', -40), 'reading');
  assert.equal(modeAfterIntent('pinned', 40), 'pinned');
  assert.equal(modeAfterIntent('reading', 40), 'reading');
});

test('an incoming message is followed when pinned or within a short step of the bottom', () => {
  assert.equal(followsIncoming({ mode: 'pinned', distance: 500 }), true);
  assert.equal(followsIncoming({ mode: 'entry', distance: 500 }), true);
  assert.equal(followsIncoming({ mode: 'reading', distance: 90 }), true);
  assert.equal(followsIncoming({ mode: 'reading', distance: 900 }), false);
});

test('a row that grows: pinned follows the bottom elsewhere; a reader is compensated only for rows above them', () => {
  assert.equal(compensation({ mode: 'pinned', rowTop: 100, scrollTop: 500, delta: 300 }), 0);
  assert.equal(compensation({ mode: 'entry', rowTop: 100, scrollTop: 500, delta: 300 }), 0);
  assert.equal(compensation({ mode: 'reading', rowTop: 100, scrollTop: 500, delta: 300 }), 300, 'above the viewport');
  assert.equal(compensation({ mode: 'reading', rowTop: 900, scrollTop: 500, delta: 300 }), 0, 'below the viewport: do not move');
  assert.equal(compensation({ mode: 'reading', rowTop: 100, scrollTop: 500, delta: -120 }), -120, 'shrinking above moves them back too');
  assert.equal(compensation({ mode: 'reading', rowTop: 100, scrollTop: 500, delta: 0 }), 0);
});

test('aspect ratio comes from the reported size, and nonsense gives none', () => {
  assert.equal(aspectOf({ width: 1200, height: 800 }), 1.5);
  assert.equal(aspectOf({ width: 720, height: 1280 }), 0.563);
  assert.equal(aspectOf({ width: 0, height: 800 }), null);
  assert.equal(aspectOf({ width: 'x', height: 5 }), null);
  assert.equal(aspectOf({ width: 10000, height: 10 }), null);
  assert.equal(aspectOf(null), null);
});

test('a smooth scroll that stopped a few pixels short is closed; a reader is never pulled', () => {
  assert.equal(settlesToBottom({ mode: 'pinned', distance: 6 }), true);
  assert.equal(settlesToBottom({ mode: 'pinned', distance: 0 }), false);
  assert.equal(settlesToBottom({ mode: 'pinned', distance: 300 }), false);
  assert.equal(settlesToBottom({ mode: 'reading', distance: 6 }), false);
});
