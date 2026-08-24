import React, { useState } from "react";

// Resolve a raw picture value into a src the browser can load directly:
// already-usable data: URIs and our own proxied /api/app/media? URLs pass
// through unchanged, a plain https URL is routed through the link-image
// proxy (so the browser never talks to an external host directly), and
// anything else (missing, unrecognized) falls back to no image at all.
function avatarSrc(value) {
  const picture = String(value || "").trim();
  if (/^data:image\//i.test(picture)) return picture;
  if (picture.startsWith("/api/app/media?")) return picture;
  return /^https?:\/\//i.test(picture) ? `/api/app/link-image?url=${encodeURIComponent(picture)}` : null;
}

// Shared avatar for both the sidebar/inbox (account or chat `item`) and
// per-message sender avatars (`picture`/`label`/`className`). Passing an
// `item` reads its `name`/`label` and `picture`; otherwise `picture` and
// `label` are used directly. Falls back to a letter badge when there is no
// picture, or the image fails to load.
export function Avatar({ item, picture, label, className = "avatar" }) {
  const [failed, setFailed] = useState(false);
  const resolvedPicture = item ? item.picture : picture;
  const resolvedLabel = item ? (item.name || item.label) : label;
  const src = avatarSrc(resolvedPicture);
  const letter = String(resolvedLabel || "?")[0]?.toUpperCase() || "?";
  return src && !failed
    ? <img className={className} src={src} alt="" onError={() => setFailed(true)} />
    : <span className={`${className} ${className.includes("sender-avatar") ? "sender-letter" : "avatar-letter"}`} aria-hidden="true">{letter}</span>;
}
