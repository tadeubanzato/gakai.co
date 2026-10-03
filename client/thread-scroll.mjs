// The scroll rules for a conversation, kept free of the DOM so they can be tested.
//
// A thread is always in exactly one state:
//   entry   — INITIAL_CONVERSATION_ENTRY: the conversation was just opened. The newest message is
//             held at the real bottom while pictures and cards settle. The only thing that ends the
//             lock is the reader's own, explicit scroll intent (wheel, touch, keys, scrollbar drag);
//             a scroll event alone never does, so browser or layout-driven scroll changes cannot.
//   pinned  — BOTTOM_PINNED_ACTIVE_CHAT: following the newest message (after the reader came back
//             to the bottom, or sent something).
//   reading — USER_READING_HISTORY: the reader scrolled up on purpose; nothing may move them.
// Nothing about a previous conversation takes part: a conversation always begins in `entry`.
export const MODES = { ENTRY: 'entry', PINNED: 'pinned', READING: 'reading' };

export const AT_BOTTOM_PX = 100;     // "at the bottom" for the arrow and for incoming messages
export const REENGAGE_PX = 40;       // closer than this and following resumes by itself

export const distanceFromBottom = ({ scrollHeight, scrollTop, clientHeight }) => scrollHeight - scrollTop - clientHeight;

// What a scroll EVENT may change. `lastTop` is where the position was after our last write or last
// scroll event, so our own moves are never mistaken for the reader's.
//   reading → following again when the reader scrolls down to the bottom
//   pinned  → reading when the position moves up away from the bottom without us causing it
//   entry   → never changes on a scroll event (see above)
export function modeAfterScroll({ mode, top, lastTop, distance }) {
  if (mode === 'entry') return 'entry';
  if (mode === 'reading') return distance <= 1 || (top > lastTop && distance <= REENGAGE_PX) ? 'pinned' : 'reading';
  if (distance <= 1) return 'pinned';
  return top < lastTop - 1 ? 'reading' : 'pinned';
}

// While the entry lock holds, a scroll event that left the position above the real bottom did not
// come from the reader (that would have been an explicit intent first): put it back.
export const entryNeedsCorrection = ({ mode, distance }) => mode === 'entry' && distance > 1;

// Wheel, touch or key movement upward is an unmistakable intent: stop following right away.
export const modeAfterIntent = (mode, deltaY) => (deltaY < 0 ? 'reading' : mode);

// A new message arrives: follow it unless the reader is reading history further than a short step
// from the bottom.
export const followsIncoming = ({ mode, distance }) => mode !== 'reading' || distance <= AT_BOTTOM_PX;

// After scrolling stops while following: a smooth scroll can end a few pixels short of the true
// bottom. Close that gap exactly; never touch a reader.
export const settlesToBottom = ({ mode, distance }) => mode !== 'reading' && distance > 1 && distance <= REENGAGE_PX;

export const isAtBottom = distance => distance <= AT_BOTTOM_PX;

// A message row changed height by `delta` pixels (an image arrived, a card resolved).
// Returns how far to move scrollTop so that what the reader sees does not move:
//   entry/pinned → none here; the caller re-anchors to the true bottom
//   reading      → follow the growth only if the row starts above the top of the viewport
export function compensation({ mode, rowTop, scrollTop, delta }) {
  if (mode !== 'reading' || !delta) return 0;
  return rowTop < scrollTop ? delta : 0;
}

// A picture's reserved box from the size WhatsApp reports: a CSS aspect-ratio number, or null when
// the size is unknown or nonsensical.
export function aspectOf(media) {
  const width = Number(media?.width), height = Number(media?.height);
  if (!(width > 0) || !(height > 0)) return null;
  const ratio = width / height;
  return ratio >= 0.2 && ratio <= 5 ? Math.round(ratio * 1000) / 1000 : null;
}
