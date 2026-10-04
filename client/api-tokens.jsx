import React, { useCallback, useEffect, useId, useState } from "react";
import { api } from "./app-helpers.mjs";
import { confirmDialog } from "./confirm.jsx";
import { curlSample, jsonSample, SEND_PATH } from "./api-samples.mjs";
import { copyText, CopyId } from "./ui-helpers.jsx";

// New tokens can only send — the least an application needs to trigger a message.
const NEW_TOKEN_SCOPES = ["messages:send"];
const SCOPE_OPTIONS = [
  { id: "messages:send", label: "Send messages", hint: "Send WhatsApp messages from this account." },
  { id: "messages:read", label: "Read messages", hint: "Read this account's chats and messages." },
  { id: "accounts:read", label: "Read accounts", hint: "List the names and ids of ALL WhatsApp accounts in this workspace — for example to fill an account dropdown. Never their messages." },
];
const when = value => (value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

function CopyButton({ text, label = "Copy", className = "secondary" }) {
  const [state, setState] = useState("");
  const timer = React.useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    setState((await copyText(text)) ? "Copied" : "Press Ctrl/Cmd+C");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(""), 1800);
  };
  return <button type="button" className={`token-copy ${className}`} onClick={copy}>{state || label}</button>;
}

const ClipboardIcon = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="3" width="11" height="13" rx="2"/><path d="M5 8H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1"/></svg>;
const CheckIcon = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>;

const hoursLeft = until => {
  const minutes = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h` : `${Math.max(minutes, 1)} min`;
};

// Copy icon beside a token. Gakai keeps the token only for 24 hours after it is
// created or regenerated; the server decides, so a stale page cannot copy past it.
function CopyTokenButton({ base, token, onNotice, onExpired }) {
  const [state, setState] = useState("idle"); // idle | copied | manual
  const [manual, setManual] = useState("");
  const timer = React.useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!token.copyable) {
    return <span className="token-copy-icon is-expired" title="This token can only be copied for 24 hours after it is created. Regenerate it to get a new one you can copy." aria-label="Copy unavailable: regenerate for a new token"><ClipboardIcon/></span>;
  }
  const copy = async () => {
    try {
      const { token: secret } = await api(`${base}/integration-keys/${encodeURIComponent(token.id)}/token`);
      if (await copyText(secret)) {
        setState("copied");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1800);
      } else { setManual(secret); setState("manual"); }   // the browser refused: show it to select by hand
    } catch (error) { onNotice(error.message); onExpired?.(); }
  };
  return <>
    <button type="button" className={`token-copy-icon${state === "copied" ? " is-copied" : ""}`} onClick={copy} title={state === "copied" ? "Copied" : `Copy token — available for ${hoursLeft(token.copyableUntil)} more`} aria-label={`Copy the ${token.name} token`}>
      {state === "copied" ? <CheckIcon/> : <ClipboardIcon/>}
    </button>
    {state === "copied" && <span className="token-copied" role="status">Copied</span>}
    {state === "manual" && <input className="token-manual" readOnly value={manual} aria-label={`${token.name} token`} onFocus={event => event.currentTarget.select()} autoFocus onBlur={() => { setManual(""); setState("idle"); }}/>}
  </>;
}

const accountBase = id => `/api/app/accounts/${encodeURIComponent(id)}`;

// Application tokens (Settings): one per system that sends WhatsApp messages through
// Gakai's API (n8n, a CRM, a script). For now each token names the one WhatsApp
// profile it sends from. It can be copied for 24 hours, then regenerated or deleted
// at any time. The card also carries the request to copy and paste.
export function ApiTokensCard({ accounts, onNotice }) {
  const panelId = useId();
  const nameId = useId();
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [sampleTab, setSampleTab] = useState("curl");
  const [sampleTokenId, setSampleTokenId] = useState("");
  const origin = window.location.origin;

  const load = useCallback(() => api("/api/app/integration-keys").then(result => setTokens(result.keys || [])).catch(error => { setTokens([]); onNotice(error.message); }), [onNotice]);
  useEffect(() => { load(); }, [load]);
  // Keep the chosen profile valid as profiles come and go.
  useEffect(() => { if (!accounts.some(account => account.id === accountId)) setAccountId(accounts[0]?.id || ""); }, [accounts, accountId]);
  const accountLabel = id => accounts.find(account => account.id === id)?.label || "Removed profile";

  const toggle = () => setOpen(current => !current);

  const create = async event => {
    event.preventDefault();
    if (!name.trim() || !accountId || busy) return;
    setBusy(true);
    try {
      const result = await api("/api/app/integration-keys", { method: "POST", body: JSON.stringify({ accountId, name: name.trim(), scopes: NEW_TOKEN_SCOPES }) });
      setName("");
      onNotice(`${result.key.name} token created — copy it with the copy icon within 24 hours.`);
      await load();
    } catch (error) { onNotice(error.message); } finally { setBusy(false); }
  };

  // Permissions are set on the token after it exists, and save as soon as they change.
  const setScopes = async (token, scope, on) => {
    const next = on ? [...token.scopes, scope] : token.scopes.filter(item => item !== scope);
    if (!next.length) return;
    setTokens(current => current.map(item => (item.id === token.id ? { ...item, scopes: next } : item)));
    try {
      await api(`${accountBase(token.accountId)}/integration-keys/${encodeURIComponent(token.id)}`, { method: "PATCH", body: JSON.stringify({ scopes: next }) });
      onNotice("Auto saved");
    } catch (error) {
      setTokens(current => current.map(item => (item.id === token.id ? { ...item, scopes: token.scopes } : item)));
      onNotice(error.message);
    }
  };

  const regenerate = async token => {
    const confirmed = await confirmDialog({
      title: `Regenerate the ${token.name} token?`,
      message: `A new token replaces the current one immediately. ${token.name} will stop working until you give it the new token.`,
      confirmLabel: "Regenerate", danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await api(`${accountBase(token.accountId)}/integration-keys/${encodeURIComponent(token.id)}/regenerate`, { method: "POST" });
      onNotice(`${result.key.name} token regenerated — copy the new one with the copy icon within 24 hours.`);
      await load();
    } catch (error) { onNotice(error.message); } finally { setBusy(false); }
  };

  const remove = async token => {
    const confirmed = await confirmDialog({
      title: `Delete the ${token.name} token?`,
      message: `${token.name} will no longer be able to send messages through Gakai. This can't be undone.`,
      confirmLabel: "Delete token", danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api(`${accountBase(token.accountId)}/integration-keys/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      await load();
    } catch (error) { onNotice(error.message); } finally { setBusy(false); }
  };

  // The sample names the account of the token it is shown for (the first one, unless another is picked),
  // or the profile chosen above while there are no tokens yet.
  const sampleToken = (tokens || []).find(token => token.id === sampleTokenId) || (tokens || [])[0];
  const sampleAccountId = sampleToken?.accountId || accountId;
  const sample = sampleTab === "json" ? jsonSample(sampleAccountId) : curlSample(origin, undefined, sampleAccountId);
  const count = tokens?.length || 0;

  return <section className={`details-card security api-tokens${open ? " is-open" : ""}`} aria-labelledby="api-tokens-title" onClick={() => { if (!open) setOpen(true); }}>
    <div className="profile-head" onClick={toggle}>
      <div className="profile-heading">
        <h3 id="api-tokens-title">
          <button type="button" className="profile-toggle" aria-expanded={open} aria-controls={panelId}>
            Application tokens
            <svg className="profile-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </h3>
        <p>Let other systems — n8n, a CRM, a script — send WhatsApp messages through the Gakai API.</p>
      </div>
      <span className="token-count">{tokens === null ? "…" : `${count} ${count === 1 ? "token" : "tokens"}`}</span>
    </div>

    <div className="token-body" id={panelId} hidden={!open}>

      <form className="token-create" onSubmit={create}>
        <input id={nameId} value={name} onChange={event => setName(event.currentTarget.value)} placeholder="Application name" aria-label="Application name" maxLength={80} autoComplete="off"/>
        {accounts.length > 1 && <select value={accountId} onChange={event => setAccountId(event.currentTarget.value)} aria-label="WhatsApp profile this token sends from">
          {accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
        </select>}
        <button className="primary token-create-button" disabled={busy || !name.trim() || !accountId}>{busy ? "Working…" : "Create token"}</button>
      </form>

      <div className="token-list" aria-live="polite">
        {tokens === null && <small className="profile-hint">Loading tokens…</small>}
        {tokens !== null && !tokens.length && <small className="profile-hint">No tokens yet. Create one above for each application that will send messages.</small>}
        {(tokens || []).map(token => <div className="token-row" key={token.id}>
          <div className="token-info">
            <div className="token-title">
              <b>{token.name}</b>
              <small>Created {when(token.createdAt)}</small>
              <span className="token-account" title="The WhatsApp profile this token sends from">{accountLabel(token.accountId)}</span>
            </div>
            <div className="token-secret-row">
              <span className="token-secret">wh_live_••••{token.last4 || "••••"}</span>
              <CopyTokenButton base={accountBase(token.accountId)} token={token} onNotice={onNotice} onExpired={load}/>
            </div>
            <div className="token-perm-options">
              {SCOPE_OPTIONS.map(option => {
                const checked = token.scopes.includes(option.id);
                const onlyOne = checked && token.scopes.length === 1;
                return <label key={option.id} className="checkbox-field is-compact" title={onlyOne ? "A token needs at least one permission" : option.hint}>
                  <input type="checkbox" checked={checked} disabled={onlyOne} onChange={event => setScopes(token, option.id, event.currentTarget.checked)}/>
                  <span><b>{option.label}</b></span>
                </label>;
              })}
            </div>
            <small>
              {token.rotatedAt ? `Regenerated ${when(token.rotatedAt)} · ` : ""}
              {token.lastUsedAt ? `Last used ${when(token.lastUsedAt)}` : "Never used"}
            </small>
          </div>
          <div className="token-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => regenerate(token)}>Regenerate</button>
            <button type="button" className="secondary token-delete" disabled={busy} onClick={() => remove(token)}>Delete</button>
          </div>
        </div>)}
      </div>

      <div className="token-sample">
        <div className="token-sample-head">
          <h4>Send a message</h4>
          <div className="token-tabs" role="tablist" aria-label="Request format">
            {[["curl", "curl"], ["json", "JSON"]].map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={sampleTab === id} className={sampleTab === id ? "on" : ""} onClick={() => setSampleTab(id)}>{label}</button>)}
          </div>
        </div>
        {(tokens || []).length > 1 && <label className="token-sample-for">
          <span>Example for</span>
          <select value={sampleToken?.id || ""} onChange={event => setSampleTokenId(event.currentTarget.value)} aria-label="Token the example is written for">
            {tokens.map(token => <option key={token.id} value={token.id}>{token.name} · {accountLabel(token.accountId)}</option>)}
          </select>
        </label>}
        <pre className="token-code" tabIndex={0}><code>{sample}</code></pre>
        <div className="token-sample-foot">
          <CopyButton text={sample} label={sampleTab === "json" ? "Copy JSON" : "Copy curl"}/>
          <small className="profile-hint">
            POST <code>{origin}{SEND_PATH}</code>.
            {sampleTab === "curl" && " Replace YOUR_TOKEN with an application token."}
            {" "}<code>accountId</code> is the WhatsApp account this token belongs to. The token alone decides who sends, so it is optional — when given it must match, otherwise the request is refused instead of sending from the wrong number.
            {" "}<code>phone</code> is the full number in any format (<code>+1 555 123 4567</code> works) — Gakai uses the existing chat, or starts a new one if the number is on WhatsApp. For a group, send <code>chatId</code> instead. <code>GET {SEND_PATH.replace("/messages", "/account")}</code> returns the account a token belongs to. To fill an account dropdown, tick <b>Read accounts</b> on the token and <code>GET {SEND_PATH.replace("/messages", "/accounts")}</code> lists every account's id, name, number and status.
          </small>
          {sampleAccountId && <CopyId id={sampleAccountId}/>}
        </div>
      </div>
    </div>
  </section>;
}
