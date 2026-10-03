import React, { useEffect, useId, useState } from "react";

const MIN_PASSWORD = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Open eye = the password is showing; eye with a slash = it is hidden.
const iconProps = { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" };
const EyeOpen = () => <svg {...iconProps}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>;
const EyeClosed = () => <svg {...iconProps}><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.9 9.9 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>;

function PasswordField({ label, value, onChange, autoComplete, hint, error }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return <div className="profile-field">
    <label htmlFor={id}>{label}</label>
    <div className="password-input">
      <input id={id} type={shown ? "text" : "password"} value={value} onChange={event => onChange(event.currentTarget.value)} autoComplete={autoComplete} aria-invalid={error ? "true" : undefined} aria-describedby={error || hint ? `${id}-note` : undefined}/>
      <button type="button" className="password-toggle" aria-pressed={shown} aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} title={shown ? "Hide password" : "Show password"} onClick={() => setShown(current => !current)}>{shown ? <EyeOpen/> : <EyeClosed/>}</button>
    </div>
    {(error || hint) && <small id={`${id}-note`} className={error ? "profile-error" : "profile-hint"}>{error || hint}</small>}
  </div>;
}

// Workspace sign-in details. Username and email save on their own; the current
// password is asked for only when setting a new one. The Save button stays off
// until something actually changed, and a new password is checked (length,
// confirmation) before anything is sent.
export function AdminProfileCard({ profile, busy, onSave }) {
  const usernameId = useId();
  const emailId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false); // collapsed until the reader opens it
  const [username, setUsername] = useState(profile?.username || "");
  const [email, setEmail] = useState(profile?.email || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => { setUsername(profile?.username || ""); }, [profile?.username]);
  useEffect(() => { setEmail(profile?.email || ""); }, [profile?.email]);

  const usernameChanged = username.trim() !== (profile?.username || "");
  const emailChanged = email.trim().toLowerCase() !== (profile?.email || "");
  const emailInvalid = email.trim().length > 0 && !EMAIL_PATTERN.test(email.trim());
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const incomplete = newPassword.length > 0 && confirmPassword !== newPassword;
  const changed = usernameChanged || emailChanged || newPassword.length > 0;
  const canSave = changed && (newPassword.length === 0 || !!currentPassword) && !tooShort && !incomplete && !emailInvalid && username.trim().length >= 3 && !busy;

  const submit = async event => {
    event.preventDefault();
    if (!canSave) return;
    const saved = await onSave({ username: username.trim(), email: email.trim(), currentPassword, newPassword });
    if (saved) { setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); }
  };

  // Collapsed, the whole card is the button; open, the header collapses it
  // again and the form below is left alone.
  const toggle = () => setOpen(current => !current);
  return <section className={`details-card security${open ? " is-open" : ""}`} aria-labelledby="admin-profile-title" onClick={() => { if (!open) setOpen(true); }}>
    <div className="profile-head" onClick={toggle}>
      <div className="profile-heading">
        <h3 id="admin-profile-title">
          <button type="button" className="profile-toggle" aria-expanded={open} aria-controls={panelId}>
            Profile details
            <svg className="profile-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </h3>
        <p>The username and password you use to sign in to this workspace.</p>
      </div>
      <span className="admin-pill">Admin</span>
    </div>
    <form className="admin-form" id={panelId} hidden={!open} onSubmit={submit}>
      <div className="profile-field profile-wide">
        <label htmlFor={usernameId}>Username</label>
        <input id={usernameId} value={username} onChange={event => setUsername(event.currentTarget.value)} autoComplete="username" minLength="3" required/>
      </div>
      <div className="profile-field">
        <label htmlFor={emailId}>Email</label>
        <input id={emailId} type="email" value={email} onChange={event => setEmail(event.currentTarget.value)} autoComplete="email" placeholder="you@example.com" aria-invalid={emailInvalid ? "true" : undefined} aria-describedby={`${emailId}-note`}/>
        <small id={`${emailId}-note`} className={emailInvalid ? "profile-error" : "profile-hint"}>{emailInvalid ? "Enter a valid email address." : "Optional. You can sign in with your username or this email."}</small>
      </div>
      <PasswordField label="Current password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password"
        hint="Only needed when you set a new password."/>
      <PasswordField label="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD} characters. Leave blank to keep your current password.`} error={tooShort ? `Use at least ${MIN_PASSWORD} characters.` : ""}/>
      <PasswordField label="Confirm new password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password"
        error={mismatch ? "The passwords don't match." : ""}/>
      <div className="profile-actions">
        <button className="primary" disabled={!canSave}>{busy ? "Saving…" : "Save sign-in details"}</button>
      </div>
    </form>
  </section>;
}
