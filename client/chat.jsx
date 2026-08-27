import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PAGE_SIZE, serializedId, idFor, stamp, pageOf, endpoint, merge, nextComposerValue, confirmSentMessage } from "./chat-helpers.mjs";
import { api } from "./app-helpers.mjs";
import { Avatar } from "./ui-helpers.jsx";

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
  const [playError, setPlayError] = useState("");
  const updateDuration = event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
  const updatePosition = event => setPosition(event.currentTarget.currentTime || 0);
  // A load/decode failure on <audio>/<video> previously had no handler at
  // all — the element just sat there silently inert: no duration ever
  // arrives (so the progress bar stays permanently disabled-looking), and
  // play() rejects into a swallowed .catch(() => {}), so clicking play does
  // nothing with zero feedback. Surface it the same way MediaCard already
  // does for a failed image/resolve.
  const handleMediaError = () => setPlayError(`Couldn't load this ${kind}`);
  const toggle = () => {
    const player = playerRef.current; if (!player) return;
    if (player.paused) player.play().then(() => setPlayError("")).catch(() => setPlayError(`Couldn't play this ${kind}`));
    else player.pause();
  };
  const seek = event => {
    const player = playerRef.current, value = Number(event.currentTarget.value);
    if (!player || !Number.isFinite(value)) return;
    player.currentTime = value; setPosition(value);
  };
  const mediaProps = { ref: playerRef, className: `message-media media ${kind}`, preload: "metadata", src, onLoadedMetadata:updateDuration, onDurationChange:updateDuration, onTimeUpdate:updatePosition, onPlay:() => { setPlaying(true); setPlayError(""); }, onPause:() => setPlaying(false), onEnded:() => { setPlaying(false); setPosition(0); }, onError:handleMediaError };
  if (playError) return <p className="media-unavailable media-failed">{playError} <a href={src} download={filename||kind}>Download instead</a></p>;
  const download = <a className={kind === "audio" ? "audio-download" : "video-download"} href={src} download={filename || kind} aria-label={`Download ${filename || kind}`} title={`Download ${filename || kind}`}>⇩</a>;
  const progress = <input className={kind === "audio" ? "audio-progress" : "video-progress"} type="range" min="0" max={duration || 0} step="0.01" value={Math.min(position, duration || 0)} onChange={seek} aria-label={`${kind} playback position`} disabled={!duration}/>;
  if (kind === "audio") return <div className={`audio-player${playing ? " playing" : ""}`}><audio {...mediaProps}/><button type="button" className="audio-play" onClick={toggle} aria-label={playing ? "Pause audio" : "Play audio"}>{playing ? "Ⅱ" : "▶"}</button><div className="audio-main">{progress}<div className="audio-meta"><span>{mediaTime(position)}</span><span>{mediaTime(duration)}</span></div></div>{download}</div>;
  return <div className={`video-player${playing ? " playing" : ""}`}><div className="video-stage" onClick={toggle}><video {...mediaProps} playsInline/><button type="button" className="video-play" onClick={event => { event.stopPropagation(); toggle(); }} aria-label={playing ? "Pause video" : "Play video"}>{playing ? "Ⅱ" : "▶"}</button></div><div className="video-controls"><button type="button" onClick={toggle} aria-label={playing ? "Pause video" : "Play video"}>{playing ? "Ⅱ" : "▶"}</button>{progress}<span className="video-time">{mediaTime(position)} / {mediaTime(duration)}</span>{download}</div></div>;
}
function MediaCard({ message, accountId, chatId, onResolved }) {
  const src = mediaSrc(message);
  const needsMedia = Boolean(message?.hasMedia || message?.media || message?.mediaUrl);
  // Both the resolve request and, once resolved, the media element itself
  // used to have no error path at all — either failure left the bubble
  // stuck on "Loading attachment…" forever with no feedback or way to retry.
  const [resolveFailed, setResolveFailed] = useState(false);
  const [displayFailed, setDisplayFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  useEffect(() => {
    if (!needsMedia || src || !message?.id || !accountId || !chatId) return undefined;
    let active = true;
    setResolveFailed(false);
    api(`/api/app/accounts/${encodeURIComponent(accountId)}/message-media?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(message.id)}`)
      .then(result => { if (!active) return; if (result?.message) onResolved?.(result.message); else setResolveFailed(true); })
      .catch(() => { if (active) setResolveFailed(true); });
    return () => { active = false; };
  }, [accountId, chatId, message?.id, needsMedia, onResolved, src, retryToken]);
  if (!needsMedia) return null;
  const kind = mediaKind(message), filename = message?.media?.filename || (kind === "document" ? "Attachment" : "");
  const retry = () => { setResolveFailed(false); setDisplayFailed(false); setRetryToken(token => token + 1); };
  const failedNotice = <p className="media-unavailable media-failed">Couldn't load attachment <button type="button" onClick={retry}>Retry</button></p>;
  if (!src) return resolveFailed ? failedNotice : <p className="media-unavailable">Loading attachment…</p>;
  if (displayFailed) return failedNotice;
  if (kind === "image") return <img className="message-media media image" src={src} alt={message.body || message.text || "Image attachment"} loading="lazy" onError={() => setDisplayFailed(true)} />;
  if (kind === "video") return <PlayableMedia kind="video" src={src} filename={filename||"video"}/>;
  if (kind === "audio") return <PlayableMedia kind="audio" src={src} filename={filename||"audio"}/>;
  const ext = (filename.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "").toUpperCase();
  return <a className="message-document" href={src} target="_blank" rel="noreferrer" download={filename}>
    <span className="message-document-icon" aria-hidden="true">{ext || "▧"}</span>
    <span className="message-document-info"><b>{filename}</b><small>{ext ? `${ext} document` : "Document"} · Tap to open</small></span>
    <span className="message-document-download" aria-hidden="true">⇩</span>
  </a>;
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
  
  // Merge: use the provider-supplied preview as base, enhance with fetched OG data
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
  // Instagram's own og:image links carry a short-lived signed expiry, unlike
  // the page URL — so route through the page URL and let the server resolve
  // (and, if needed, re-scrape) a currently-valid image link server-side,
  // rather than handing it a CDN link that may already be stale.
  const image = /^data:image\//i.test(String(imageUrl || "")) ? imageUrl : imageUrl ? (instagram ? `/api/app/instagram-image?url=${encodeURIComponent(url)}` : `/api/app/link-image?url=${encodeURIComponent(imageUrl)}`) : null;
  const previewImage = image && <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => {
    const imageNode=event.currentTarget;
    if (!instagram && !imageNode.dataset.directFallback && imageUrl) { imageNode.dataset.directFallback="true"; imageNode.src=imageUrl; return; }
    imageNode.style.display="none";
  }} />;
  // Instagram: image on top, post info (label/title/description/open link)
  // below it, same card — this whole card renders above the message text
  // (see MessageCard). Keep the full info block even without an image, so
  // the card doesn't jump between a tiny fallback and a tall image card.
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
function messageBody(text, mentions) {
  const ownNames=(mentions||[]).filter(mention=>mention.isMe&&mention.name).map(mention=>String(mention.name));
  if(!ownNames.length)return text;
  const pattern=new RegExp(`@(${ownNames.map(name=>name.replace(/[.*+?^${}()|[\\]\\]/g,"\\$&")).join("|")})(?=$|\\s|[.,!?])`,`gi`);
  const parts=String(text).split(pattern);
  return parts.map((part,index)=>index%2?<mark key={index} className="own-mention">@{part}</mark>:part);
}
function MessageCard({ message, accountId, chatId, chatPicture, accountLabel, accountPicture, onMediaResolved, onReply, onReact, onDelete, reaction }) {
  const body = message?.body || message?.text || message?.caption || "";
  const previewUrl = message?.linkPreview?.url || String(body).match(/https?:\/\/[^\s]+/i)?.[0];
  const visibleBody = previewUrl ? String(body).replace(previewUrl, "").trim() : body;
  const isInstagramLink = (() => { if (!previewUrl) return false; try { return /instagram\.com$/i.test(new URL(previewUrl).hostname); } catch { return false; } })();
  const [showReactions, setShowReactions] = useState(false);
  const label = message?.replyTo?.body || (message?.replyTo?.hasMedia ? "Media attachment" : "Message");
  const bubble = <article className={`message ${message.fromMe ? "mine" : ""}${message.pending ? " pending" : ""}${message.mentions?.some(mention=>mention.isMe)?" mentioned-me":""}`}>
    {!message.fromMe && message.sender && <Sender sender={{...message.sender,picture:message.sender.picture||chatPicture}} />}
    {message.fromMe && <Sender sender={{id:accountId,name:accountLabel||"You",picture:accountPicture}} />}
    {message?.replyTo && <div className="reply-context"><b>Replying to</b><span>{String(label).slice(0,140)}</span></div>}
    <MediaCard message={message} accountId={accountId} chatId={chatId} onResolved={onMediaResolved} />
    {isInstagramLink && <LinkPreview body={body} preview={message?.linkPreview} />}
    {visibleBody && <span className="message-body">{messageBody(visibleBody,message.mentions)}</span>}
    {!isInstagramLink && <LinkPreview body={body} preview={message?.linkPreview} />}
    {!visibleBody && !previewUrl && !message?.hasMedia && !message?.media && !message?.mediaUrl && <span className={`message-body system-message ${message?.system?.kind || ""}`}>{message?.system?.label || "Message unavailable"}</span>}
    {reaction && <span className="reaction-pill">{reaction}</span>}
    <time>{stamp(message) ? new Date(stamp(message) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</time>
  </article>;
  // Buttons live outside the bubble now (a hover toolbar, not part of the
  // message content) — on the inner side of the bubble (left for "mine",
  // right for everyone else's), so they never sit past the bubble's own
  // edge into open space.
  const actions = !message.pending && <div className="message-actions">
    {!message.fromMe && <button type="button" onClick={()=>onReply?.(message)}>Reply</button>}
    {!message.fromMe && <button type="button" onClick={()=>setShowReactions(value=>!value)}>React</button>}
    {!message.fromMe && showReactions && <span className="reaction-picker">{["👍","❤️","😂","😮","😢","🙏"].map(emoji=><button key={emoji} type="button" onClick={()=>{onReact?.(message,emoji);setShowReactions(false)}}>{emoji}</button>)}</span>}
    <button type="button" className="message-delete" onClick={()=>onDelete?.(message)} aria-label={message.fromMe ? "Delete this message for everyone" : "Delete this message for you"}>Delete</button>
  </div>;
  return <div className={`message-group ${message.fromMe ? "mine" : ""}`}>
    {message.fromMe ? <>{actions}{bubble}</> : <>{bubble}{actions}</>}
  </div>;
}

export function ChatPanel({ accountId, accountLabel, accountPicture, chat, onBack, onSent, onDeleted }) {
  const paneRef = useRef(null);
  const requestRef = useRef(0);
  const initialChatRef = useRef(null);
  const restoreAnchorRef = useRef(null);
  const historyRestoreRef = useRef(null);
  const olderRequestRef = useRef(false);
  const followLatestRef = useRef(false);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [reactionOverrides, setReactionOverrides] = useState({});
  const [remoteTyping, setRemoteTyping] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const typingSocketRef = useRef(null);
  const typingTimerRef = useRef(null);
  const chatId = chat?.id;
  const sendPresence = useCallback(presence => { const socket=typingSocketRef.current; if(socket?.readyState===1)socket.send(JSON.stringify({type:"presence",accountId,chatId,presence})); },[accountId,chatId]);
  useEffect(()=>{
    setRemoteTyping(false); if(!accountId||!chatId)return undefined;
    const protocol=window.location.protocol==="https:"?"wss":"ws";
    const url=`${protocol}://${window.location.host}/api/app/ws?accountId=${encodeURIComponent(accountId)}&chatId=${encodeURIComponent(chatId)}`;
    let stopped=false, reconnectTimer=null, attempt=0;
    // Typing/presence had no reconnect at all: once the socket dropped
    // (server restart, network blip, idle timeout), it silently stopped
    // working for the rest of the chat session. Reconnect with capped
    // exponential backoff, reset once a connection actually succeeds.
    const connect=()=>{
      const socket=new WebSocket(url);
      typingSocketRef.current=socket;
      socket.onopen=()=>{attempt=0};
      socket.onmessage=event=>{try{const value=JSON.parse(event.data);if(value.type==="presence")setRemoteTyping(value.presence==="typing"||value.presence==="recording")}catch{}};
      socket.onclose=()=>{
        if(typingSocketRef.current===socket)typingSocketRef.current=null;
        setRemoteTyping(false);
        if(stopped)return;
        const delay=Math.min(1000*2**attempt,15000);
        attempt+=1;
        reconnectTimer=window.setTimeout(connect,delay);
      };
    };
    connect();
    return()=>{
      stopped=true;
      if(reconnectTimer)window.clearTimeout(reconnectTimer);
      if(typingSocketRef.current){typingSocketRef.current.onclose=null;typingSocketRef.current.close();typingSocketRef.current=null}
      setRemoteTyping(false);
    };
  },[accountId,chatId]);

  const isNearBottom = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return true;
    return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  }, []);

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
    setMessages([]); setExhausted(false); setError(""); setReplyingTo(null); setReactionOverrides({}); setNewMessageCount(0); setLoading(Boolean(chatId));
    if (!accountId || !chatId) return undefined;
    api(endpoint(accountId, chatId)).then(result => {
      if (requestRef.current !== version) return;
      const page = pageOf(result).sort((a, b) => stamp(a) - stamp(b));
      setMessages(page); setExhausted(page.length < PAGE_SIZE);
    }).catch(cause => {
      if (requestRef.current === version) setError(cause.message || "Could not load messages.");
    }).finally(() => {
      if (requestRef.current === version) setLoading(false);
    });
    return () => { if (requestRef.current === version) requestRef.current += 1; };
  }, [accountId, chatId]);

  // Keep the active conversation live without fanning requests out across the
  // inbox. A reader already at the bottom should see new messages appear
  // there automatically (WhatsApp-style); a reader scrolled up into history
  // should not be yanked away from it — instead surface a "jump to latest"
  // affordance and let them decide when to come back down.
  useEffect(() => {
    if (!accountId || !chatId) return undefined;
    let active = true;
    const refreshLatest = async () => {
      try {
        const page = pageOf(await api(endpoint(accountId, chatId)));
        if (!active || !page.length) return;
        // Never let a background poll fight an in-flight older-history fetch
        // over scroll position; the next tick picks up the same messages.
        if (olderRequestRef.current) return;
        const known = new Set(messagesRef.current.map((message, index) => idFor(message, index)));
        const newCount = page.reduce((count, message, index) => count + (known.has(idFor(message, index)) ? 0 : 1), 0);
        if (!newCount) return;
        if (isNearBottom()) followLatestRef.current = true;
        else setNewMessageCount(count => count + newCount);
        setMessages(current => merge(current, page));
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
    const oldest = messagesRef.current[0];
    const before = oldest ? stamp(oldest) : 0;
    if (!before) return; // nothing loaded yet to page before
    olderRequestRef.current = true;
    const version = requestRef.current;
    const pane = paneRef.current;
    if (pane) historyRestoreRef.current = { top: pane.scrollTop, height: pane.scrollHeight };
    setOlderLoading(true); setError("");
    try {
      const page = pageOf(await api(endpoint(accountId, chatId, before)));
      if (requestRef.current !== version) return;
      setMessages(current => merge(current, page));
      setExhausted(page.length < PAGE_SIZE);
    } catch (cause) {
      if (requestRef.current === version) { historyRestoreRef.current = null; setError(cause.message || "Could not load earlier messages."); }
    } finally {
      olderRequestRef.current = false;
      if (requestRef.current === version) setOlderLoading(false);
    }
  }, [accountId, chatId, exhausted, olderLoading]);

  const maybeLoadOlder = useCallback(event => {
    if (event.currentTarget.scrollTop <= 120) loadOlder();
    if (isNearBottom()) setNewMessageCount(0);
  }, [loadOlder, isNearBottom]);

  const jumpToLatest = useCallback(() => {
    setNewMessageCount(0);
    const pane = paneRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, []);

  const send = useCallback(async event => {
    event.preventDefault();
    const field = event.currentTarget.elements.text;
    const text = field?.value?.trim();
    if (!text || !chatId) return;
    if(typingTimerRef.current)clearTimeout(typingTimerRef.current); sendPresence("paused");
    field.value = "";
    const pending = { id: `pending-${Date.now()}`, body: text, fromMe: true, timestamp: Math.floor(Date.now() / 1000), pending: true, replyTo:replyingTo };
    followLatestRef.current = true;
    setNewMessageCount(0);
    setMessages(current => [...current, pending]);
    try {
      const result = await api(`/api/app/accounts/${encodeURIComponent(accountId)}/messages`, { method: "POST", body: JSON.stringify({ chatId, text, replyTo:replyingTo?.id }) });
      const confirmed = confirmSentMessage(pending, result.message);
      setMessages(current => merge(current.filter(message => message.id !== pending.id), confirmed ? [confirmed] : []));
      setReplyingTo(null);
      onSent?.(result.message, chat);
    } catch (cause) {
      setMessages(current => current.filter(message => message.id !== pending.id));
      if (field) field.value = nextComposerValue(field.value, text);
      setError(cause.message || "Could not send message.");
    }
  }, [accountId, chat, chatId, onSent, replyingTo, sendPresence]);

  const reactToMessage = useCallback(async (message, emoji) => {
    const messageId=serializedId(message?.id);if(!messageId)return;
    const previous=reactionOverrides[messageId]||"",next=previous===emoji?"":emoji;
    setReactionOverrides(current=>({...current,[messageId]:next}));
    try{await api(`/api/app/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}/reaction`,{method:"POST",body:JSON.stringify({reaction:next})});}
    catch(cause){setReactionOverrides(current=>({...current,[messageId]:previous}));setError(cause.message||"Could not update reaction.");}
  },[accountId,reactionOverrides]);
  const handleComposerInput=useCallback(event=>{const active=Boolean(event.currentTarget.value.trim());sendPresence(active?"typing":"paused");if(typingTimerRef.current)clearTimeout(typingTimerRef.current);if(active)typingTimerRef.current=setTimeout(()=>sendPresence("paused"),1800)},[sendPresence]);

  // "Delete for me": removes the message from this account's own view. Does
  // not remove it from the other participant's WhatsApp — WhatsApp's real
  // "delete for everyone" only applies to messages you sent and within a
  // time window, which this deliberately does not attempt.
  const deleteMessage = useCallback(async (message) => {
    const messageId = serializedId(message?.id); if (!messageId || !chatId) return;
    // The delete request always asks for a real WhatsApp "delete for
    // everyone" — it only silently falls back to a local-only removal when
    // WhatsApp's own server rejects revoking someone else's message, which
    // Gakai has no control over either way. So for a message the account
    // itself sent, this confirmation must say what will actually happen: it
    // disappears from the whole chat, not just this view.
    const prompt = message?.fromMe
      ? "Delete this message for everyone in the chat? This can't be undone."
      : "Delete this message for you? It won't be removed from the other person's WhatsApp.";
    if (!window.confirm(prompt)) return;
    try {
      await api(`/api/app/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
      setMessages(current => current.filter(item => serializedId(item?.id) !== messageId));
    } catch (cause) {
      setError(cause.message || "Could not delete this message.");
    }
  }, [accountId, chatId]);

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
      {loading && !messages.length ? <p className="chat-loading loading-hint" role="status"><span className="spinner" aria-hidden="true"/>Loading messages…</p> : <div className="message-list">
        {messages.map((message,index) => <div key={idFor(message,index)} data-message-key={idFor(message,index)} className={`message-row ${message.fromMe ? "mine" : ""}`}><MessageCard message={message} accountId={accountId} chatId={chatId} chatPicture={!/@g\.us$/i.test(chatId||"")?chat?.picture:null} accountLabel={accountLabel} accountPicture={accountPicture} onMediaResolved={resolveMedia} onReply={setReplyingTo} onReact={reactToMessage} onDelete={deleteMessage} reaction={reactionOverrides[serializedId(message.id)] ?? message.reaction}/></div>)}
      </div>}
      {newMessageCount > 0 && <button type="button" className="jump-to-latest" onClick={jumpToLatest} aria-label={`Jump to ${newMessageCount} new message${newMessageCount > 1 ? "s" : ""}`}>↓ {newMessageCount} new message{newMessageCount > 1 ? "s" : ""}</button>}
    </div>
    {remoteTyping&&<div className="typing-indicator" role="status">Typing…</div>}
    <form className="composer" onSubmit={send}>
      {replyingTo&&<div className="composer-reply"><span><b>Replying to</b>{String(replyingTo.body||replyingTo.text||"Message").slice(0,100)}</span><button type="button" onClick={()=>setReplyingTo(null)} aria-label="Cancel reply">×</button></div>}
      <textarea
        name="text"
        rows="1"
        placeholder="Type a message"
        aria-label="Message"
        onInput={handleComposerInput}
        onBlur={()=>{if(typingTimerRef.current)clearTimeout(typingTimerRef.current);sendPresence("paused")}}
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
