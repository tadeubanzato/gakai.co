import React, { useEffect, useRef, useState } from "react";

// Dependency-free popover menu: a trigger button plus a list of items that
// closes on outside-click, Esc, or selecting an item. Used by the chat-row
// "⋯", the conversation-header "⋯", and nested submenus.
export function Menu({ trigger = "⋯", label = "More actions", align = "right", className = "", children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = event => { if (ref.current && !ref.current.contains(event.target)) setOpen(false); };
    const onKeyDown = event => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("mousedown", onDocMouseDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);
  return <span className={`menu ${className}`} ref={ref}>
    <button type="button" className="menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(value => !value)}>{trigger}</button>
    {open && <div className={`menu-popover ${align}`} role="menu">{typeof children === "function" ? children(() => setOpen(false)) : children}</div>}
  </span>;
}

export function MenuItem({ onSelect, danger = false, disabled = false, checked, children }) {
  return <button type="button" role="menuitem" className={`menu-item${danger ? " danger" : ""}`} disabled={disabled} onClick={onSelect}>
    {checked !== undefined && <span className="menu-check" aria-hidden="true">{checked ? "✓" : ""}</span>}
    <span>{children}</span>
  </button>;
}

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

// Small monochrome inline icon (inherits the button's text color via
// currentColor). Kept as inline SVG rather than an icon font/library so it
// stays self-contained and renders identically everywhere.
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
