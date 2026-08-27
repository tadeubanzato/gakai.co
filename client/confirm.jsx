import React, { useCallback, useEffect, useState } from "react";

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

export function ConfirmHost() {
  const [state, setState] = useState(null); // { ...options, resolve } while open

  useEffect(() => {
    requestConfirm = options => new Promise(resolve => {
      setState({ title: "Are you sure?", confirmLabel: "Confirm", cancelLabel: "Cancel", danger: false, ...options, resolve });
    });
    return () => { requestConfirm = null; };
  }, []);

  const close = useCallback(result => {
    setState(current => { current?.resolve(result); return null; });
  }, []);

  useEffect(() => {
    if (!state) return undefined;
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state, close]);

  if (!state) return null;
  return (
    <div className="modal-overlay" role="presentation" onClick={() => close(false)}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={e => e.stopPropagation()}>
        <h3 id="confirm-title">{state.title}</h3>
        {state.message ? <p>{state.message}</p> : null}
        <div className="modal-actions">
          <button type="button" className="subtle-btn" onClick={() => close(false)}>{state.cancelLabel}</button>
          <button type="button" className={state.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>{state.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
