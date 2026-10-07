import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createProviderClient } from './src/providers/index.mjs';
import { WebSocketServer } from 'ws';
import { chatTimestamp, extractMentionIds, hasMessageContent, mentionsIdentity, resolveMentionLabels, bareJidUser, isGroupChatId, isLidJid, isSameIdentity } from './src/domain/message.mjs';
import { fetchPinned, validatePublicUrl } from './src/lib/safe-fetch.mjs';
import { createBoundedCache } from './src/lib/lru-cache.mjs';
import { decodeHtmlEntities } from './src/lib/html.mjs';
import { isRecoverableStreamError } from './src/lib/process-guard.mjs';
import { normalizeEmail, loginNamesAdmin } from './src/domain/admin-identity.mjs';
import { callingCodeOf } from './src/domain/phone.mjs';
import { clampPageSize } from './src/domain/conversation-list.mjs';
import { MAX_TOKENS_PER_ACCOUNT, isCopyable, newToken, pruneExpiredTokens, publicToken, sendTarget, tokenLast4, validMessageText, validateScopes, validateTokenRequest } from './src/domain/api-tokens.mjs';
import { normalizeReplyRules, shouldAiReply, isChatListed, setChatListed, voiceIdFor } from './src/domain/ai-reply-rules.mjs';
import { conversationContext, conversationTurns, MAX_TURNS } from './src/domain/reply-context.mjs';
import { MAX_VOICES_PER_ACCOUNT, TEMPLATES as VOICE_TEMPLATES, compileVoicePrompt, parseVoiceYaml } from './src/domain/voice-profile.mjs';
import { searchPeople, searchGroups, resolveRuleLabels } from './src/domain/reply-targets.mjs';
import { AI_PROVIDER_IDS, FIXED_BASE_URLS, usesFixedBaseUrl, listModels as listAiModels, complete as aiComplete } from './src/lib/ai-provider.mjs';

const port = Number(process.env.PORT || 3000);
// Encrypts secrets we must read back later (e.g. an application token, so it can be copied back out for a day).
const stateSecretKey=createHash('sha256').update(process.env.GAKAI_STATE_SECRET || 'gakai-dev-secret').digest();
function encryptSecret(value){
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',stateSecretKey,iv);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}
function decryptSecret(value){
  const [ivHex,tagHex,dataHex]=String(value||'').split(':');
  if(!ivHex||!tagHex||!dataHex)return null;
  try{
    const decipher=createDecipheriv('aes-256-gcm',stateSecretKey,Buffer.from(ivHex,'hex'));
    decipher.setAuthTag(Buffer.from(tagHex,'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex,'hex')),decipher.final()]).toString('utf8');
  }catch{return null}
}
const publicDir = join(process.cwd(), "public");
const dataDir=process.env.HOME_DATA_DIR || join(process.cwd(),"data");
const dataFile=join(dataDir,"home.json");
const dbFile=join(dataDir,"gakai.db");
const sessionsDir=process.env.GAKAI_SESSIONS_DIR || join(process.cwd(),"sessions");
const mediaCacheDir=join(dataDir,"media-cache");
await mkdir(dataDir,{recursive:true});
await mkdir(sessionsDir,{recursive:true});
const db=new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS app_events_account_created ON app_events(account_id, created_at);");
// handleProviderEvent is defined further down (it needs dispatchAutomationEvent
// and broadcastTyping, declared later) but referenced here — safe, since
// `function` declarations are hoisted and this callback only ever runs later,
// asynchronously, off a live WhatsApp event.
const provider = createProviderClient({
  kind: process.env.GAKAI_PROVIDER_KIND || 'baileys',
  db, sessionsDir, mediaCacheDir,
  logLevel: process.env.GAKAI_LOG_LEVEL,
  onEvent: (kind, payload) => handleProviderEvent(kind, payload),
});
let legacy={username:null,password:null,keys:[]};try{legacy=JSON.parse(await readFile(dataFile,"utf8"))}catch{}
const savedState=db.prepare("SELECT data FROM app_state WHERE id=1").get();
let store=savedState?JSON.parse(savedState.data):legacy;
const persist=()=>{db.prepare("INSERT INTO app_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(store));};
if(!store.accountLabels||typeof store.accountLabels!=='object'||Array.isArray(store.accountLabels))store.accountLabels={};
if(!Array.isArray(store.automationSubscriptions))store.automationSubscriptions=[];
// n8n support was removed: drop what it stored (its connections, its managed webhook subscriptions and its
// internal token). Webhook subscriptions the user added themselves are untouched.
{const n8nNames=new Set(['n8n auto-connect','n8n auto-connect (AI Agent)','n8n integration']);
 const before=[store.automationSubscriptions?.length||0,store.keys?.length||0];
 delete store.n8nConnections;
 store.automationSubscriptions=store.automationSubscriptions.filter(item=>!n8nNames.has(item.name));
 if(!Array.isArray(store.keys))store.keys=[];
 store.keys=store.keys.filter(item=>!n8nNames.has(item.name));
 if(before[0]!==store.automationSubscriptions.length||before[1]!==store.keys.length)persist();}
if(!Array.isArray(store.llmConfigs))store.llmConfigs=[];
if(!Array.isArray(store.voiceProfiles))store.voiceProfiles=[];
if(!store.preferences||typeof store.preferences!=='object'||Array.isArray(store.preferences))store.preferences={};
// An application token can be copied back out for 24 hours after it is made; after that
// the stored (encrypted) copy is deleted for good and only its one-way hash remains.
function pruneTokenSecrets(){if(pruneExpiredTokens(store.keys))persist();}
pruneTokenSecrets();
setInterval(pruneTokenSecrets,60*60*1000).unref();
if(!savedState&&(legacy.username||legacy.password||legacy.keys?.length||legacy.automationSubscriptions?.length||legacy.deletingAccounts?.length))persist();
const legacyAdminUsername=process.env.GAKAI_LEGACY_ADMIN_USERNAME || null;
if(!store.username&&store.password&&legacyAdminUsername){store.username=legacyAdminUsername;await persist();}
// token -> { issuedAt, remember }. TTL-checked in admin(), not just presence-
// checked, and cleared wholesale on a password change so a leaked token
// doesn't survive it.
const sessions=new Map();
const sessionTtlMs=Number(process.env.GAKAI_SESSION_TTL_MS)||24*60*60*1000;
const sessionRememberTtlMs=30*24*60*60*1000; // matches the cookie's own Max-Age=2592000 below
// A chat with no activity in this window doesn't belong in the inbox — the
// provider's chat list can include threads deleted directly on the phone
// (Gakai never hears about that) or otherwise gone stale; without a recency
// floor, the top-30 inbox pads itself out with whatever old chats exist
// once there aren't 30 genuinely active ones.
// Page size of the conversation list. There is no age cutoff: the list is the latest activity, newest first.
const inboxChatLimit=clampPageSize(process.env.GAKAI_INBOX_CHAT_LIMIT);
const instagramPreviewRetryMs=Number(process.env.GAKAI_INSTAGRAM_PREVIEW_RETRY_MS)||5*60*1000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const sessionCookie=(token,remember)=>`home_session=${token}; HttpOnly; SameSite=Strict; Path=/${remember?"; Max-Age=2592000":""}`;
const equalHex=(left,right)=>{try{const a=Buffer.from(left||"","hex"),b=Buffer.from(right||"","hex");return a.length===b.length&&timingSafeEqual(a,b)}catch{return false}};
const passwordHash=value=>{const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(value,salt,64).toString('hex')}`};
const passwordMatches=value=>{const [salt,expected]=store.password.split(':');return timingSafeEqual(Buffer.from(expected,'hex'),scryptSync(value,salt,64))};
const cookie=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
const issueSession=remember=>{const token=randomBytes(32).toString('hex');sessions.set(token,{issuedAt:Date.now(),remember:Boolean(remember)});return token};
const admin=req=>{
  const token=cookie(req).home_session;
  const session=sessions.get(token);
  if(!session)return false;
  if(Date.now()-session.issuedAt>(session.remember?sessionRememberTtlMs:sessionTtlMs)){sessions.delete(token);return false}
  return true;
};
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.webp':'image/webp', '.jpg':'image/jpeg' };
const send = (res, status, data, headers={}) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}); res.end(JSON.stringify(data)); };
async function readBody(req) { const chunks=[]; let size=0; for await (const chunk of req){size+=chunk.length;if(size>1024*1024)throw Object.assign(new Error('Request body too large'),{status:413});chunks.push(chunk);} req.rawBody=Buffer.concat(chunks).toString('utf8'); return req.rawBody ? JSON.parse(req.rawBody) : {}; }
// Raw binary body (media upload). Same streaming guard as readBody but no
// JSON.parse and a caller-set cap — media is far larger than a JSON payload.
async function readRawBody(req, maxBytes) { const chunks=[]; let size=0; for await (const chunk of req){size+=chunk.length;if(size>maxBytes)throw Object.assign(new Error('File is too large'),{status:413});chunks.push(chunk);} return Buffer.concat(chunks); }
const liveEventStreams = new Set();
const writeSseEvent = (res, event, id) => {
  res.write(`id: ${id || event.id}\nevent: gakai\ndata: ${JSON.stringify(event)}\n\n`);
};
function recordAppEvent(event) {
  const result = db.prepare('INSERT OR IGNORE INTO app_events(id, account_id, type, occurred_at, payload, created_at) VALUES(?,?,?,?,?,?)')
    .run(event.id, event.account.id, event.type, event.occurredAt, JSON.stringify(event), new Date().toISOString());
  if (!result.changes) return false;
  db.prepare("DELETE FROM app_events WHERE id IN (SELECT id FROM app_events ORDER BY created_at DESC LIMIT -1 OFFSET 5000)").run();
  for (const stream of liveEventStreams) {
    if (stream.accountIds.has(event.account.id)) writeSseEvent(stream.res, event, event.id);
  }
  return true;
}
const typingSockets=new Set();
const socketOpen=socket=>socket.readyState===1;
function broadcastTyping(accountId,chatId,payload,except){for(const socket of typingSockets)if(socket!==except&&socket.accountId===accountId&&socket.chatId===chatId&&socketOpen(socket))socket.send(JSON.stringify(payload));}
// Baileys' own presence.update events (see handleProviderEvent below) fully
// replace the old 2-second REST poll here — a real reliability and
// efficiency win, not just parity: presence now reaches the browser the
// moment WhatsApp reports it, with zero standing per-chat poll loop.
const WA_PRESENCE_TO_GAKAI={composing:'typing',recording:'recording'};
function gakaiPresenceFrom(presences){
  const first=Object.values(presences||{})[0];
  return WA_PRESENCE_TO_GAKAI[first?.lastKnownPresence]||'paused';
}
// dispatchAutomationEvent and provider.setReaction/... below already keep
// local state authoritative; this just fans a live provider event out to any
// open browser WebSocket for that chat, and (for messages) into the same
// automation pipeline a webhook used to feed.
// Tell every open browser (not the durable event log) that a conversation's unread count changed
// somewhere else — another tab, or another WhatsApp device — so lists and badges follow.
function broadcastChatRead(accountId,chatId,unreadCount){
  const event={type:'chat.read',account:{id:accountId},chat:{id:chatId},unreadCount,occurredAt:new Date().toISOString()};
  for(const stream of liveEventStreams)if(stream.accountIds.has(accountId))stream.res.write(`event: gakai\ndata: ${JSON.stringify(event)}\n\n`);
}
function handleProviderEvent(kind,payload){
  if(kind==='read'){broadcastChatRead(payload.accountId,payload.chatId,payload.unreadCount);return;}
  if(kind==='message'){
    dispatchAutomationEvent(payload).catch(error=>console.error('Automation dispatch failed',error));
    return;
  }
  if(kind==='presence'){
    broadcastTyping(payload.accountId,payload.chatId,{type:'presence',accountId:payload.accountId,chatId:payload.chatId,presence:gakaiPresenceFrom(payload.presences)});
  }
}
const instagramPreviewCache=createBoundedCache({limit:40});
// A bare `/instagram\.com$/` suffix match also accepts a CDN image host
// like cdninstagram.com (it ends with "instagram.com" too) — require a real
// hostname boundary, same as safeInstagramImage below, so a raw CDN image
// URL sent to this endpoint by mistake (e.g. a stale cached client bundle)
// is rejected outright instead of being fetched-and-misread as an HTML page.
const safeInstagramPage=value=>{try{const url=new URL(value);return url.protocol==='https:'&&/(^|\.)instagram\.com$/i.test(url.hostname)?url:null}catch{return null}};
const safeInstagramImage=value=>{try{const url=new URL(value);return url.protocol==='https:'&&/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)?url:null}catch{return null}};
const htmlMeta=(html,key)=>{
  const patterns=[
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`,'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`,'i'),
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`,'i'),
  ];
  for(const re of patterns){const m=html.match(re);if(m?.[1])return decodeHtmlEntities(m[1]);}
  return null;
};

function extractJSONLD(html){
  const m=html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!m)return null;
  try{return JSON.parse(m[1])}catch{return null}
}

async function instagramPreview(value,{force=false}={}){
  const url=safeInstagramPage(value);if(!url)throw Object.assign(new Error('Invalid Instagram URL'),{status:400});
  if(!force){const cached=instagramPreviewCache.get(url.href);if(cached)return cached;}
  const ua='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  let html='',fetchFailed=false;
  try{
    const response=await fetch(url,{headers:{'user-agent':ua,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','accept-language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(10000)});
    if(response.ok)html=await response.text();
    else fetchFailed=true;
  }catch(error){
    // Keep the graceful empty-preview UX (a chat bubble shouldn't break over
    // a failed preview fetch) but make the failure visible in logs — this
    // used to fail silently, unlike the near-identical openGraphPreview path.
    console.error('Instagram preview fetch failed:',error.message);
    fetchFailed=true;
  }
  
  let title=htmlMeta(html,'og:title')||htmlMeta(html,'twitter:title');
  let description=htmlMeta(html,'og:description')||htmlMeta(html,'twitter:description')||htmlMeta(html,'description');
  let image=htmlMeta(html,'og:image')||htmlMeta(html,'twitter:image')||htmlMeta(html,'og:image:secure_url');
  
  // Fallback to JSON-LD
  if(!title||!description||!image){
    const ld=extractJSONLD(html);
    if(ld){
      const graph=Array.isArray(ld['@graph'])?ld['@graph']:[ld];
      for(const item of graph){
        if(['SocialMediaPosting','VideoObject','Article','ProfilePage','MediaObject'].includes(item['@type'])){
          title=title||item.name||item.headline||item.alternateName;
          description=description||item.description||item.caption||item.articleBody;
          image=image||item.image?.url||item.image?.contentUrl||(typeof item.image==='string'?item.image:null);
        }
      }
    }
  }
  
  // Resolve relative image URLs
  if(image&&!image.startsWith('http')){
    try{image=new URL(image,url.href).href}catch{image=null}
  }
  
  // Strip " on Instagram" suffix
  if(title)title=title.replace(/\s*on\s+Instagram\s*$/i,'').replace(/\s*[|\-]\s*Instagram\s*$/i,'').trim();
  if(!title)title=null;
  if(!description)description=null;
  
  const result={title,description,image:safeInstagramImage(image)?.href||null};
  // A failed fetch (network blip, momentary block/rate-limit) was being
  // cached as a permanent empty preview with no expiry — the exact fetch
  // that failed once would never be retried again for that post. Retry soon
  // instead; only cache long-lived once we actually got a real response.
  instagramPreviewCache.set(url.href,result,fetchFailed?{ttlMs:instagramPreviewRetryMs}:undefined);
  return result;
}
const externalPreviewCache=createBoundedCache({limit:80});
const safePublicUrl=async value=>(await validatePublicUrl(value))?.url||null;
const httpsWebhookUrl=async value=>(await validatePublicUrl(value,{requireHttps:true}))?.url||null;
async function openGraphPreview(value){
  const validated=await validatePublicUrl(value);if(!validated)throw Object.assign(new Error("Invalid public URL"),{status:400});
  const url=validated.url;
  const cached=externalPreviewCache.get(url.href);if(cached)return cached;
  const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const response=await fetchPinned(value,{headers:{'user-agent':ua,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Object.assign(new Error("Link preview unavailable"),{status:502});
  const html=(await response.text()).slice(0,1024*1024);

  let title=htmlMeta(html,'og:title')||htmlMeta(html,'twitter:title');
  let description=htmlMeta(html,'og:description')||htmlMeta(html,'twitter:description')||htmlMeta(html,'description');
  let image=htmlMeta(html,'og:image')||htmlMeta(html,'twitter:image')||htmlMeta(html,'og:image:secure_url');

  if(image&&!image.startsWith('http')){
    try{image=new URL(image,url.href).href}catch{image=null}
  }

  // Expose a plain string in the Gakai preview model. Passing a URL object
  // across the JSON boundary was inconsistent between consumers and left the
  // React renderer without a usable image source.
  const safeImage=image?await safePublicUrl(image):null;
  const result={title,description,image:safeImage?.href||null};
  externalPreviewCache.set(url.href,result);
  return result;
}
// s: the provider's own account snapshot ({id,status,phone,profile,ownJid}) —
// already in Gakai's status vocabulary (WORKING/SCAN_QR_CODE/STARTING/
// FAILED), with no provider-specific session/config object to unwrap.
function account(s) { return { id:s.id, label:store.accountLabels[s.id] || s.profile || s.id, status:s.status, phone:s.phone, profile:s.profile }; }
async function accountView(s){
  const view=account(s);
  if(!s.ownJid)return view;
  try{
    const self=await provider.getContact(s.id,s.ownJid);
    view.picture=self.picture||null;
    view.mentionNames=[view.label,view.profile,self.name,view.phone].filter(Boolean);
  }catch{view.picture=null;view.mentionNames=[view.label,view.profile,view.phone].filter(Boolean)}
  // Drives the sidebar's per-account unread dot — every account needs this,
  // not just whichever one is open, so it's computed here rather than only
  // in the /chats route. hasMessageContent() guards against a metadata-only
  // chat touch lighting up the dot for a chat with no real message behind it.
  try{
    const chats=await provider.getChatsOverview(s.id);
    view.hasUnread=chats.some(chat=>hasMessageContent(chat)&&(Number(chat.unreadCount)||0)>0);
  }catch{view.hasUnread=false}
  return view;
}
// The inbox list's "last message" preview can contain an unresolved
// @<number> mention — resolve it the same way a full message body does.
async function enrichChatOverview(session,view,{pictures=true}={}){
  // Baileys never delivers a picture on a chat-sync event (unlike the old
  // provider, which resolved and attached one itself) — the only way to get
  // one is a live per-jid profilePictureUrl() lookup, same call whether the
  // chat is a 1:1 contact or a group. resolveContact() already does that
  // fetch-and-cache for message-sender avatars; reuse it here. `pictures:false`
  // is the inbox's first paint: use a cached picture if the store already has
  // one, but never make the live call — the list text must not wait on it.
  if(!view.picture&&view.id){const contact=await resolveContact(session,view.id,pictures?undefined:{namesOnly:true});if(contact.picture)view={...view,picture:contact.picture}}
  if(view.lastMessage){
    const mentionIds=extractMentionIds(view.lastMessage.body,view.lastMessage.text);
    if(mentionIds.length){
      const contacts=await Promise.all(mentionIds.map(async id=>[id,await resolveContactByNumber(session,id,[],{namesOnly:true})]));
      const labels=new Map(contacts.map(([id,contact])=>[id,contact?.name]).filter(([,label])=>label));
      view={...view,lastMessage:{...view.lastMessage,body:resolveMentionLabels(view.lastMessage.body,labels),text:resolveMentionLabels(view.lastMessage.text,labels)}};
    }
  }
  // Whether the AI answers this conversation (it is on the reply list), and
  // whether AI replies are switched on at all — so the chat menu can say
  // "on, but paused in Settings" instead of implying replies will go out.
  const aiConfig=llmConfig(session);
  return {...view,aiReply:isChatListed(aiConfig?.replyRules,{chatId:view.id,phone:chatAiPhone(session,view.id)}),aiActive:Boolean(aiConfig?.nativeEnabled)};
}
// The phone number identifying a direct chat's contact (digits), or null when
// it cannot be told (a group, or a LID chat Gakai has not mapped to a number).
function chatAiPhone(accountId,chatId){
  if(isGroupChatId(chatId))return null;
  const resolved=isLidJid(chatId)?provider.resolveLid(accountId,chatId):chatId;
  return String(resolved||'').endsWith('@s.whatsapp.net')?bareJidUser(resolved):null;
}
// Mentions are extracted from message text as bare digit runs (@<number>),
// but Baileys keys contacts/pictures by full JID — resolve by matching the
// digits against the message's own contextInfo.mentionedJid list where
// possible; falling back to a bare-number WhatsApp jid otherwise.
async function resolveContactByNumber(session,number,mentionedJids=[],opts){
  const jid=mentionedJids.find(candidate=>bareJidUser(candidate).replace(/^0+/,'')===number.replace(/^0+/,''))||`${number}@s.whatsapp.net`;
  return resolveContact(session,jid,opts);
}
async function resolveContact(session,rawId,opts){
  let contactId=String(rawId||'');
  if(isLidJid(contactId))contactId=provider.resolveLid(session,contactId);
  return provider.getContact(session,contactId,opts);
}
// A chat/contact picture that isn't already cached costs a live WhatsApp
// request (see enrichChatOverview) — cap how many of those run at once so a
// fresh inbox full of uncached avatars doesn't fire dozens simultaneously.
async function mapWithConcurrency(values,limit,worker){const result=new Array(values.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{while(next<values.length){const index=next++;result[index]=await worker(values[index])}}));return result}
const automationSummary=subscription=>({id:subscription.id,accountId:subscription.accountId,name:subscription.name,url:subscription.url,productionUrl:subscription.productionUrl||subscription.url,testUrl:subscription.testUrl||null,testPhone:subscription.testPhone||null,enabled:subscription.enabled,events:subscription.events,secret:subscription.secret,createdAt:subscription.createdAt,lastDelivery:subscription.lastDelivery||null});
async function automationFetch(subscription,event,{url:overrideUrl}={}){
  const targetUrl=overrideUrl||subscription.url;
  // 45s, not automationFetch's old 10s: a workflow that responds
  // synchronously with a reply (see deliverAutomation) holds this same
  // connection open through however long its own logic — an LLM call in
  // particular — takes to finish.
  const request=url=>fetchPinned(url,{requireHttps:true,method:'POST',headers:{'content-type':'application/json','x-gakai-secret':subscription.secret,'x-gakai-event-id':event.id,'user-agent':'Gakai/1.0'},body:JSON.stringify(event),signal:AbortSignal.timeout(45000)});
  let response=await request(targetUrl);
  if(!response.ok&&event.source==='test'&&response.status===404&&targetUrl.includes('/webhook/'))response=await request(targetUrl.replace('/webhook/','/webhook-test/'));
  return response;
}
// If the automation responded synchronously with a reply, send it back
// through WhatsApp the same way a native LLM reply does. This is what lets
// an automation webhook generate a reply without ever calling back into Gakai's own
// API — Gakai already made this request and is the only side that needs to
// know how to reach the WhatsApp provider.
// Returns the reply text that was sent (or null if there was nothing to
// send) so callers — in particular the "Send test message" endpoint — can
// show the caller what the automation actually produced, not just whether
// the webhook call succeeded.
async function sendAutomationReply(response,accountId,chatId){
  let reply='';
  try{const data=await response.json();reply=String(data?.reply||data?.text||data?.output||'').trim();}catch{return null;}
  if(!reply)return null;
  if(!chatId)return reply;
  try{await provider.sendText(accountId,chatId,reply);}
  catch(error){console.error('Failed to send automation reply:',error.message);}
  return reply;
}
// A receiver's own JSON error body (`hint`/`message`) usually says what is wrong, so surface that
// instead of a bare, confusing status code.
async function describeWebhookFailure(response){
  let detail='';
  try{const body=await response.json();detail=String(body?.hint||body?.message||'').trim();}catch{}
  if(response.status===404)return detail?`This webhook isn't reachable: ${detail}`:"The webhook URL was not found (404). Check the URL and that the receiving workflow is active, then try again.";
  return detail?`Webhook returned ${response.status}: ${detail}`:`Webhook returned ${response.status}`;
}
async function deliverAutomation(subscription,event,options={}){
  const started=Date.now();
  try{
    const response=await automationFetch(subscription,event,options);
    subscription.lastDelivery={at:new Date().toISOString(),ok:response.ok,status:response.status,durationMs:Date.now()-started};
    if(!response.ok)throw new Error(await describeWebhookFailure(response));
    return await sendAutomationReply(response,subscription.accountId,event.chat?.id);
  }
  catch(error){subscription.lastDelivery={at:new Date().toISOString(),ok:false,error:error.message||"Delivery failed",durationMs:Date.now()-started};throw error}
  finally{await persist()}
}
// payload: {accountId, chatId, message /* already-normalized messageView() */, raw}
// as delivered by the provider's live 'message' event (see
// handleProviderEvent above) — the in-process replacement for what used to
// arrive as a signed webhook POST.
async function dispatchAutomationEvent(payload){
  const {accountId,chatId,message}=payload;
  if(!accountId||!chatId)return;
  const kind=isGroupChatId(chatId)?"group":"direct";
  // A message with no body, text, or media isn't real content (a metadata
  // touch, a call/group system event) — don't fire an AI reply or automation
  // for it either way.
  if(!message.body&&!message.text&&!message.hasMedia)return;
  const chat={id:chatId,kind,name:null};
  if(message.sender?.id){const contact=await resolveContact(accountId,message.sender.id);message.sender={...message.sender,phone:contact.phone||null,name:message.sender.name||contact.name||null};if(kind==="direct")chat.phone=contact.phone||null;}
  // Whether this account was explicitly @-tagged in a group. A direct message
  // is not a "mention" (the whole message is already for you) — the browser
  // uses this flag to raise a mention toast, so it must mean the narrow thing.
  const mentionsYou=kind==="group"&&Array.isArray(message.mentionedJids)&&message.mentionedJids.length
    ?mentionsIdentity(message.mentionedJids,provider.getAccount(accountId)?.ownJid,provider.getAccount(accountId)?.ownLid)
    :false;
  const event={id:`evt_${message.id}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id:accountId},chat,message,mentionsYou,source:"whatsapp"};
  // Persist before notifying the browser or downstream automation. This gives
  // reconnecting clients a small durable replay window and avoids exposing raw
  // provider payloads outside the adapter boundary.
  if (!recordAppEvent(event)) return;
  // AI replies are opt-in per sender: a listed phone number in a direct chat,
  // or a listed group where this account is @-tagged. Everything else is ignored.
  const directPhone=kind==='direct'?(chat.phone||(chatId.endsWith('@s.whatsapp.net')?bareJidUser(chatId):null)):null;
  const aiAllowed=shouldAiReply(llmConfig(accountId)?.replyRules,{chatId,phone:directPhone,isGroup:kind==='group',mentionsYou});
  const subscriptions=store.automationSubscriptions.filter(subscription=>subscription.accountId===accountId&&subscription.enabled&&subscription.events.includes(event.type));
  await Promise.allSettled([
    ...subscriptions.map(subscription=>deliverAutomation(subscription,event)),
    aiAllowed?dispatchLLMReply(accountId,event):Promise.resolve()
  ]);
}

function llmConfig(accountId){return store.llmConfigs.find(c=>c.accountId===accountId)||null;}
const llmProviders=new Set(AI_PROVIDER_IDS);
// Configs saved before providers existed say 'omniroute'; for sharing a saved key it is the same OpenAI-compatible proxy family as LiteLLM.
const aiFamily=value=>value==='omniroute'?'litellm':value;
function inferLlmProvider(baseUrl,requested){
  if(llmProviders.has(requested))return requested;
  try{const url=new URL(baseUrl);return /(^|\.)litellm\b/i.test(url.hostname)||url.port==='4000'?'litellm':'omniroute';}catch{return 'omniroute';}
}
function normalizeLlmBaseUrl(value,provider){
  const url=new URL(String(value||'').trim());
  // Accept either an OpenAI-compatible base URL or the complete Chat
  // Completions endpoint. Keep any proxy-specific path prefix and query
  // parameters (for example, a version selected by the proxy).
  url.hash='';
  url.pathname=url.pathname.replace(/\/+$/,'').replace(/\/chat\/completions$/i,'');
  // LiteLLM's OpenAI-compatible API is served under /v1.
  if(provider==='litellm'&&!/(^|\/)v1$/i.test(url.pathname))url.pathname=`${url.pathname}/v1`.replace(/\/\/+/g,'/');
  return url.href;
}
// Not editable: only used for someone who is listed but has no voice yet, so the AI is never left without rules.
const fallbackInstructions=`You are the WhatsApp assistant for this business.

Use a friendly, warm, professional tone. Keep replies concise and natural for WhatsApp. Answer customer questions, help with scheduling and next steps, and ask one clear follow-up question when information is missing.
Do not make up facts, prices, availability, or promises. If a request needs a human, say that you will pass it on. Reply with only the message text—no labels, markdown, or explanation.`;

// Native AI replies and the settings "test" button both go through the
// provider adapter, so ChatGPT, Claude, and a LiteLLM proxy behave the same.
// An admin-configured proxy is trusted input and may be on a private address;
// the adapter pins the resolved address either way.
function llmChat(config,messages){return aiComplete({...config,provider:config.provider||inferLlmProvider(config.baseUrl)},messages,{timeoutMs:30000});}
// The instructions for the voice profile picked for this conversation, or null when none is.
function voiceSystemPrompt(accountId,event){
  const isGroup=event.chat?.kind==='group',chatId=event.chat?.id;
  const phone=isGroup?null:(event.chat?.phone||(String(chatId||'').endsWith('@s.whatsapp.net')?bareJidUser(chatId):null));
  const voiceId=voiceIdFor(llmConfig(accountId)?.replyRules,{chatId,phone,isGroup});
  const voice=voiceId&&store.voiceProfiles.find(item=>item.id===voiceId&&item.accountId===accountId);
  const parsed=voice?parseVoiceYaml(voice.yaml):null;
  return parsed?.ok?compileVoicePrompt(parsed.profile,{chat:isGroup?'group':'direct'}):null;
}
// Forget a voice choice that points at a voice that no longer exists on this account.
function withKnownVoices(accountId,rules){
  const known=new Set(store.voiceProfiles.filter(item=>item.accountId===accountId).map(item=>item.id));
  const normalized=normalizeReplyRules(rules);
  if(!normalized.assignments)return normalized;
  const assignments=Object.fromEntries(Object.entries(normalized.assignments).filter(([,voiceId])=>known.has(voiceId)));
  const {assignments:_dropped,...rest}=normalized;
  return Object.keys(assignments).length?{...rest,assignments}:rest;
}
// The name of a group chat, for telling the AI which group it is in.
async function groupName(accountId,chatId){
  const contact=await provider.getContact(accountId,chatId,{namesOnly:true}).catch(()=>null);
  if(contact?.name)return contact.name;
  return (await provider.getChatsOverview(accountId).catch(()=>[])).find(item=>item.id===chatId)?.name||null;
}
// What the AI is told before it replies: the voice chosen for this conversation (Gakai's short built-in
// style when none is) plus who it is replying to. That context goes with every reply.
async function replyInstructions(accountId,event,{withHistory=false}={}){
  const isGroup=event.chat?.kind==='group',chatId=event.chat?.id;
  const phone=event.chat?.phone||(!isGroup&&String(chatId||'').endsWith('@s.whatsapp.net')?bareJidUser(chatId):null);
  const chat={kind:isGroup?'group':'direct',name:isGroup?await groupName(accountId,chatId):event.chat?.name,phone};
  return `${voiceSystemPrompt(accountId,event)||fallbackInstructions}\n\n${conversationContext({chat,sender:event.message?.sender||{},withHistory})}`;
}
// The recent conversation as chat turns, ending with the message being answered. If the history cannot
// be read the AI still gets that message.
async function replyTurns(accountId,event){
  const past=await provider.getMessages(accountId,event.chat.id,{limit:MAX_TURNS+4}).catch(()=>[]);
  return conversationTurns({messages:past,incoming:event.message,group:event.chat?.kind==='group'});
}
async function dispatchLLMReply(accountId,event){
  const config=llmConfig(accountId);if(!config||!config.nativeEnabled)return;
  // A photo, video, voice note or document with no caption is skipped: the AI cannot see or hear it, so any reply would be a guess.
  const chatId=event.chat?.id;const userText=event.message?.body||event.message?.text||'';if(!chatId||!userText)return;
  // The voice chosen for this person or group.
  const systemPrompt=await replyInstructions(accountId,event,{withHistory:true});
  try{
    const reply=await llmChat(config,[{role:'system',content:systemPrompt},...await replyTurns(accountId,event)]);
    if(!reply.trim())return;
    await provider.sendText(accountId,chatId,reply.trim());
  }catch(err){console.error('Native LLM reply failed:',err.message);}
}
// Rows the reply-list type-ahead searches: the account's conversations with
// their timestamps, plus its saved contacts.
const MAX_REPLY_EXCLUDE=400;
async function replyTargetSources(accountId){
  const overview=await provider.getChatsOverview(accountId);
  const chats=overview.map(chat=>({id:chat.id,name:chat.name||null,timestamp:chatTimestamp(chat)}));
  const contacts=(provider.getContacts(accountId)||[]).map(contact=>({id:contact.id||contact.contact_id||null,name:contact.name||null,phone:contact.phone||null}));
  return {chats,contacts};
}
// A saved rule list plus the display names its tags need.
async function replyRulesView(accountId,rules){
  const replyRules=normalizeReplyRules(rules);
  return {replyRules,replyLabels:resolveRuleLabels(replyRules,await replyTargetSources(accountId))};
}
// Issue a new application token for an account. One path for every route that creates one.
async function issueToken(accountId,input){
  const request=validateTokenRequest(input);
  if(request.error)return {status:400,body:{message:request.error}};
  if(store.keys.filter(k=>k.accountId===accountId).length>=MAX_TOKENS_PER_ACCOUNT)return {status:409,body:{message:`An account can have up to ${MAX_TOKENS_PER_ACCOUNT} tokens. Delete one you no longer use first.`}};
  const token=newToken();
  const key={id:randomBytes(8).toString("hex"),accountId,name:request.name,scopes:request.scopes,createdAt:new Date().toISOString(),lastUsedAt:null,rotatedAt:null,last4:tokenLast4(token),hash:hash(token),tokenEnc:encryptSecret(token)};
  store.keys.push(key);await persist();
  return {status:201,body:{key:publicToken(key),token}};
}
async function api(req, res, url) {
function normalizedPreviewImage(value){
  const source=value&&typeof value==='object'?(value.url||value.data||value.base64||null):value;
  if(!source)return null;
  const image=String(source).trim();
  if(/^https?:\/\//i.test(image)||/^data:image\//i.test(image))return image;
  return image.length>100&&/^[A-Za-z0-9+/=\s]+$/.test(image)?`data:image/jpeg;base64,${image.replace(/\s/g,'')}`:null;
}

  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, {ok:true, service:'gakai'});
  // The WhatsApp connection is in-process now — there is no separate
  // provider process whose reachability readiness needs to confirm.
  if (req.method === 'GET' && url.pathname === '/readyz') return send(res, 200, {ok:true, service:'gakai', provider:true});
async function enrichMessage(session,view){
  // namesOnly: never make a live profilePictureUrl() call while shaping a
  // message page — a group page has a sender (and often mentions) on every
  // row, and blocking each on a WhatsApp round-trip is what made opening a
  // chat slow. Sender avatars are hydrated afterwards (client -> /chats/pictures).
  if(view.sender?.id){
    const resolved=await resolveContact(session,view.sender.id,{namesOnly:true});
    view={...view,sender:{...view.sender,id:resolved.id||view.sender.id,name:resolved.name||view.sender.name||bareJidUser(resolved.id||view.sender.id),picture:resolved.picture||view.sender.picture||null}};
  }
  if(view.linkPreview)view={...view,linkPreview:{...view.linkPreview,image:normalizedPreviewImage(view.linkPreview.image)}};
  const rawMentionIds=Array.isArray(view.mentionedJids)?view.mentionedJids:[];
  if(rawMentionIds.length){
    const ownJid=provider.getAccount(session)?.ownJid||'';
    view={...view,mentions:(await Promise.all(rawMentionIds.slice(0,8).map(async rawId=>{const contact=await resolveContact(session,String(rawId),{namesOnly:true});const id=contact.id||String(rawId);return {id,name:contact.name||bareJidUser(id),isMe:isSameIdentity(id,ownJid)}}))).filter(mention=>mention.name)};
  }
  const body=String(view.body||view.text||'');
  // A mention inside the *quoted* text (replyTo.body) was never resolved —
  // only the main message body was — so "Replying to" previews kept showing
  // the raw @123456 id forever. Resolve both from one combined mention set.
  const replyBody=String(view.replyTo?.body||'');
  const mentionIds=extractMentionIds(body,replyBody);
  if(mentionIds.length){
    const contacts=await Promise.all(mentionIds.map(async id=>[id,await resolveContactByNumber(session,id,rawMentionIds,{namesOnly:true})]));
    const labels=new Map(contacts.map(([id,contact])=>[id,contact?.name||bareJidUser(contact?.id||'')]).filter(([,label])=>label));
    view={...view,body:resolveMentionLabels(body,labels),text:resolveMentionLabels(body,labels),replyTo:view.replyTo?{...view.replyTo,body:resolveMentionLabels(replyBody,labels),label:resolveMentionLabels(String(view.replyTo.label||''),labels),caption:resolveMentionLabels(String(view.replyTo.caption||''),labels)}:view.replyTo};
  }
  return view;
}
  if(url.pathname.startsWith('/api/integrations/v1/')){
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const key=store.keys.find(k=>equalHex(k.hash,hash(token)));
    if(!key)return send(res,401,{message:'Invalid integration key'});
    // Last-used is a once-a-minute stamp, so a busy integration does not rewrite the saved state on every call.
    if(!key.lastUsedAt||Date.now()-Date.parse(key.lastUsedAt)>60000){key.lastUsedAt=new Date().toISOString();persist();}
    const endpoint=url.pathname.slice('/api/integrations/v1/'.length);
    // Which account is this token for? Any valid token may ask: it only ever describes its own account, so a
    // gateway can confirm its setup and a leaked token still reveals nothing about the other accounts.
    if(req.method==='GET'&&endpoint==='account'){
      const own=provider.getAccount(key.accountId);
      if(!own)return send(res,404,{message:'The WhatsApp account this token belonged to no longer exists',accountId:key.accountId});
      const view=account(own);
      return send(res,200,{account:{id:view.id,label:view.label,phone:view.phone||null,status:view.status},token:{name:key.name,scopes:key.scopes}});
    }
    // Every WhatsApp account's id and name, for an application's account picker. Opt-in ("Read accounts"): unlike the rest
    // of the API it is not limited to the token's own account — but it lists only id, name, number and status, nothing else.
    if(req.method==='GET'&&endpoint==='accounts'&&key.scopes.includes('accounts:read')){
      const accounts=provider.listAccounts().map(account).map(view=>({id:view.id,label:view.label,phone:view.phone||null,status:view.status,current:view.id===key.accountId}));
      accounts.sort((a,b)=>String(a.label).localeCompare(String(b.label),undefined,{sensitivity:'base'})||a.id.localeCompare(b.id));
      return send(res,200,{accounts});
    }
    if(req.method==='GET'&&endpoint==='chats'&&key.scopes.includes('messages:read')){const chats=await provider.getChatsOverview(key.accountId);return send(res,200,{accountId:key.accountId,chats:chats.slice(0,35).sort((a,b)=>b.timestamp-a.timestamp)});}
    if(req.method==='GET'&&endpoint==='messages'&&key.scopes.includes('messages:read')){const chatId=url.searchParams.get('chatId');if(!chatId)return send(res,400,{message:'chatId is required'});const messages=await provider.getMessages(key.accountId,chatId,{limit:30});return send(res,200,{messages:messages.sort((a,b)=>a.timestamp-b.timestamp)});}
    if(req.method==='POST'&&endpoint==='messages'&&key.scopes.includes('messages:send')){
      const input=await readBody(req),target=sendTarget(input,{defaultCallingCode:callingCodeOf(provider.getAccount(key.accountId)?.phone)}),body=validMessageText(input.text);
      // The token already decides which WhatsApp account sends. An optional "accountId" is only a guard:
      // it must name that account, so a token pasted into the wrong flow fails loudly instead of sending from the wrong number.
      const asked=input.accountId===undefined||input.accountId===null||input.accountId===''?null:String(input.accountId);
      if(asked!==null&&asked!==key.accountId){
        const own=account(provider.getAccount(key.accountId)||{id:key.accountId});
        return send(res,403,{message:`This token sends from "${own.label}" (${key.accountId}), not "${asked}". Use the token created for that account.`,accountId:key.accountId});
      }
      if(target.error)return send(res,400,{message:target.error});
      if(body.error)return send(res,400,{message:body.error});
      let chatId=target.chatId,newChat=false;
      if(!chatId){
        // A phone number: use the existing conversation with it, or open a new one
        // if the number is on WhatsApp — the same step the New chat screen takes.
        const chat=await provider.startConversation(key.accountId,target.phone);
        chatId=chat.id;newChat=Boolean(chat.isNew);
      }
      const sent=await provider.sendText(key.accountId,chatId,body.text);
      const sender=account(provider.getAccount(key.accountId)||{id:key.accountId});
      return send(res,200,{ok:true,account:{id:sender.id,label:sender.label,phone:sender.phone||null},chatId,to:target.e164||null,newChat,message:sent});
    }
    return send(res,403,{message:'This integration key does not have permission for that action'});

  }
  if(url.pathname==='/api/app/auth/state'&&req.method==='GET')return send(res,200,{setup:!store.password,hasUsername:Boolean(store.username),authenticated:admin(req)});
  if(url.pathname==="/api/app/auth/setup"&&req.method==="POST"){
    if(store.password)return send(res,409,{message:"Administrator account already exists"});
    const input=await readBody(req),username=String(input.username||"").trim(),password=String(input.password||"");
    if(username.length<3||username.length>40)return send(res,400,{message:"Use a username between 3 and 40 characters"});
    if(password.length<10)return send(res,400,{message:"Use a password with at least 10 characters"});
    store.username=username;store.password=passwordHash(password);await persist();
    const token=issueSession(input.remember);res.writeHead(201,{"set-cookie":sessionCookie(token,Boolean(input.remember)),"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify({ok:true,username}));
  }
  if(url.pathname==="/api/app/auth/login"&&req.method==="POST"){const {username,password,remember}=await readBody(req);const expectedUsername=store.username;if(!store.password||(expectedUsername&&!loginNamesAdmin(store,username))||!passwordMatches(password||""))return send(res,401,{message:"Incorrect username or password"});const token=issueSession(remember);res.writeHead(200,{"set-cookie":sessionCookie(token,Boolean(remember)),"content-type":"application/json"});return res.end(JSON.stringify({ok:true}));}
  if(url.pathname==="/api/app/auth/logout"&&req.method==="POST"){const token=cookie(req).home_session;sessions.delete(token);res.writeHead(200,{"set-cookie":"home_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0","content-type":"application/json"});return res.end(JSON.stringify({ok:true}));}
  // Application tokens across the whole workspace (Settings → Application tokens). Each token
  // still names the one WhatsApp profile it sends from; per-token actions use the account routes.
  if(url.pathname==="/api/app/integration-keys"&&req.method==="GET"){if(!admin(req))return send(res,401,{message:"Sign in required"});pruneTokenSecrets();return send(res,200,{keys:store.keys.map(key=>publicToken(key))});}
  if(url.pathname==="/api/app/integration-keys"&&req.method==="POST"){
    if(!admin(req))return send(res,401,{message:"Sign in required"});
    const input=await readBody(req),accountId=String(input.accountId||"");
    if(!accountId||!provider.getAccount(accountId))return send(res,404,{message:"Choose one of your WhatsApp profiles for this token"});
    const result=await issueToken(accountId,input);
    return send(res,result.status,result.body);
  }
  // Interface preferences that should follow the administrator across browsers
  // and logins. A whitelist of boolean keys, so nothing else can be stored here.
  if(url.pathname==="/api/app/preferences"&&req.method==="GET"){if(!admin(req))return send(res,401,{message:"Sign in required"});return send(res,200,{sidebarCollapsed:typeof store.preferences.sidebarCollapsed==="boolean"?store.preferences.sidebarCollapsed:null});}
  if(url.pathname==="/api/app/preferences"&&req.method==="PATCH"){
    if(!admin(req))return send(res,401,{message:"Sign in required"});
    const input=await readBody(req);
    if("sidebarCollapsed" in input){if(typeof input.sidebarCollapsed!=="boolean")return send(res,400,{message:"sidebarCollapsed must be true or false"});store.preferences.sidebarCollapsed=input.sidebarCollapsed;}
    await persist();
    return send(res,200,{sidebarCollapsed:typeof store.preferences.sidebarCollapsed==="boolean"?store.preferences.sidebarCollapsed:null});
  }
  if(url.pathname==="/api/app/auth/profile"&&req.method==="GET"){if(!admin(req))return send(res,401,{message:"Sign in required"});return send(res,200,{username:store.username||null,email:store.email||null});}
  if(url.pathname==="/api/app/auth/profile"&&req.method==="PATCH"){if(!admin(req))return send(res,401,{message:"Sign in required"});const input=await readBody(req),username=String(input.username||"").trim(),currentPassword=String(input.currentPassword||"");
    // Username and email changes need only the signed-in session — signing in still takes the password, so they cannot let anyone in.
    // Setting a new password is the sensitive step, and it takes the current one.
    if(input.newPassword&&(!currentPassword||!passwordMatches(currentPassword)))return send(res,401,{message:"Enter your current password to set a new one"});if(username&&(username.length<3||username.length>40))return send(res,400,{message:"Use a username between 3 and 40 characters"});if(input.newPassword&&String(input.newPassword).length<10)return send(res,400,{message:"Use a password with at least 10 characters"});let email;if("email" in input){email=normalizeEmail(input.email);if(email===null)return send(res,400,{message:"Enter a valid email address"});}
    if(username)store.username=username;
    if(email!==undefined)store.email=email||null;
    let freshCookie=null;
    if(input.newPassword){
      store.password=passwordHash(String(input.newPassword));
      // A leaked session token must not survive a password change. Revoke
      // every session, then re-issue one for the tab that just changed it so
      // the admin isn't logged out by their own action.
      const previousToken=cookie(req).home_session,remember=sessions.get(previousToken)?.remember||false;
      sessions.clear();
      freshCookie=sessionCookie(issueSession(remember),remember);
    }
    await persist();
    const headers={"content-type":"application/json"};if(freshCookie)headers["set-cookie"]=freshCookie;
    res.writeHead(200,headers);return res.end(JSON.stringify({ok:true,username:store.username,email:store.email||null}));
  }
  if(!admin(req))return send(res,401,{message:'Sign in required'});
  if(req.method==='GET'&&url.pathname==='/api/app/events'){
    // One connection can follow several accounts (comma-separated): a browser allows only a handful
    // of simultaneous connections per host, and every open tab used to spend one per account.
    const accountIds=new Set(String(url.searchParams.get('accountId')||'').split(',').map(item=>item.trim()).filter(Boolean).slice(0,20));
    if(!accountIds.size)return send(res,400,{message:'accountId is required'});
    const afterId=String(req.headers['last-event-id']||url.searchParams.get('after')||'');
    // A subscriber that already knows the true current state from a regular
    // REST fetch (the sidebar's per-account unread indicator) and only wants
    // to hear about things from this point forward opts out of the catch-up
    // replay below with after=now — otherwise every fresh connection replays
    // recent history, which that subscriber has no way to tell apart from a
    // genuinely new event, and would treat as one. A real reconnect (the
    // browser resending Last-Event-ID after a drop) still catches up
    // normally: that header takes priority over this literal sentinel.
    const skipHistory=afterId==='now';
    const after=(!skipHistory&&afterId)?db.prepare('SELECT created_at FROM app_events WHERE id=?').get(afterId)?.created_at:null;
    const rows=skipHistory?[]:[...accountIds].flatMap(accountId=>after
      ?db.prepare('SELECT id,payload,created_at FROM app_events WHERE account_id=? AND created_at>? ORDER BY created_at ASC LIMIT 250').all(accountId,after)
      :db.prepare('SELECT id,payload,created_at FROM app_events WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(accountId).reverse()).sort((x,y)=>String(x.created_at).localeCompare(String(y.created_at)));
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
    res.write(': connected\n\n');
    for(const row of rows){try{writeSseEvent(res,JSON.parse(row.payload),row.id)}catch{}}
    const stream={res,accountIds};liveEventStreams.add(stream);
    const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),25000);
    req.on('close',()=>{clearInterval(heartbeat);liveEventStreams.delete(stream)});
    return;
  }
  if(req.method==='GET'&&url.pathname==='/api/app/link-preview'){return send(res,200,await openGraphPreview(url.searchParams.get('url')||''));}
  if(req.method==='GET'&&url.pathname==='/api/app/link-image'){
  const imageUrl=url.searchParams.get('url')||'';
  const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  let response;
  try{response=await fetchPinned(imageUrl,{headers:{'user-agent':ua,'accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(10000)});}
  catch{return send(res,400,{message:'Invalid public image URL'});}
  if(!response.ok)return send(res,502,{message:'Preview image unavailable'});
  const type=response.headers.get('content-type')||'image/jpeg';
  if(!type.startsWith('image/'))return send(res,502,{message:'Invalid preview image'});
  const body=Buffer.from(await response.arrayBuffer());
  if(body.length>5*1024*1024)return send(res,413,{message:'Preview image is too large'});
  res.writeHead(200,{'content-type':type,'cache-control':'private, max-age=3600','content-length':String(body.length)});
  return res.end(body);
}
  if(req.method==='GET'&&url.pathname==='/api/app/media'){
    const accountId=url.searchParams.get('accountId')||'',chatId=url.searchParams.get('chatId')||'',messageId=url.searchParams.get('messageId')||'';
    if(!accountId||!chatId||!messageId)return send(res,400,{message:'accountId, chatId, and messageId are required'});
    const file=await provider.downloadMedia(accountId,chatId,messageId);
    if(!file)return send(res,404,{message:'Media not found'});
    const range=req.headers.range,total=file.buffer.length;
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      const start=match&&match[1]?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),total-1):total-1;
      const body=file.buffer.subarray(start,end+1);
      res.writeHead(206,{'content-type':file.type,'cache-control':'private, max-age=86400','accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${total}`,'content-length':String(body.length)});
      return res.end(body);
    }
    res.writeHead(200,{'content-type':file.type,'cache-control':'private, max-age=86400','accept-ranges':'bytes','content-length':String(total)});
    return res.end(file.buffer);
  }
  if (req.method==='GET' && url.pathname==='/api/app/accounts') {return send(res,200,{accounts:await Promise.all(provider.listAccounts().map(accountView))});}
  if(req.method==='GET'&&url.pathname==='/api/app/instagram-preview'){return send(res,200,await instagramPreview(url.searchParams.get('url')||''));}
  if(req.method==='GET'&&url.pathname==='/api/app/instagram-image'){
  // Takes the Instagram *page* URL, not a raw CDN image URL: Instagram signs
  // og:image links with a short-lived expiry (days, not permanent), while
  // instagramPreview()'s cache of title/description is intentionally
  // long-lived — so a cached image link can go stale long before the rest
  // of the preview does. Resolving through instagramPreview() here (and
  // forcing one re-scrape on failure) lets a stale link self-heal instead
  // of just going blank forever.
  const pageUrl=safeInstagramPage(url.searchParams.get('url')||'');
  if(!pageUrl)return send(res,400,{message:'Invalid Instagram URL'});
  const ua='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const fetchImage=async imageHref=>{
    const image=safeInstagramImage(imageHref);if(!image)return null;
    try{
      const response=await fetch(image,{headers:{'user-agent':ua,'accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(10000),redirect:'follow'});
      if(!response.ok)return null;
      const type=response.headers.get('content-type')||'image/jpeg';
      if(!type.startsWith('image/'))return null;
      const body=Buffer.from(await response.arrayBuffer());
      if(body.length>5*1024*1024)return null;
      return {type,body};
    }catch{return null;}
  };
  let preview=await instagramPreview(pageUrl.href);
  let fetched=preview.image?await fetchImage(preview.image):null;
  if(!fetched){
    preview=await instagramPreview(pageUrl.href,{force:true});
    fetched=preview.image?await fetchImage(preview.image):null;
  }
  if(!fetched)return send(res,502,{message:'Instagram image unavailable'});
  res.writeHead(200,{'content-type':fetched.type,'cache-control':'private, max-age=3600','content-length':String(fetched.body.length)});
  return res.end(fetched.body);
}
  if (req.method==='POST' && url.pathname==='/api/app/accounts') {
    const input=await readBody(req), id=`account-${Date.now().toString(36)}`;
    const label=String(input.label||'WhatsApp account').trim().slice(0,80);if(label){store.accountLabels[id]=label;await persist();}
    await provider.startAccount(id,{label});
    return send(res,201,{account:account(provider.getAccount(id)||{id,status:'STARTING'})});
  }
  const id=decodeURIComponent(parts[3] || '');
  if (req.method==="DELETE" && parts.length===4) {await provider.deleteAccount(id).catch(()=>null);delete store.accountLabels[id];store.llmConfigs=(store.llmConfigs||[]).filter(item=>item.accountId!==id);store.automationSubscriptions=(store.automationSubscriptions||[]).filter(item=>item.accountId!==id);store.keys=(store.keys||[]).filter(item=>item.accountId!==id);store.voiceProfiles=(store.voiceProfiles||[]).filter(item=>item.accountId!==id);await persist();return send(res,200,{ok:true});}
  if (req.method==='GET' && parts[4]==='qr') return send(res,200,(await provider.getQr(id))||{});
  if (req.method==='POST' && parts[4]==='start') {await provider.startAccount(id,{label:store.accountLabels[id]}); return send(res,200,{ok:true});}
  if (req.method==='POST' && parts[4]==='restart') {await provider.restartAccount(id); return send(res,200,{ok:true});}
  // The reader has seen this conversation up to `through` (unix seconds of the newest message
  // on screen). Omitted = everything stored. The count returned is the authoritative remainder.
  if(req.method==='POST'&&parts[4]==='chats'&&parts[5]&&parts[6]==='read'){
    const chatId=decodeURIComponent(parts[5]),input=await readBody(req).catch(()=>({})),through=Number(input.through)>0?Math.floor(Number(input.through)):undefined;
    const unreadCount=Number(await provider.markChatRead(id,chatId,{through}))||0;
    broadcastChatRead(id,chatId,unreadCount);
    return send(res,200,{ok:true,chatId,unreadCount});
  }
  // Pin / mute / archive a chat. Body: { pin: bool } | { archive: bool } | { mute: seconds }.
  if(req.method==='POST'&&parts[4]==='chats'&&parts[5]&&parts[6]==='state'){
    const chatId=decodeURIComponent(parts[5]),input=await readBody(req);
    let action,value;
    if('pin' in input){action='pin';value=Boolean(input.pin);}
    else if('archive' in input){action='archive';value=Boolean(input.archive);}
    else if('mute' in input){action='mute';value=Math.max(0,Math.min(Number(input.mute)||0,60*60*24*365));}
    else return send(res,400,{message:'Provide one of pin, archive or mute'});
    const chat=await provider.setChatState(id,chatId,action,value);
    return send(res,200,{chat:await enrichChatOverview(id,chat,{pictures:false})});
  }
  // Turn the AI on or off for one conversation: adds or removes it on the AI
  // reply list (the same list Settings edits).
  if(req.method==='POST'&&parts[4]==='chats'&&parts[5]&&parts[6]==='ai'){
    const chatId=decodeURIComponent(parts[5]),input=await readBody(req),config=llmConfig(id);
    if(!config)return send(res,409,{message:'Set up AI Responses in Settings before turning AI on for a chat'});
    const next=setChatListed(config.replyRules,{chatId,phone:chatAiPhone(id,chatId)},Boolean(input.enabled));
    if(!next)return send(res,409,{message:"Gakai can't tell this contact's phone number yet, so it can't add them to the AI reply list"});
    config.replyRules=next;
    await persist();
    const overview=(await provider.getChatsOverview(id)).find(chat=>chat.id===chatId)||{id:chatId};
    return send(res,200,{chat:await enrichChatOverview(id,overview,{pictures:false})});
  }
  if(req.method==='POST'&&parts[4]==='chats'&&parts[5]&&parts[6]==='block'){
    const chatId=decodeURIComponent(parts[5]),input=await readBody(req);
    const result=await provider.setBlocked(id,chatId,Boolean(input.blocked));
    return send(res,200,{ok:true,...result});
  }
  if(req.method==='POST'&&parts[4]==='chats'&&parts[5]&&parts[6]==='disappearing'){
    const chatId=decodeURIComponent(parts[5]),input=await readBody(req);
    const seconds=Math.max(0,Math.min(Number(input.seconds)||0,60*60*24*90));
    const chat=await provider.setDisappearing(id,chatId,seconds);
    return send(res,200,{chat:await enrichChatOverview(id,chat,{pictures:false})});
  }
  // Open a new 1:1 conversation from a phone number (checks it's on WhatsApp).
  if(req.method==='POST'&&parts[4]==='chats'&&!parts[5]){
    const input=await readBody(req),phone=String(input.phone||'').replace(/[^0-9]/g,'');
    if(!phone)return send(res,400,{message:'Enter a phone number in international format'});
    const chat=await provider.startConversation(id,phone);
    const enriched=await enrichChatOverview(id,chat,{pictures:true});
    return send(res,200,{chat:enriched.name?enriched:{...enriched,name:`+${phone}`}});
  }
  // Contact suggestions for the "new chat" number field.
  if(req.method==='GET'&&parts[4]==='contacts'){
    const q=String(url.searchParams.get('q')||'').trim().toLowerCase();
    const rows=(provider.getContacts(id)||[])
      .map(c=>({id:c.id||c.contact_id||null,name:c.name||null,phone:c.phone||null}))
      .filter(c=>c.id&&c.phone&&(!q||String(c.name||'').toLowerCase().includes(q)||String(c.phone).includes(q)))
      .slice(0,20);
    return send(res,200,{contacts:rows});
  }
  // Must be checked before the whole-chat DELETE below: both match
  // parts[4]==='chats'&&parts[5], only this one additionally has
  // parts[6]==='messages'&&parts[7] (a specific message under that chat).
  if(req.method==='DELETE'&&parts[4]==='chats'&&parts[5]&&parts[6]==='messages'&&parts[7]){
    const chatId=decodeURIComponent(parts[5]),messageId=decodeURIComponent(parts[7]);
    if(!messageId)return send(res,400,{message:'Invalid message ID'});
    // WhatsApp's own server only honors a true "delete for everyone" for the
    // account's own messages — revoking someone else's message is never
    // possible, regardless of what Gakai requests here. The client's
    // confirmation prompt reflects that distinction.
    await provider.deleteMessage(id,chatId,messageId);
    return send(res,200,{ok:true});
  }
  if(req.method==='PATCH'&&parts[4]==='chats'&&parts[5]&&parts[6]==='messages'&&parts[7]){
    const chatId=decodeURIComponent(parts[5]),messageId=decodeURIComponent(parts[7]);
    const input=await readBody(req),text=String(input.text||'').trim();
    if(!messageId)return send(res,400,{message:'Invalid message ID'});
    if(!text)return send(res,400,{message:'An edited message cannot be empty'});
    if(text.length>4096)return send(res,400,{message:'Message is too long'});
    const message=await provider.editMessage(id,chatId,messageId,text);
    return send(res,200,{message:await enrichMessage(id,message)});
  }
  if(req.method==='DELETE'&&parts[4]==='chats'&&parts[5]){const chatId=decodeURIComponent(parts[5]);await provider.deleteChat(id,chatId);return send(res,200,{ok:true});}
  // Presence stays behind the dashboard proxy so the browser never receives
  // direct provider access.
  if (parts[4]==='presence') {
    const chatId=url.searchParams.get('chatId');
    if (!chatId) return send(res,400,{message:'chatId is required'});
    if (req.method==='GET') {
      await provider.subscribePresence(id,chatId);
      return send(res,200,{presence:null});
    }
    if (req.method==='POST') {
      const {presence}=await readBody(req);
      if (!['typing','recording','paused'].includes(presence)) return send(res,400,{message:'Invalid presence state'});
      await provider.publishPresence(id,chatId,presence);
      return send(res,200,{ok:true});
    }
  }
  // Details window: about a person, or a group's description and members. Read-only, and only fetched
  // when the reader opens it, so it never adds provider calls on its own.
  if (req.method==='GET' && parts[4]==='chats' && parts[5] && parts[6]==='info') {
    try{return send(res,200,await provider.getChatInfo(id,decodeURIComponent(parts[5])));}
    catch(error){return send(res,error.status||502,{message:error.message||'Could not load the details'});}
  }
  if (req.method==='GET' && parts[4]==='chats' && parts[5] && parts[6]==='participants') {
    const chatId=decodeURIComponent(parts[5]);
    return send(res,200,{participants:await provider.getGroupParticipants(id,chatId)});
  }
  // The inbox avatars, fetched lazily after the list text has already painted.
  // Each miss is a live WhatsApp profilePictureUrl() call, so this is
  // concurrency-capped and the client asks for them in small batches.
  if (req.method==='GET' && parts[4]==='chats' && parts[5]==='pictures') {
    const ids=String(url.searchParams.get('ids')||'').split(',').map(value=>value.trim()).filter(Boolean).slice(0,80);
    const entries=await mapWithConcurrency(ids,4,async jid=>{try{const contact=await resolveContact(id,jid);return [jid,contact.picture||null]}catch{return [jid,null]}});
    return send(res,200,{pictures:Object.fromEntries(entries.filter(([,pictureUrl])=>pictureUrl))});
  }
  if (req.method==='GET' && parts[4]==='chats') {
    // GET /chats?limit=50&cursor=<opaque>[&archived=1] — one page of the local conversation index,
    // newest activity first. The next page's cursor travels in the x-next-cursor header (absent on
    // the last page), so the body stays a plain array.
    const page=await provider.getChatsPage(id,{limit:clampPageSize(url.searchParams.get('limit'),inboxChatLimit),cursor:url.searchParams.get('cursor')||undefined,archived:url.searchParams.get('archived')==='1'});
    // pictures:false — the list must not block on a burst of avatar lookups;
    // the client hydrates them separately via /chats/pictures.
    const enriched=await mapWithConcurrency(page.chats,8,chat=>enrichChatOverview(id,chat,{pictures:false}));
    return send(res,200,enriched,page.nextCursor?{'x-next-cursor':page.nextCursor,'access-control-expose-headers':'x-next-cursor'}:{});
  }
  if (req.method==='GET' && parts[4]==='contact') {const contactId=url.searchParams.get('contactId');if(!contactId)return send(res,400,{message:'contactId is required'});return send(res,200,{contact:await resolveContact(id,contactId)});}
  if (req.method==='GET' && parts[4]==='messages') {
    const chatId=url.searchParams.get('chatId'); if (!chatId) return send(res,400,{message:'chatId is required'});
    const limit=Math.min(Math.max(Number(url.searchParams.get('limit')) || 15, 1), 60);
    // The first screen must be fast. Eager media download is intentionally
    // opt-in, because hydrating every attachment can be slow.
    const downloadMedia=url.searchParams.get('media') === '1';
    // `before` (the oldest currently-loaded message's timestamp) pages by a
    // stable point in time instead of a numeric offset, which drifts and can
    // skip a message if new ones arrive between page loads while the reader
    // is paging back through history.
    const before=Number(url.searchParams.get('before'));
    const messages=await provider.getMessages(id,chatId,{limit,before:Number.isFinite(before)&&before>0?before:undefined,downloadMedia});
    return send(res,200,(await Promise.all(messages.map(message=>enrichMessage(id,message)))).sort((a,b) => a.timestamp - b.timestamp));
  }
  if (req.method==='GET' && parts[4]==='message-media') {
    const chatId=url.searchParams.get('chatId'),messageId=url.searchParams.get('messageId');
    if(!chatId||!messageId)return send(res,400,{message:'chatId and messageId are required'});
    const message=await provider.getMessage(id,chatId,messageId);
    if(!message)return send(res,404,{message:'Message not found'});
    return send(res,200,{message:await enrichMessage(id,message)});
  }
  if(req.method==='POST'&&parts[4]==='messages'&&parts[5]&&parts[6]==='reaction'){
    const input=await readBody(req),messageId=decodeURIComponent(parts[5]);
    if(!messageId)return send(res,400,{message:'Invalid message ID'});
    const reaction=String(input.reaction||'');if(reaction.length>16)return send(res,400,{message:'Invalid reaction'});
    await provider.setReaction(id,url.searchParams.get('chatId')||null,messageId,reaction);
    return send(res,200,{ok:true,reaction});
  }
  if(req.method==='POST'&&parts[4]==='messages'&&parts[5]&&parts[6]==='star'){
    const input=await readBody(req),messageId=decodeURIComponent(parts[5]),chatId=String(input.chatId||url.searchParams.get('chatId')||'');
    if(!messageId||!chatId)return send(res,400,{message:'chatId and messageId are required'});
    const result=await provider.setMessageStar(id,chatId,messageId,Boolean(input.starred));
    return send(res,200,{ok:true,...result});
  }
  if(req.method==='GET'&&parts[4]==='starred'){
    const messages=await Promise.all((provider.getStarredMessages(id)||[]).map(async message=>({...await enrichMessage(id,message),chatId:message.chatId})));
    return send(res,200,{messages});
  }
  if(req.method==='POST'&&parts[4]==='messages'&&parts[5]&&parts[6]==='forward'){
    const input=await readBody(req),messageId=decodeURIComponent(parts[5]);
    const fromChatId=String(input.fromChatId||''),toChatId=String(input.toChatId||'');
    if(!messageId||!fromChatId||!toChatId)return send(res,400,{message:'messageId, fromChatId and toChatId are required'});
    const {chatId:targetChatId,message}=await provider.forwardMessage(id,fromChatId,messageId,toChatId);
    return send(res,200,{chatId:targetChatId,message:await enrichMessage(id,message)});
  }
  if (req.method==='POST' && parts[4]==='media') {
    const chatId=url.searchParams.get('chatId');
    if(!chatId)return send(res,400,{message:'chatId is required'});
    const mimetype=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    if(!/^(image|video|audio|application|text)\//.test(mimetype))return send(res,415,{message:'Unsupported file type'});
    const filename=String(req.headers['x-gakai-filename']||'').replace(/[\r\n"\\]/g,'').replace(/[^\w.\- ()]+/g,'_').slice(0,200)||null;
    const caption=String(url.searchParams.get('caption')||'').slice(0,1024);
    const replyTo=url.searchParams.get('replyTo')?String(url.searchParams.get('replyTo')):null;
    const voice=url.searchParams.get('voice')==='1';
    let buffer;
    try{buffer=await readRawBody(req,64*1024*1024);}
    catch(error){return send(res,error.status||400,{message:error.message||'Could not read the file'});}
    if(!buffer.length)return send(res,400,{message:'The file is empty'});
    const sent=await provider.sendMedia(id,chatId,{buffer,mimetype,filename,caption,kind:voice?'audio':undefined,ptt:voice},{quotedMessageId:replyTo});
    return send(res,200,{message:await enrichMessage(id,sent)});
  }
  if (req.method==='POST' && parts[4]==='messages') {
    const input=await readBody(req),replyTo=input.replyTo?String(input.replyTo):null; if (!input.chatId || !input.text?.trim()) return send(res,400,{message:'Recipient and message are required'});
    const mentions=Array.isArray(input.mentions)?input.mentions.filter(jid=>typeof jid==='string'&&jid.length<=128).slice(0,32):[];
    const sent=await provider.sendText(id,input.chatId,input.text.trim(),{quotedMessageId:replyTo,mentions});
    return send(res,200,{message:await enrichMessage(id,sent)});
  }
  if(req.method==='PATCH'&&parts[4]==='label') {const input=await readBody(req),label=String(input.label||'').trim().slice(0,80);if(!label)return send(res,400,{message:'Account name is required'});store.accountLabels[id]=label;await persist();return send(res,200,{ok:true,label});}
  // Copy a token back out — only while its 24-hour window is open, and only for the
  // signed-in administrator. Placed before the list route, which would otherwise take this URL.
  if(parts[4]==="integration-keys"&&parts[5]&&parts[6]==="token"&&req.method==="GET"){
    const key=store.keys.find(k=>k.id===parts[5]&&k.accountId===id);
    if(!key)return send(res,404,{message:"Token not found"});
    pruneTokenSecrets();
    const token=isCopyable(key)?decryptSecret(key.tokenEnc):null;
    if(!token)return send(res,410,{message:"This token can no longer be copied. Regenerate it to get a new one."});
    res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
    return res.end(JSON.stringify({token}));
  }
  if(parts[4]==="integration-keys"&&req.method==="GET"){pruneTokenSecrets();return send(res,200,{keys:store.keys.filter(k=>k.accountId===id).map(key=>publicToken(key))});}
  // Rotate a token: a new secret replaces the old one immediately, so the
  // application using the old token stops working until it is given the new one.
  if(parts[4]==="integration-keys"&&parts[5]&&parts[6]==="regenerate"&&req.method==="POST"){
    const key=store.keys.find(k=>k.id===parts[5]&&k.accountId===id);
    if(!key)return send(res,404,{message:"Token not found"});
    const token=newToken();
    key.hash=hash(token);key.tokenEnc=encryptSecret(token);key.last4=tokenLast4(token);key.rotatedAt=new Date().toISOString();key.lastUsedAt=null;delete key.token;
    await persist();
    return send(res,200,{key:publicToken(key),token});
  }
  // Change what a token may do. Takes effect on its very next call.
  if(parts[4]==="integration-keys"&&parts[5]&&!parts[6]&&req.method==="PATCH"){
    const key=store.keys.find(k=>k.id===parts[5]&&k.accountId===id);
    if(!key)return send(res,404,{message:"Token not found"});
    const checked=validateScopes((await readBody(req)).scopes);
    if(checked.error)return send(res,400,{message:checked.error});
    key.scopes=checked.scopes;
    await persist();
    return send(res,200,{key:publicToken(key)});
  }
  if(parts[4]==="integration-keys"&&req.method==="POST"){const result=await issueToken(id,await readBody(req));return send(res,result.status,result.body);}
  if(parts[4]==="automations"&&req.method==="GET")return send(res,200,{subscriptions:store.automationSubscriptions.filter(subscription=>subscription.accountId===id).map(automationSummary)});
  if(parts[4]==="automations"&&parts[5]==="test-delivery"&&req.method==="POST"){const input=await readBody(req),url=await httpsWebhookUrl(input.url||""),secret=String(input.secret||"").trim();if(!url)return send(res,400,{message:"Use the public HTTPS test webhook URL"});if(!secret||secret.length>256)return send(res,400,{message:"Enter the secret header value"});const event={id:`evt_test_${randomBytes(8).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id},chat:{id:"demo@s.whatsapp.net",kind:"direct"},message:{id:"demo-message",timestamp:Math.floor(Date.now()/1000),fromMe:false,body:"This is a Gakai test event.",text:"This is a Gakai test event.",hasMedia:false,media:null},source:"test"};try{const response=await automationFetch({secret,url:url.href},event);if(!response.ok)return send(res,502,{message:await describeWebhookFailure(response)});return send(res,200,{ok:true})}catch(error){return send(res,502,{message:error.message||"Test delivery failed"})}}
  if(parts[4]==="automations"&&!parts[5]&&req.method==="POST"){const input=await readBody(req),production=await httpsWebhookUrl(input.productionUrl||input.url||""),test=await httpsWebhookUrl(input.testUrl||""),requestedSecret=String(input.secret||"").trim();if(!production)return send(res,400,{message:"Use an HTTPS webhook URL"});if(input.testUrl&&!test)return send(res,400,{message:"Use an HTTPS test webhook URL"});if(requestedSecret.length>256)return send(res,400,{message:"Invalid secret"});const subscription={id:randomBytes(8).toString("hex"),accountId:id,name:String(input.name||"Webhook automation").trim().slice(0,80)||"Webhook automation",url:production.href,productionUrl:production.href,testUrl:test?.href||null,testPhone:String(input.testPhone||"").replace(/[^0-9]/g,"")||null,enabled:true,events:["message.received"],secret:requestedSecret||'gs_inbound_'+randomBytes(24).toString('base64url'),createdAt:new Date().toISOString(),lastDelivery:null};store.automationSubscriptions=store.automationSubscriptions.filter(item=>item.accountId!==id);store.automationSubscriptions.push(subscription);await persist();return send(res,201,{subscription:automationSummary(subscription),secret:subscription.secret});}
  if(parts[4]==="automations"&&parts[5]&&req.method==="PATCH"){
    const subscription=store.automationSubscriptions.find(item=>item.id===parts[5]&&item.accountId===id);
    if(!subscription)return send(res,404,{message:"Automation not found"});
    const input=await readBody(req);
    if(typeof input.enabled==="boolean")subscription.enabled=input.enabled;
    await persist();return send(res,200,{subscription:automationSummary(subscription)});
  }
  if(parts[4]==="automations"&&parts[5]&&parts[6]==="test"&&req.method==="POST"){const subscription=store.automationSubscriptions.find(item=>item.id===parts[5]&&item.accountId===id);if(!subscription)return send(res,404,{message:"Automation not found"});const input=await readBody(req),phone=String(input.phone||subscription.testPhone||"").replace(/[^0-9]/g,"");if(phone.length>30)return send(res,400,{message:"Invalid test phone number"});const target=phone?`${phone}@s.whatsapp.net`:"demo@s.whatsapp.net",event={id:`evt_test_${randomBytes(8).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id},chat:{id:target,kind:"direct",phone:phone||null},message:{id:"demo-message",timestamp:Math.floor(Date.now()/1000),fromMe:false,body:String(input.text||"This is a Gakai test event."),text:String(input.text||"This is a Gakai test event."),hasMedia:false,media:null,sender:phone?{id:target,phone}:null},source:"test"};const destination=String(input.destination||"production")==="test"?subscription.testUrl:subscription.productionUrl||subscription.url;if(!destination)return send(res,400,{message:"This webhook URL is not configured"});
    // Route through the same delivery path production events use so this
    // test send updates subscription.lastDelivery like a real one does,
    // instead of the status vanishing after a hand-rolled fetch.
    try{const reply=await deliverAutomation(subscription,event,{url:destination});return send(res,200,{ok:true,reply,subscription:automationSummary(subscription)})}
    catch(error){return send(res,502,{message:error.message||"Test delivery failed",subscription:automationSummary(subscription)})}}
  if(parts[4]==="automations"&&parts[5]&&req.method==="DELETE"){store.automationSubscriptions=store.automationSubscriptions.filter(item=>!(item.id===parts[5]&&item.accountId===id));await persist();return send(res,200,{ok:true});}
  if(parts[4]==='integration-keys'&&req.method==='DELETE'){const keyId=parts[5];store.keys=store.keys.filter(k=>!(k.id===keyId&&k.accountId===id));await persist();return send(res,200,{ok:true});}
  // Type-ahead for the AI reply list: people or groups from this account's
  // conversations (and contacts) matching what the user has typed so far.
  if(parts[4]==='reply-targets'&&req.method==='GET'){
    const kind=url.searchParams.get('kind')==='group'?'group':'person';
    const query=String(url.searchParams.get('q')||'').slice(0,80);
    const exclude=String(url.searchParams.get('exclude')||'').split(',').map(value=>value.trim()).filter(Boolean).slice(0,MAX_REPLY_EXCLUDE);
    const {chats,contacts}=await replyTargetSources(id);
    return send(res,200,{results:kind==='group'?searchGroups({chats,query,exclude}):searchPeople({chats,contacts,query,exclude})});
  }
  // Voice profiles: how the AI sounds for a person or group — a small YAML each, up to 5 per account.
  if(parts[4]==='voices'){
    const mine=()=>store.voiceProfiles.filter(item=>item.accountId===id);
    const shown=item=>({id:item.id,name:item.name,yaml:item.yaml,updatedAt:item.updatedAt});
    if(parts.length===5&&req.method==='GET')return send(res,200,{voices:mine().map(shown),limit:MAX_VOICES_PER_ACCOUNT,templates:VOICE_TEMPLATES});
    // Live check for the editor: problems with their lines, or a preview of what the AI will be told.
    if(parts[5]==='validate'&&req.method==='POST'){
      const parsed=parseVoiceYaml((await readBody(req)).yaml);
      return send(res,200,parsed.ok?{ok:true,name:parsed.profile.name,preview:{direct:compileVoicePrompt(parsed.profile,{chat:'direct'}),group:compileVoicePrompt(parsed.profile,{chat:'group'})}}:{ok:false,errors:parsed.errors});
    }
    if(parts.length===5&&req.method==='POST'||(parts.length===6&&req.method==='PUT')){
      const editing=parts.length===6?mine().find(item=>item.id===parts[5]):null;
      if(parts.length===6&&!editing)return send(res,404,{message:'Voice profile not found'});
      const yaml=String((await readBody(req)).yaml??''),parsed=parseVoiceYaml(yaml);
      if(!parsed.ok)return send(res,400,{message:'Fix the problems in the voice profile before saving.',errors:parsed.errors});
      const name=parsed.profile.name.trim();
      if(mine().some(item=>item!==editing&&item.name.toLowerCase()===name.toLowerCase()))return send(res,409,{message:`You already have a voice called "${name}". Give this one a different name.`});
      if(!editing&&mine().length>=MAX_VOICES_PER_ACCOUNT)return send(res,409,{message:`An account can have up to ${MAX_VOICES_PER_ACCOUNT} voice profiles. Delete one you no longer use first.`});
      const now=new Date().toISOString();
      if(editing){editing.name=name;editing.yaml=yaml;editing.updatedAt=now;await persist();return send(res,200,{voice:shown(editing)});}
      const created={id:`vo_${randomBytes(6).toString('hex')}`,accountId:id,name,yaml,createdAt:now,updatedAt:now};
      store.voiceProfiles.push(created);await persist();
      return send(res,201,{voice:shown(created)});
    }
    if(parts.length===6&&req.method==='DELETE'){
      const target=mine().find(item=>item.id===parts[5]);
      if(!target)return send(res,404,{message:'Voice profile not found'});
      store.voiceProfiles=store.voiceProfiles.filter(item=>item!==target);
      const config=llmConfig(id);if(config?.replyRules)config.replyRules=withKnownVoices(id,config.replyRules);   // anyone using it falls back to the default
      await persist();
      return send(res,200,{ok:true});
    }
  }
  // Who the AI may answer. Saved on its own (like the native toggle) so
  // editing the list never re-verifies the provider or touches its key.
  if(parts[4]==='llm'&&parts[5]==='rules'&&req.method==='PUT'){
    const config=llmConfig(id);
    if(!config)return send(res,404,{message:'Set up AI Responses before choosing who it replies to'});
    config.replyRules=withKnownVoices(id,await readBody(req));
    await persist();
    return send(res,200,await replyRulesView(id,config.replyRules));
  }
  // LLM proxy config endpoints
  // Live model list for the AI Responses dropdown. Nothing is saved: the
  // browser sends what is in the form (or "__keep__" to reuse the stored key),
  // and the provider itself says which models that key can use.
  if(parts[4]==='llm'&&parts[5]==='models'&&req.method==='POST'){
    const input=await readBody(req),existing=llmConfig(id);
    const aiProvider=inferLlmProvider(String(input.baseUrl||''),String(input.provider||''));
    let baseUrl=usesFixedBaseUrl(aiProvider)?FIXED_BASE_URLS[aiProvider]:String(input.baseUrl||'').trim();
    if(!baseUrl)return send(res,400,{message:'Enter the proxy URL first'});
    try{baseUrl=normalizeLlmBaseUrl(baseUrl,aiProvider)}catch{return send(res,400,{message:'Enter a valid proxy URL'});}
    let apiKey=String(input.apiKey||'').trim();
    if(apiKey==='__keep__'){
      // Only reuse the stored key for the endpoint it was saved against, so a
      // changed URL can never carry the saved key somewhere else.
      const sameTarget=existing&&aiFamily(existing.provider||inferLlmProvider(existing.baseUrl))===aiFamily(aiProvider)&&(usesFixedBaseUrl(aiProvider)||existing.baseUrl===baseUrl);
      apiKey=sameTarget?existing.apiKey:'';
    }
    if(!apiKey)return send(res,400,{message:'Enter an API key to load the available models'});
    try{return send(res,200,{models:await listAiModels({provider:aiProvider,baseUrl,apiKey})});}
    catch(error){return send(res,error.status===401||error.status===403?401:502,{message:'Could not load models: '+(error.message||'Unknown error')});}
  }
  if(parts[4]==='llm'&&parts[5]==='test'&&req.method==='POST'){
    const cfg=llmConfig(id),input=await readBody(req),prompt=String(input.prompt||'').trim();
    if(!cfg)return send(res,409,{message:'Set up AI Responses before testing it'});
    if(!prompt||prompt.length>4000)return send(res,400,{message:'Enter a test prompt up to 4,000 characters'});
    const phone=String(input.phone||'').replace(/[^0-9]/g,'');
    if(phone.length>30)return send(res,400,{message:'Invalid test phone number'});
    let reply;
    try{reply=await llmChat(cfg,[{role:'system',content:await replyInstructions(id,{chat:{id:`${phone}@s.whatsapp.net`,kind:'direct',phone:phone||null}})},{role:'user',content:prompt}]);}
    catch(error){return send(res,502,{message:error.message||'LLM test failed'});}
    // A phone number is opt-in delivery: same provider.sendText() call
    // dispatchLLMReply makes for a real inbound message, so this actually
    // proves the full native-reply path, not just proxy connectivity.
    if(phone&&reply.trim()){
      try{await provider.sendText(id,`${phone}@s.whatsapp.net`,reply.trim());}
      catch(error){return send(res,502,{message:'The proxy replied, but delivering it to WhatsApp failed: '+(error.message||'Unknown error'),reply});}
      return send(res,200,{reply,delivered:true});
    }
    return send(res,200,{reply,delivered:false});
  }
  if(parts[4]==='llm'&&req.method==='GET'){const cfg=llmConfig(id);return send(res,200,cfg?{...await replyRulesView(id,cfg.replyRules),configured:true,provider:cfg.provider||inferLlmProvider(cfg.baseUrl),baseUrl:cfg.baseUrl,model:cfg.model,nativeEnabled:cfg.nativeEnabled||false,apiKeyLength:String(cfg.apiKey||'').length,apiKeyLast4:String(cfg.apiKey||'').slice(-4)}:{configured:false});}
  if(parts[4]==='llm'&&req.method==='POST'){
    const input=await readBody(req);
    const existing=llmConfig(id);
    const aiProvider=inferLlmProvider(String(input.baseUrl||''),String(input.provider||''));
    let baseUrl=usesFixedBaseUrl(aiProvider)?FIXED_BASE_URLS[aiProvider]:String(input.baseUrl||'').trim().replace(/\/+$/,'');
    if(!baseUrl)return send(res,400,{message:'Proxy URL is required'});
    try{baseUrl=normalizeLlmBaseUrl(baseUrl,aiProvider)}catch{return send(res,400,{message:'Enter a valid proxy URL'});}
    // __keep__ means "don't change the stored API key" (used by the skill/settings update form).
    // It only applies while the provider (and proxy URL) are the ones the key was saved for.
    const keepKey=String(input.apiKey||'')==='__keep__';
    const sameTarget=existing&&aiFamily(existing.provider||inferLlmProvider(existing.baseUrl))===aiFamily(aiProvider)&&existing.baseUrl===baseUrl;
    if(keepKey&&!sameTarget)return send(res,400,{message:'Enter an API key for this provider'});
    const apiKey=keepKey?(existing?.apiKey||''):String(input.apiKey||'').trim();
    const model=String(input.model||'').trim();
    if(!apiKey)return send(res,400,{message:'API key is required'});
    if(!model)return send(res,400,{message:'Choose a model'});
    // Skip connection test when only updating skill/settings (apiKey kept, baseUrl+model unchanged)
    const settingsOnly=keepKey&&existing&&existing.model===model;
    if(!settingsOnly){
      try{
        // A 400 is tolerated: it means the endpoint and key were accepted but
        // this one-token probe was rejected for a model-specific reason.
        await aiComplete({provider:aiProvider,baseUrl,apiKey,model},[{role:'user',content:'hi'}],{maxTokens:1,timeoutMs:15000}).catch(error=>{if(error.status!==400)throw error;});
      }catch(err){return send(res,400,{message:'Could not connect to the AI provider: '+err.message});}
    }
    // nativeEnabled is managed by its own immediate PATCH /llm toggle below,
    // not this form — preserve whatever it's currently set to rather than
    // reading a stale/absent field from this save.
    const nextConfig={accountId:id,provider:aiProvider,baseUrl,apiKey,model,nativeEnabled:existing?.nativeEnabled||false,replyRules:normalizeReplyRules(existing?.replyRules),configuredAt:existing?.configuredAt||new Date().toISOString()};
    store.llmConfigs=store.llmConfigs.filter(c=>c.accountId!==id);
    store.llmConfigs.push(nextConfig);
    await persist();
    return send(res,200,{ok:true});
  }
  // Immediate "Enable AI replies" toggle: flipping it needs no resubmit of the whole proxy form.
  if(parts[4]==='llm'&&parts[5]==='native'&&req.method==='PATCH'){
    const config=llmConfig(id);
    if(!config)return send(res,404,{message:'Set up AI Responses before enabling native replies'});
    const input=await readBody(req);
    config.nativeEnabled=Boolean(input.nativeEnabled);
    await persist();
    return send(res,200,{ok:true,nativeEnabled:config.nativeEnabled});
  }
  if(parts[4]==='llm'&&req.method==='DELETE'){store.llmConfigs=store.llmConfigs.filter(c=>c.accountId!==id);await persist();return send(res,200,{ok:true});}
  return send(res,404,{message:'Not found'});
}
const server=http.createServer(async (req,res)=>{ const url=new URL(req.url,`http://${req.headers.host}`); try {
  if (url.pathname === '/healthz' || url.pathname === '/readyz' || url.pathname.startsWith('/api/')) return await api(req,res,url);
  // React owns application routes. Serve the shell for deep links so a direct
  // visit to an account details page does not get treated as a missing file.
  const requested=(url.pathname==='/'||url.pathname==='/settings'||url.pathname==='/settings/'||url.pathname.startsWith('/accounts/')||url.pathname.startsWith('/details/')||url.pathname.startsWith('/profile-settings/'))?'/index.html':url.pathname, file=normalize(join(publicDir,requested));
  if (!file.startsWith(publicDir)) return send(res,403,{message:'Forbidden'});
  const content=await readFile(file); res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-cache'}); res.end(content);
} catch(error) { console.error(error); send(res,error.status||502,{message:error.message||'Service unavailable'}); }});
const wss=new WebSocketServer({noServer:true});
wss.on('connection',(socket,req)=>{
  const url=new URL(req.url,`http://${req.headers.host}`);
  socket.accountId=String(url.searchParams.get('accountId')||'');socket.chatId=String(url.searchParams.get('chatId')||'');typingSockets.add(socket);provider.subscribePresence(socket.accountId,socket.chatId).catch(()=>{});
  socket.send(JSON.stringify({type:'ready'}));
  socket.on('message',raw=>{try{const input=JSON.parse(String(raw));if(input.type!=='presence'||input.accountId!==socket.accountId||input.chatId!==socket.chatId||!['typing','recording','paused'].includes(input.presence))return;provider.publishPresence(socket.accountId,socket.chatId,input.presence).catch(()=>{});broadcastTyping(socket.accountId,socket.chatId,{type:'presence',accountId:socket.accountId,chatId:socket.chatId,presence:input.presence},socket)}catch{}});
  socket.on('close',()=>{typingSockets.delete(socket)});
});
server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url,`http://${req.headers.host}`);if(url.pathname!=='/api/app/ws'||!admin(req)||!url.searchParams.get('accountId')||!url.searchParams.get('chatId')){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,client=>wss.emit('connection',client,req));});
server.listen(port,'0.0.0.0',()=>console.log(`Gakai is ready on port ${port}`));
// Baileys sockets are in-process and don't survive a restart on their own —
// only the on-disk auth state does — so every previously-linked account
// needs an explicit reconnect on boot (the old external provider process
// used to do this transparently).
readdir(sessionsDir,{withFileTypes:true}).then(entries=>Promise.all(
  entries.filter(entry=>entry.isDirectory()).map(entry=>provider.startAccount(entry.name,{label:store.accountLabels[entry.name]}).catch(error=>console.error(`Failed to reconnect account ${entry.name}:`,error.message)))
)).catch(error=>console.error('Failed to read sessions directory:',error.message));

// Baileys persists each account's credentials with a plain, non-atomic
// fs.writeFile (no write-then-rename — see @whiskeysockets/baileys'
// useMultiFileAuthState) and its read path silently discards anything that
// fails to parse, falling back to a brand-new *unregistered* identity with
// no warning logged. With no signal handler at all, Node's default SIGTERM
// behavior is to terminate immediately — so a container restart landing
// mid-write can truncate creds.json, and the next boot silently overwrites
// the real credentials with a blank identity, unlinking WhatsApp. Merely
// registering a handler already replaces that immediate-terminate default;
// the delay below then gives a write already in flight when the signal
// arrived room to actually finish before the process exits.
let shuttingDown=false;
async function shutdown(signal){
  if(shuttingDown)return;shuttingDown=true;
  console.log(`${signal} received, shutting down gracefully…`);
  const forceExit=setTimeout(()=>{console.error('Graceful shutdown timed out; forcing exit');process.exit(1);},8000);
  forceExit.unref();
  try{await provider.shutdown();}catch(error){console.error('Provider shutdown failed:',error.message);}
  await new Promise(resolve=>setTimeout(resolve,500));
  server.close(()=>{clearTimeout(forceExit);process.exit(process.exitCode||0);});
}
process.on('SIGTERM',()=>{shutdown('SIGTERM')});
process.on('SIGINT',()=>{shutdown('SIGINT')});
// A media download whose connection drops mid-body raises an 'error' on a
// stream nothing listens to, which Node's default turns into an immediate
// process exit — every account disconnected and every admin session lost
// over one failed attachment. Log that case and carry on (the download's own
// timeout fails the request). Anything else is a real fault: still exit, but
// through the same graceful path a signal takes, so a credential write
// already in flight can finish.
process.on('uncaughtException',error=>{
  if(isRecoverableStreamError(error)){console.error('Recovered from a dropped network stream:',error?.message,error?.cause?.code||error?.code||'');return;}
  console.error('Uncaught exception; shutting down',error);
  process.exitCode=1;
  shutdown('uncaughtException');
});

export { server, readBody, store, sessions, replyInstructions, sendAutomationReply, describeWebhookFailure, provider, dispatchAutomationEvent };
