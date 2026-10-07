import React, { useEffect, useRef, useState } from "react";
import { api } from "./app-helpers.mjs";
import { Avatar } from "./ui-helpers.jsx";

const DISAPPEARING = { 86400: "24 hours", 604800: "7 days", 7776000: "90 days" };
const day = value => { try { return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }); } catch { return ""; } };

// The details window, like WhatsApp's: who a person is, or what a group is and who is in it. It is
// fetched only when opened. Clicking a member shows that person; "‹" returns to the group.
export function ChatInfoModal({ accountId, startId, onClose }) {
  const [stack, setStack] = useState([startId]);
  const current = stack[stack.length - 1];
  const [state, setState] = useState({ loading: true, info: null, error: "" });
  const cache = useRef(new Map());
  const closeRef = useRef(null);

  useEffect(() => {
    let live = true;
    const hit = cache.current.get(current);
    if (hit) { setState({ loading: false, info: hit, error: "" }); return undefined; }
    setState({ loading: true, info: null, error: "" });
    api(`/api/app/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(current)}/info`)
      .then(info => { cache.current.set(current, info); if (live) setState({ loading: false, info, error: "" }); })
      .catch(error => { if (live) setState({ loading: false, info: null, error: error.message || "Could not load the details." }); });
    return () => { live = false; };
  }, [accountId, current]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const { loading, info, error } = state;
  const isGroup = info?.kind === "group";
  const subtitle = isGroup ? `Group · ${info.memberCount} member${info.memberCount === 1 ? "" : "s"}` : info?.phoneLabel || "";

  return <div className="modal-overlay" role="presentation" onClick={onClose}>
    <div className="modal-card info-card" role="dialog" aria-modal="true" aria-labelledby="chat-info-title" onClick={event => event.stopPropagation()}>
      <div className="info-bar">
        {stack.length > 1 ? <button type="button" className="info-back" onClick={() => setStack(items => items.slice(0, -1))} aria-label="Back to the group">‹</button> : <span />}
        <button type="button" className="info-close" ref={closeRef} onClick={onClose} aria-label="Close">✕</button>
      </div>
      {loading && <p className="loading-hint" role="status"><span className="spinner" aria-hidden="true" />Loading details…</p>}
      {error && <p className="chat-error" role="alert">{error}</p>}
      {info && <>
        <div className="info-head">
          <Avatar className="info-avatar" picture={info.picture} label={info.name} />
          <h3 id="chat-info-title">{info.name}</h3>
          {subtitle && <small>{subtitle}</small>}
        </div>
        {!isGroup && <>
          <section className="info-section"><h4>About</h4><p>{info.about || <span className="info-muted">No About shared</span>}</p></section>
          {info.phoneLabel && <section className="info-section"><h4>Phone</h4><p>{info.phoneLabel}</p></section>}
          {info.business && <section className="info-section"><h4>Business</h4>
            {info.business.category && <p>{info.business.category}</p>}
            {info.business.description && <p>{info.business.description}</p>}
            {info.business.address && <p>{info.business.address}</p>}
            {info.business.email && <p>{info.business.email}</p>}
            {info.business.website.map(site => <p key={site}>{site}</p>)}
          </section>}
        </>}
        {isGroup && <>
          <section className="info-section"><h4>Description</h4><p>{info.description || <span className="info-muted">No description</span>}</p></section>
          {(info.createdAt || info.createdBy) && <section className="info-section"><h4>Created</h4><p>{info.createdBy ? `By ${info.createdBy.name}` : ""}{info.createdBy && info.createdAt ? " · " : ""}{info.createdAt ? day(info.createdAt) : ""}</p></section>}
          {(info.onlyAdminsCanWrite || info.onlyAdminsCanEdit || info.disappearingSeconds > 0) && <section className="info-section"><h4>Settings</h4>
            {info.onlyAdminsCanWrite && <p>Only admins can send messages</p>}
            {info.onlyAdminsCanEdit && <p>Only admins can edit the group info</p>}
            {info.disappearingSeconds > 0 && <p>Disappearing messages: {DISAPPEARING[info.disappearingSeconds] || `${Math.round(info.disappearingSeconds / 3600)} hours`}</p>}
          </section>}
          <section className="info-section"><h4>{info.memberCount} member{info.memberCount === 1 ? "" : "s"}</h4>
            <ul className="info-members">
              {info.members.map(member => <li key={member.id}>
                <button type="button" className="info-member" disabled={member.isMe} onClick={() => setStack(items => [...items, member.id])}>
                  <Avatar className="sender-avatar" label={member.name} />
                  <span className="info-member-name"><b>{member.name}</b>{member.number && member.name !== `+${member.number}` && <small>+{member.number}</small>}</span>
                  {member.admin && <em className="info-admin">{member.admin === "superadmin" ? "Group creator" : "Group admin"}</em>}
                </button>
              </li>)}
            </ul>
          </section>
        </>}
      </>}
    </div>
  </div>;
}
