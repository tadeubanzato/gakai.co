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

// Small monochrome inline icons (inherit the button's text color via
// currentColor). Kept as inline SVG rather than an icon font/library so they
// stay self-contained and render identically everywhere.
export function IconSend({ className = "btn-icon" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M2.5 4.5 L21.5 12 L2.5 19.5 L5.7 12 Z" />
    </svg>
  );
}
export function IconLogout({ className = "btn-icon" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M9 16l-4-4 4-4M5 12h9"/>
    </svg>
  );
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
