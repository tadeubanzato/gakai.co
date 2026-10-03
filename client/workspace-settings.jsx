import React, { useCallback, useEffect, useState } from "react";
import { api } from "./app-helpers.mjs";
import { Avatar, status } from "./ui-helpers.jsx";
import { AdminProfileCard } from "./admin-profile.jsx";
import { ApiTokensCard } from "./api-tokens.jsx";

// /settings — everything about the workspace as a whole: the WhatsApp accounts (each
// opens its own page), the administrator's sign-in details, and the application
// tokens other systems use to send messages through Gakai's API.
export function WorkspaceSettings({ accounts, onClose, onManage, onAddAccount, onNotice }) {
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api("/api/app/auth/profile").then(setProfile).catch(error => onNotice(error.message)); }, [onNotice]);

  useEffect(() => {
    const onKey = event => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saveProfile = useCallback(async payload => {
    setBusy(true);
    try {
      const result = await api("/api/app/auth/profile", { method: "PATCH", body: JSON.stringify(payload) });
      setProfile(current => ({ ...current, username: result.username, email: result.email }));
      onNotice("Sign-in details saved.");
      return true;
    } catch (error) { onNotice(error.message); return false; } finally { setBusy(false); }
  }, [onNotice]);

  return <div className="details" role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title">
    <header className="details-head">
      <div className="details-identity">
        <div><span className="eyebrow">SETTINGS</span><h2 id="workspace-settings-title">Settings</h2><small>Your WhatsApp accounts, sign-in and API access</small></div>
      </div>
      <div className="details-head-actions"><button className="secondary" onClick={onClose} aria-label="Back to inbox">‹ Inbox</button></div>
    </header>
    <main className="details-main">
      <section className="details-card ws-accounts" aria-labelledby="ws-accounts-title">
        <div className="ws-accounts-head">
          <div>
            <h3 id="ws-accounts-title">WhatsApp accounts</h3>
            <p>Each account is its own world, with its own AI, voices and replies. Open one to manage it.</p>
          </div>
          <button type="button" className="primary ws-add" onClick={onAddAccount}>+ Add account</button>
        </div>
        <div className="ws-account-list">
          {accounts.map(account => <div className="ws-account" key={account.id}>
            <Avatar item={account}/>
            <div className="ws-account-info">
              <b>{account.label}</b>
              <small>{account.phone ? `+${account.phone} · ` : ""}<span className={account.status === "WORKING" ? "ws-ok" : "ws-warn"}>{status(account.status)}</span></small>
            </div>
            <button type="button" className="secondary" onClick={() => onManage(account)} aria-label={`Manage ${account.label}`}>Manage</button>
          </div>)}
          {!accounts.length && <small className="profile-hint">No WhatsApp accounts yet. Add one to get started.</small>}
        </div>
      </section>
      <AdminProfileCard profile={profile} busy={busy} onSave={saveProfile}/>
      <ApiTokensCard accounts={accounts} onNotice={onNotice}/>
    </main>
  </div>;
}
