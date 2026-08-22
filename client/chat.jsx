import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Keep the first request small: WEBJS may need a browser-backed provider call
// for each history page, so a large eager load makes opening chats sluggish.
const PAGE_SIZE = 20;
// WAHA engines may return a message id as either a string or a structured key.
// String(object) is always "[object Object]", which made every such outgoing
// message share one React/merge key and caused later sends to replace earlier
// bubbles. Preserve a provider-supplied serialized value, or serialize the
// complete key as a stable, unique client identity.
function serializedId(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const direct = value._serialized || value.serialized;
  if (typeof direct === "string" || typeof direct === "number") return String(direct);
  if (typeof value.id === "string" || typeof value.id === "number") return String(value.id);
  try { return JSON.stringify(value); } catch { return ""; }
}
const idFor = (message, index) => serializedId(message?.id) || `${message?.timestamp || 0}-${message?.fromMe ? "out" : "in"}-${message?.body || message?.text || "message"}-${index}`;
const stamp = (message) => Number(message?.timestamp) || 0;
const pageOf = (result) => Array.isArray(result) ? result : (result?.messages || []);
const endpoint = (accountId, chatId, offset = 0) => `/api/app/accounts/${encodeURIComponent(accountId)}/messages?chatId=${encodeURIComponent(chatId)}&limit=${PAGE_SIZE}&offset=${offset}`;

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}
function merge(current, extra) {
  const keyed = new Map();
  [...current, ...extra].forEach((message, index) => keyed.set(idFor(message, index), message));
  return [...keyed.values()].sort((a, b) => stamp(a) - stamp(b));
}
function mediaSrc(message) {
  const raw = message?.mediaUrl || message?.media?.url;
  if (!raw) return null;
  if (/^data:(image|video|audio)\//i.test(raw) || /^blob:/i.test(raw)) return raw;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin === window.location.origin && url.pathname === "/api/app/media") return `${url.pathname}${url.search}`;
    if (!url.pathname.startsWith("/api/files/")) return null;
    return `/api/app/media?path=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
  } catch { return null; }
}
function mediaKind(message) {
  const type = String(message?.media?.mimetype || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/") ) return "audio";
  return "document";
}
function avatarSrc(value) {
  const picture = String(value || "").trim();
  if (/^data:image\//i.test(picture)) return picture;
  if (picture.startsWith("/api/app/media?")) return picture;
  return /^https?:\/\//i.test(picture) ? `/api/app/link-image?url=${encodeURIComponent(picture)}` : null;
}
function Avatar({ picture, label, className = "avatar" }) {
  const [failed, setFailed] = useState(false);
  const src = avatarSrc(picture), letter = String(label || "?")[0]?.toUpperCase() || "?";
  return src && !failed ? <img className={className} src={src} alt="" onError={() => setFailed(true)} /> : <span className={`${className} ${className.includes("sender-avatar") ? "sender-letter" : "avatar-letter"}`} aria-hidden="true">{letter}</span>;
}
function Sender({ sender }) {
  const label = sender?.name || sender?.id || "Unknown sender";
  return <span className="message-sender"><Avatar className="sender-avatar" picture={sender?.picture} label={label}/><span>{label}</span></span>;
}
function mediaTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const minutes = Math.floor(value / 60), seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function PlayableMedia({ kind, src, filename }) {
  const playerRef = useRef(null);
  const [duration, setDuration] = useState(0), [position, setPosition] = useState(0), [playing, setPlaying] = useState(false);
  const updateDuration = event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
  const updatePosition = event => setPosition(event.currentTarget.currentTime || 0);
  const toggle = () => {
    const player = playerRef.current; if (!player) return;
    if (player.paused) player.play().catch(() => {}); else player.pause();
  };
  const seek = event => {
    const player = playerRef.current, value = Number(event.currentTarget.value);
    if (!player || !Number.isFinite(value)) return;
    player.currentTime = value; setPosition(value);
  };
  const mediaProps = { ref: playerRef, className: `message-media media ${kind}`, preload: "metadata", src, onLoadedMetadata:updateDuration, onDurationChange:updateDuration, onTimeUpdate:updatePosition, onPlay:() => setPlaying(true), onPause:() => setPlaying(false), onEnded:() => { setPlaying(false); setPosition(0); } };
  const download = <a className={kind === "audio" ? "audio-download" : "video-download"} href={src} download={filename || kind} aria-label={`Download ${filename || kind}`} title={`Download ${filename || kind}`}>⇩</a>;
  const progress = <input className={kind === "audio" ? "audio-progress" : "video-progress"} type="range" min="0" max={duration || 0} step="0.01" value={Math.min(position, duration || 0)} onChange={seek} aria-label={`${kind} playback position`} disabled={!duration}/>;
  if (kind === "audio") return <div className={`audio-player${playing ? " playing" : ""}`}><audio {...mediaProps}/><button type="button" className="audio-play" onClick={toggle} aria-label={playing ? "Pause audio" : "Play audio"}>{playing ? "Ⅱ" : "▶"}</button><div className="audio-main">{progress}<div className="audio-meta"><span>{mediaTime(position)}</span><span>{mediaTime(duration)}</span></div></div>{download}</div>;
  return <div className={`video-player${playing ? " playing" : ""}`}><div className="video-stage" onClick={toggle}><video {...mediaProps} playsInline/><button type="button" className="video-play" onClick={event => { event.stopPropagation(); toggle(); }} aria-label={playing ? "Pause video" : "Play video"}>{playing ? "Ⅱ" : "▶"}</button></div><div className="video-controls"><button type="button" onClick={toggle} aria-label={playing ? "Pause video" : "Play video"}>{playing ? "Ⅱ" : "▶"}</button>{progress}<span className="video-time">{mediaTime(position)} / {mediaTime(duration)}</span>{download}</div></div>;
}
function MediaCard({ message, accountId, chatId, onResolved }) {
  const src = mediaSrc(message);
  const needsMedia = Boolean(message?.hasMedia || message?.media || message?.mediaUrl);
  useEffect(() => {
    if (!needsMedia || src || !message?.id || !accountId || !chatId) return undefined;
    let active = true;
    api(`/api/app/accounts/${encodeURIComponent(accountId)}/message-media?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(message.id)}`).then(result => { if (active && result?.message) onResolved?.(result.message); }).catch(() => {});
    return () => { active = false; };
  }, [accountId, chatId, message?.id, needsMedia, onResolved, src]);
  if (!needsMedia) return null;
  const kind = mediaKind(message), filename = message?.media?.filename || (kind === "document" ? "Attachment" : "");
  if (!src) return <p className="media-unavailable">Loading attachment…</p>;
  if (kind === "image") return <img className="message-media media image" src={src} alt={message.body || message.text || "Image attachment"} loading="lazy" />;
  if (kind === "video") return <PlayableMedia kind="video" src={src} filename={filename||"video"}/>;
  if (kind === "audio") return <PlayableMedia kind="audio" src={src} filename={filename||"audio"}/>;
  return <a className="message-document" href={src} target="_blank" rel="noreferrer" download={filename}><span aria-hidden="true">▧</span><span>{filename}</span></a>;
}
function LinkPreview({ body, preview }) {
  const match = String(body || "").match(/https?:\/\/[^\s]+/i);
  const url = preview?.url || match?.[0];
  const [fetched, setFetched] = useState(null);
  const [loading, setLoading] = useState(false);
  
  // Fetch OG data for ANY URL in the message (like old vanilla version)
  useEffect(() => {
    if (!url) { setFetched(null); return undefined; }
    let active = true;
    setLoading(true);
    let instagram = false; try { instagram = /instagram\.com$/i.test(new URL(url).hostname); } catch {}
    fetch(`${instagram ? "/api/app/instagram-preview" : "/api/app/link-preview"}?url=${encodeURIComponent(url)}`)
      .then(response => response.ok ? response.json() : null)
      .then(value => { if (active) { setFetched(value); setLoading(false); } })
      .catch(() => { if (active) { setFetched(null); setLoading(false); } });
    return () => { active = false; };
  }, [url]);
  
  if (!url) return null;
  let instagram = false; try { instagram = /instagram\.com$/i.test(new URL(url).hostname); } catch {}
  
  // Merge: use WAHA preview as base, enhance with fetched OG data
  // This mirrors the old vanilla JS: render immediately, then enhance when fetch completes
  const data = {
    url: preview?.url || url,
    title: preview?.title || fetched?.title || null,
    description: preview?.description || fetched?.description || null,
    image: preview?.image || fetched?.image || null
  };
  const imageUrl = typeof data.image === "string" ? data.image : data.image?.href || null;
  const hasContent = data.title || data.description || data.image;
  const readable = (value, limit) => {
    const text = String(value || "").replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code))).replace(/&(quot|apos|amp|lt|gt);/gi, (_match, entity) => ({quot:'"',apos:"'",amp:'&',lt:'<',gt:'>'})[entity.toLowerCase()]).replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
  };
  const image = /^data:image\//i.test(String(imageUrl || "")) ? imageUrl : imageUrl ? `${instagram ? "/api/app/instagram-image" : "/api/app/link-image"}?url=${encodeURIComponent(imageUrl)}` : null;
  const previewImage = image && <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => {
    const imageNode=event.currentTarget;
    if (!instagram && !imageNode.dataset.directFallback && imageUrl) { imageNode.dataset.directFallback="true"; imageNode.src=imageUrl; return; }
    imageNode.style.display="none";
  }} />;
  if (instagram) return <a className="link-preview instagram-native-preview" href={url} target="_blank" rel="noreferrer">{previewImage || <div className="site-preview-mark instagram-mark" aria-hidden="true">◎</div>}<span><em>Instagram</em><b>{readable(data.title || "Instagram post", 120)}</b>{data.description && <small>{readable(data.description, 240)}</small>}<small className="instagram-open">Open on Instagram ↗</small></span></a>;
  if (!hasContent) {
    let hostname = "Website", label = "Open website";
    try {
      hostname = new URL(url).hostname.replace(/^www\./, "");
      if (/(^|\.)indeed\.com$/i.test(hostname)) label = "Indeed job listing";
    } catch {}
    return <a className="link-preview site-preview" href={url} target="_blank" rel="noreferrer"><div className="site-preview-mark" aria-hidden="true">{hostname[0]?.toUpperCase() || "↗"}</div><span><b>{hostname}</b><small>{label}</small></span></a>;
  }
  return <a className="link-preview" href={url} target="_blank" rel="noreferrer">{previewImage}<span><b>{readable(data.title || url, 120)}</b>{data.description && <small>{readable(data.description, 240)}</small>}</span></a>;
}
function MessageCard({ message, accountId, chatId, chatPicture, onMediaResolved }) {
  const body = message?.body || message?.text || message?.caption || "";
  const previewUrl = message?.linkPreview?.url || String(body).match(/https?:\/\/[^\s]+/i)?.[0];
  const visibleBody = previewUrl ? String(body).replace(previewUrl, "").trim() : body;
  return <article className={`message ${message.fromMe ? "mine" : ""}${message.pending ? " pending" : ""}`}>
    {!message.fromMe && message.sender && <Sender sender={{...message.sender,picture:message.sender.picture||chatPicture}} />}
    <MediaCard message={message} accountId={accountId} chatId={chatId} onResolved={onMediaResolved} />
    {visibleBody && <span className="message-body">{visibleBody}</span>}
    <LinkPreview body={body} preview={message?.linkPreview} />
    {!visibleBody && !previewUrl && !message?.hasMedia && !message?.media && !message?.mediaUrl && <span className={`message-body system-message ${message?.system?.kind || ""}`}>{message?.system?.label || "Message unavailable"}</span>}
    <time>{stamp(message) ? new Date(stamp(message) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</time>
  </article>;
}

export function ChatPanel({ accountId, chat, onBack, onSent, onDeleted }) {
  const paneRef = useRef(null);
  const requestRef = useRef(0);
  const initialChatRef = useRef(null);
  const restoreAnchorRef = useRef(null);
  const historyRestoreRef = useRef(null);
  const olderRequestRef = useRef(false);
  const followLatestRef = useRef(false);
  const [messages, setMessages] = useState([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const chatId = chat?.id;

  const captureAnchor = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return null;
    const paneTop = pane.getBoundingClientRect().top;
    const row = [...pane.querySelectorAll("[data-message-key]")].find(node => node.getBoundingClientRect().bottom > paneTop);
    return row ? { key: row.dataset.messageKey, offset: row.getBoundingClientRect().top - paneTop } : null;
  }, []);

  useEffect(() => {
    const version = ++requestRef.current;
    initialChatRef.current = null;
    restoreAnchorRef.current = null;
    historyRestoreRef.current = null;
    olderRequestRef.current = false;
    setMessages([]); setOffset(0); setExhausted(false); setError(""); setLoading(Boolean(chatId));
    if (!accountId || !chatId) return undefined;
    api(endpoint(accountId, chatId)).then(result => {
      if (requestRef.current !== version) return;
      const page = pageOf(result).sort((a, b) => stamp(a) - stamp(b));
      setMessages(page); setOffset(page.length); setExhausted(page.length < PAGE_SIZE);
    }).catch(cause => {
      if (requestRef.current === version) setError(cause.message || "Could not load messages.");
    }).finally(() => {
      if (requestRef.current === version) setLoading(false);
    });
    return () => { if (requestRef.current === version) requestRef.current += 1; };
  }, [accountId, chatId]);

  // Keep the active conversation live without fanning requests out across the
  // inbox. Any new sent or received message is an explicit instruction to show
  // the latest point in the thread.
  useEffect(() => {
    if (!accountId || !chatId) return undefined;
    let active = true;
    const refreshLatest = async () => {
      try {
        const page = pageOf(await api(endpoint(accountId, chatId)));
        if (!active || !page.length) return;
        setMessages(current => {
          const known = new Set(current.map((message, index) => idFor(message, index)));
          const hasNewMessage = page.some((message, index) => !known.has(idFor(message, index)));
          if (hasNewMessage) followLatestRef.current = true;
          return hasNewMessage ? merge(current, page) : current;
        });
      } catch {
        // A transient provider failure should not replace the open chat with an
        // error state; the next active-chat refresh can recover naturally.
      }
    };
    const timer = window.setInterval(refreshLatest, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [accountId, chatId]);

  useLayoutEffect(() => {
    if (!messages.length || initialChatRef.current === chatId) return undefined;
    initialChatRef.current = chatId;
    const frame = requestAnimationFrame(() => { if (paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [chatId, messages.length]);

  // Sending is an explicit reader intent. Keep the new pending/final message in
  // view without fighting scrolling while the reader is browsing older history.
  useLayoutEffect(() => {
    if (!followLatestRef.current || !messages.length) return;
    followLatestRef.current = false;
    const frame = requestAnimationFrame(() => { if (paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [messages.length]);

  useLayoutEffect(() => {
    const anchor = restoreAnchorRef.current;
    if (!anchor || !paneRef.current) return undefined;
    const frame = requestAnimationFrame(() => {
      const pane = paneRef.current;
      const row = pane?.querySelector(`[data-message-key="${CSS.escape(anchor.key)}"]`);
      if (restoreAnchorRef.current !== anchor || !pane || !row) return;
      pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - anchor.offset;
      restoreAnchorRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  // Older history is inserted above the reader. Restoring by the actual
  // scroll-height delta is deterministic for a normal DOM list: regardless of
  // page size, the exact pre-request viewport remains visible.
  useLayoutEffect(() => {
    const before = historyRestoreRef.current;
    if (!before || !paneRef.current) return undefined;
    const frame = requestAnimationFrame(() => {
      const pane = paneRef.current;
      if (historyRestoreRef.current !== before || !pane) return;
      pane.scrollTop = before.top + pane.scrollHeight - before.height;
      historyRestoreRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  const resolveMedia = useCallback(resolved => {
    if (!resolved?.id) return;
    restoreAnchorRef.current = captureAnchor();
    setMessages(current => current.map(message => idFor(message, 0) === idFor(resolved, 0) ? { ...message, ...resolved, media: resolved.media || message.media, mediaUrl: resolved.mediaUrl || message.mediaUrl } : message));
  }, [captureAnchor]);
  const loadOlder = useCallback(async () => {
    if (!chatId || olderLoading || exhausted || olderRequestRef.current) return;
    olderRequestRef.current = true;
    const version = requestRef.current;
    const pane = paneRef.current;
    if (pane) historyRestoreRef.current = { top: pane.scrollTop, height: pane.scrollHeight };
    setOlderLoading(true); setError("");
    try {
      const page = pageOf(await api(endpoint(accountId, chatId, offset)));
      if (requestRef.current !== version) return;
      setMessages(current => merge(current, page));
      setOffset(current => current + page.length);
      setExhausted(page.length < PAGE_SIZE);
    } catch (cause) {
      if (requestRef.current === version) { historyRestoreRef.current = null; setError(cause.message || "Could not load earlier messages."); }
    } finally {
      olderRequestRef.current = false;
      if (requestRef.current === version) setOlderLoading(false);
    }
  }, [accountId, chatId, exhausted, offset, olderLoading]);

  const maybeLoadOlder = useCallback(event => {
    if (event.currentTarget.scrollTop <= 120) loadOlder();
  }, [loadOlder]);

  // Short conversations may not fill the viewport enough to be scrollable.
  // Continue paging only in that case; once it fills, further history loads
  // happen naturally as the reader scrolls toward the top.
  useEffect(() => {
    if (loading || olderLoading || exhausted || !messages.length) return undefined;
    const pane = paneRef.current;
    if (!pane || pane.scrollTop > 120 || pane.scrollHeight > pane.clientHeight + 120) return undefined;
    const frame = requestAnimationFrame(loadOlder);
    return () => cancelAnimationFrame(frame);
  }, [exhausted, loadOlder, loading, messages.length, olderLoading]);

  const send = useCallback(async event => {
    event.preventDefault();
    const field = event.currentTarget.elements.text;
    const text = field?.value?.trim();
    if (!text || !chatId) return;
    field.value = "";
    const pending = { id: `pending-${Date.now()}`, body: text, fromMe: true, timestamp: Math.floor(Date.now() / 1000), pending: true };
    followLatestRef.current = true;
    setMessages(current => [...current, pending]);
    try {
      const result = await api(`/api/app/accounts/${encodeURIComponent(accountId)}/messages`, { method: "POST", body: JSON.stringify({ chatId, text }) });
      const confirmed = result.message ? { ...pending, ...result.message, body: result.message.body || result.message.text || pending.body, text: result.message.text || result.message.body || pending.text || pending.body, pending: false } : null;
      setMessages(current => merge(current.filter(message => message.id !== pending.id), confirmed ? [confirmed] : []));
      onSent?.(result.message, chat);
    } catch (cause) {
      setMessages(current => current.filter(message => message.id !== pending.id));
      setError(cause.message || "Could not send message.");
    }
  }, [accountId, chat, chatId, onSent]);

  const deleteConversation = useCallback(async () => {
    if (!chatId || deleting || !window.confirm(`Delete the conversation with ${chat?.name || chatId}? This removes it from WhatsApp and cannot be undone.`)) return;
    setDeleting(true); setError("");
    try {
      await api(`/api/app/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
      onDeleted?.(chatId);
    } catch (cause) {
      setError(cause.message || "Could not delete this conversation.");
    } finally {
      setDeleting(false);
    }
  }, [accountId, chat?.name, chatId, deleting, onDeleted]);

  const name = chat?.name || chatId || "Conversation";
  return <div className="conversation-react-root" aria-label={name}>
    <header className="conversation-head">
      {onBack && <button type="button" className="back" onClick={onBack} aria-label="Back to conversations">‹</button>}
      <Avatar picture={chat?.picture} label={name}/><span className="chat-title"><b>{name}</b><small>Chat ID: {chatId || "Unavailable"}</small></span>
      <button type="button" className="conversation-delete" onClick={deleteConversation} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
    </header>
    <div className="messages" ref={paneRef} onScroll={maybeLoadOlder}>
      <div className="history-control" role="status">{olderLoading ? "Loading earlier messages…" : exhausted ? "Beginning of this conversation" : "Scroll up for earlier messages"}</div>
      {error && <p className="chat-error" role="alert">{error}</p>}
      {loading && !messages.length ? <p className="chat-loading">Loading messages…</p> : <div className="message-list">
        {messages.map((message,index) => <div key={idFor(message,index)} data-message-key={idFor(message,index)} className={`message-row ${message.fromMe ? "mine" : ""}`}><MessageCard message={message} accountId={accountId} chatId={chatId} chatPicture={!/@g\.us$/i.test(chatId||"")?chat?.picture:null} onMediaResolved={resolveMedia}/></div>)}
      </div>}
    </div>
    <form className="composer" onSubmit={send}>
      <textarea
        name="text"
        rows="1"
        placeholder="Type a message"
        aria-label="Message"
        onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form.requestSubmit();
          }
        }}
      />
      <button className="primary" type="submit">Send</button>
    </form>
  </div>;
}
export default ChatPanel;
