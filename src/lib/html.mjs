// HTML attribute values are entity-escaped per spec, so a meta content="..."
// URL containing a real "&" is written as "&amp;" in the markup and must be
// decoded before use. Instagram's CDN URLs in particular are signed, and a
// literal "&amp;" instead of "&" splits their auth query params, making the
// signature invalid — verified directly: the mangled URL gets a 403 from
// Instagram's CDN, the decoded one loads the real image.
export function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&(quot|apos|amp|lt|gt);/gi, (_match, entity) => ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' })[entity.toLowerCase()]);
}
