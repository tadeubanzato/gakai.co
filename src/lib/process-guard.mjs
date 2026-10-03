/**
 * Tells a dropped outbound network stream apart from a genuine programming
 * error at the process level.
 *
 * A media download whose connection closes mid-body surfaces as an 'error'
 * event on a stream nothing is listening to (the provider library pipes it
 * without forwarding errors), which Node treats as an uncaught exception.
 * That is one failed download, not corrupt application state — it must not
 * take every account and every open request down with it.
 */
const RECOVERABLE_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR']);

export function isRecoverableStreamError(error) {
  const codes = [error?.code, error?.cause?.code].filter(Boolean).map(String);
  if (codes.some(code => code.startsWith('UND_ERR_') || RECOVERABLE_CODES.has(code))) return true;
  // undici's own wording for a response body cut short, when no cause is attached.
  return error?.name === 'TypeError' && error?.message === 'terminated';
}
