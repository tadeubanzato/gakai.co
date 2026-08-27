import React, { useCallback, useEffect, useRef, useState } from "react";

// A single app-wide confirmation dialog, driven imperatively so any handler
// can `await confirmDialog(...)` in place of the old window.confirm() browser
// popup — same "returns true/false" contract, but rendered in the app's own
// modal styling. <ConfirmHost/> must be mounted once, near the tree root.
let requestConfirm = null;

// Resolves true when the reader confirms, false on cancel / Escape / backdrop
// click (and false, harmlessly, if the host isn't mounted yet). Pass a string
// for just the body, or { title, message, confirmLabel, cancelLabel, danger }.
export function confirmDialog(options) {
  if (!requestConfirm) return Promise.resolve(false);
  return requestConfirm(typeof options === "string" ? { message: options } : options);
}

const DEFAULTS = { title: "Are you sure?", confirmLabel: "Confirm", cancelLabel: "Cancel", danger: false };

export function ConfirmHost() {
  const [dialog, setDialog] = useState(null); // the options object while open, else null
  // The pending promise's resolver, kept out of React state so settling it is
  // never a side effect inside a state updater (which React may run more than
  // once, or defer).
  const resolverRef = useRef(null);

  useEffect(() => {
    requestConfirm = options => new Promise(resolve => {
      // A second request while one is open: reject the first as cancelled.
      if (resolverRef.current) resolverRef.current(false);
      resolverRef.current = resolve;
      setDialog({ ...DEFAULTS, ...options });
    });
    return () => { requestConfirm = null; };
  }, []);

  const close = useCallback(result => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setDialog(null);
    if (resolve) resolve(result);
  }, []);

  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialog, close]);

  if (!dialog) return null;
  return (
    <div className="modal-overlay" role="presentation" onClick={() => close(false)}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={e => e.stopPropagation()}>
        <h3 id="confirm-title">{dialog.title}</h3>
        {dialog.message ? <p>{dialog.message}</p> : null}
        <div className="modal-actions">
          <button type="button" className="subtle-btn" onClick={() => close(false)}>{dialog.cancelLabel}</button>
          <button type="button" className={dialog.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>{dialog.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
