import React, { useEffect, useId, useState } from "react";
import { api } from "./app-helpers.mjs";
import { confirmDialog } from "./confirm.jsx";
import { TagPicker } from "./tag-picker.jsx";
import { useReplyList } from "./reply-list.jsx";

// The AI Voice and Tone tab: up to five YAML documents per WhatsApp account, each describing how the
// AI sounds — and what it must never do — for one kind of conversation. The editor checks the YAML
// as you type and shows exactly what the AI will be told, so nothing about a voice is hidden. Each
// voice card also holds the people and groups it answers: they are listed on the card and added
// right there, so there is no separate "who to reply to" screen to keep in step.
const GUIDE = [
  ["name", "Required. What you call this voice, for example Mom."],
  ["about_them", "Who you are talking to."],
  ["voice", "How you sound — a sentence, or a list such as [warm, brief]."],
  ["language", "The language to reply in, for example pt-BR."],
  ["max_sentences / emoji", "Length (1–10 sentences) and emoji use (none, sparingly, often)."],
  ["facts_about_me", "The ONLY things about you the AI may say. Use [] to allow none."],
  ["never", "A list of things the AI must not do."],
  ["when_unsure", "What to do when it is unsure or the topic needs you."],
  ["examples", "Pairs of they: / me: — your real messages, so it sounds like you."],
  ["groups", "Different settings for group chats: voice, max_sentences, never."],
  ["instructions", "Anything else, in your own words."],
];

const when = value => (value ? new Date(value).toLocaleDateString([], { dateStyle: "medium" }) : "");

export function VoiceProfilesPanel({ base, data, llm, onLlmSaved, onOpenAi, onChanged, onNotice }) {
  const editorId = useId();
  const [editor, setEditor] = useState(null);          // null = the list; otherwise { id, yaml, original }
  const [check, setCheck] = useState(null);            // the server's verdict on the YAML being edited
  const [previewTab, setPreviewTab] = useState("direct");
  const [guideOpen, setGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { voices = [], limit = 5, templates = [] } = data || {};
  const reply = useReplyList({ llm, base, voices, onSaved: onLlmSaved, onNotice });
  const usage = id => reply.boxes.find(box => box.voiceId === id)?.entries.length || 0;

  // Check the YAML a moment after typing stops.
  useEffect(() => {
    if (!editor) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      try { const result = await api(`${base}/voices/validate`, { method: "POST", body: JSON.stringify({ yaml: editor.yaml }) }); if (live) setCheck(result); }
      catch (error) { if (live) setCheck({ ok: false, errors: [{ message: error.message }] }); }
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [editor?.yaml, base]);   // eslint-disable-line react-hooks/exhaustive-deps

  const openNew = templateId => {
    const template = templates.find(item => item.id === templateId) || templates[0];
    setCheck(null); setPreviewTab("direct");
    setEditor({ id: null, yaml: template?.yaml || "name: My voice\n", original: "", templateId: template?.id });
  };
  const openEdit = voice => { setCheck(null); setPreviewTab("direct"); setEditor({ id: voice.id, yaml: voice.yaml, original: voice.yaml }); };

  const save = async () => {
    if (!editor || busy || !check?.ok) return;
    setBusy(true);
    try {
      await api(editor.id ? `${base}/voices/${encodeURIComponent(editor.id)}` : `${base}/voices`, { method: editor.id ? "PUT" : "POST", body: JSON.stringify({ yaml: editor.yaml }) });
      onNotice(editor.id ? "Voice saved." : `${check.name} voice created.`);
      setEditor(null);
      await onChanged();
    } catch (error) { onNotice(error.message); } finally { setBusy(false); }
  };

  const remove = async voice => {
    const users = usage(voice.id);
    const confirmed = await confirmDialog({
      title: `Delete the ${voice.name} voice?`,
      message: users ? `${users} ${users === 1 ? "person or group uses" : "people and groups use"} it. They will go back to the default instructions.` : "This can't be undone.",
      confirmLabel: "Delete voice", danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try { await api(`${base}/voices/${encodeURIComponent(voice.id)}`, { method: "DELETE" }); setEditor(null); await onChanged(); }
    catch (error) { onNotice(error.message); } finally { setBusy(false); }
  };

  if (editor) {
    const unchanged = editor.yaml === editor.original;
    const canSave = !!check?.ok && !unchanged && !busy;
    return <section className="details-card voice-editor" aria-labelledby={`${editorId}-title`}>
      <div className="voice-editor-head">
        <div>
          <h3 id={`${editorId}-title`}>{editor.id ? "Edit voice" : "New voice profile"}</h3>
          <p>Write it as YAML. Guardrails and sample messages are part of it.</p>
        </div>
        {!editor.id && templates.length > 0 && <label className="voice-template">Start from
          <select value={editor.templateId || ""} onChange={event => openNew(event.currentTarget.value)}>
            {templates.map(template => <option key={template.id} value={template.id}>{template.label}</option>)}
          </select>
        </label>}
      </div>
      <textarea className="voice-yaml" id={editorId} value={editor.yaml} onChange={event => { const yaml = event.currentTarget.value; setEditor(current => ({ ...current, yaml })); }} spellCheck="false" aria-label="Voice profile YAML" aria-describedby={`${editorId}-status`}/>
      <div className="voice-status" id={`${editorId}-status`} role="status" aria-live="polite">
        {check === null && <span className="voice-checking">Checking…</span>}
        {check?.ok && <span className="voice-valid">✓ Looks good — saves as “{check.name}”</span>}
        {check && !check.ok && <ul className="voice-errors">{check.errors.map((error, index) => <li key={index}>{error.line ? <b>Line {error.line}</b> : null}{error.line ? " — " : ""}{error.message}</li>)}</ul>}
      </div>

      <details className="voice-fold" open={guideOpen} onToggle={event => setGuideOpen(event.currentTarget.open)}>
        <summary>Format guide</summary>
        <dl className="voice-guide">{GUIDE.map(([key, text]) => <React.Fragment key={key}><dt><code>{key}</code></dt><dd>{text}</dd></React.Fragment>)}</dl>
      </details>
      {check?.ok && <details className="voice-fold">
        <summary>What the AI will be told</summary>
        <div className="token-tabs" role="tablist" aria-label="Chat type">
          {[["direct", "Direct chat"], ["group", "Group chat"]].map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={previewTab === id} className={previewTab === id ? "on" : ""} onClick={() => setPreviewTab(id)}>{label}</button>)}
        </div>
        <pre className="token-code voice-preview" tabIndex={0}><code>{check.preview[previewTab]}</code></pre>
      </details>}

      <div className="voice-actions">
        <button type="button" className="primary" disabled={!canSave} onClick={save}>{busy ? "Saving…" : "Save voice"}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setEditor(null)}>Cancel</button>
        {editor.id && <button type="button" className="secondary token-delete voice-delete" disabled={busy} onClick={() => remove(voices.find(item => item.id === editor.id) || { id: editor.id, name: check?.name || "this" })}>Delete voice</button>}
      </div>
    </section>;
  }

  // The people and groups a voice answers, with a search to add more right on the card.
  const people = (box, name, emptyText) => reply.configured
    ? <TagPicker
        label={name} empty={emptyText} tags={box.entries} search={reply.searchFor(box.voiceId)}
        onAdd={option => reply.add(box.voiceId, option)} onRemove={reply.remove}
      />
    : <small className="profile-hint">To choose who this voice answers, <button type="button" className="link-button" onClick={onOpenAi}>set up the AI provider</button> first.</small>;
  const fallback = reply.boxes.find(box => !box.voiceId);
  // People without a voice (for example listed before voices existed) still need a home, and with
  // no voices at all this is where the AI's audience is chosen.
  const showFallback = reply.configured && (fallback.entries.length > 0 || voices.length === 0);

  return <section className="details-card voice-list-card" aria-labelledby="voices-title">
    <div className="voice-list-head">
      <div>
        <h3 id="voices-title">AI Voice and Tone</h3>
        <p>How the AI sounds for different people — your mom is not your friends. Each voice profile has a name and a short YAML with its rules and sample messages, and lists the people and groups it answers. The AI only answers who is listed; in a group, only when you are tagged.</p>
      </div>
      <span className="token-count">{voices.length} of {limit}</span>
    </div>
    <div className="voice-list">
      {voices.map(voice => {
        const box = reply.boxes.find(item => item.voiceId === voice.id);
        const users = usage(voice.id);
        return <div className="voice-card is-clickable" key={voice.id} onClick={event => { if (!event.target.closest("button, input, select, textarea, a, .tag-picker")) openEdit(voice); }}>
          <div className="voice-card-head">
            <div className="voice-card-info">
              <button type="button" className="voice-card-title" onClick={() => openEdit(voice)} aria-label={`Edit the ${voice.name} voice`}>{voice.name}</button>
              <small>{users ? `Answers ${users} ${users === 1 ? "person or group" : "people and groups"}` : "Not answering anyone yet"} · Updated {when(voice.updatedAt)} · <code className="voice-id" title="Stable ID — it does not change when you rename the voice">{voice.id}</code></small>
            </div>
            <svg className="voice-card-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>
          </div>
          <div className="voice-card-body">{people(box, voice.name, "No one yet")}</div>
        </div>;
      })}
      {showFallback && <div className="voice-card is-fallback">
        <div className="voice-card-head">
          <div className="voice-card-info">
            <b>{voices.length ? "Everyone else" : "Who should the AI reply to?"}</b>
            <small>{voices.length ? "No voice chosen, so they get your default instructions (AI responses tab)" : "Create a voice above to answer different people differently. Until then everyone gets your default instructions."}</small>
          </div>
        </div>
        <div className="voice-card-body">{people(fallback, "everyone else", "No one yet")}</div>
      </div>}
      {!voices.length && <div className="voice-empty"><b>No voice profiles yet</b><small>Start from a template for family, friends or work, then make it sound like you.</small></div>}
    </div>
    <button type="button" className="primary voice-new" disabled={voices.length >= limit} onClick={() => openNew(voices.length ? "blank" : "family")} title={voices.length >= limit ? `An account can have up to ${limit} voice profiles` : undefined}>+ New voice profile</button>
    {voices.length >= limit && <small className="profile-hint">You have reached the limit of {limit}. Delete one to add another.</small>}
  </section>;
}
