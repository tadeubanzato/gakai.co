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

const port = Number(process.env.PORT || 3000);
// Encrypts secrets we must read back later (e.g. the n8n API key, to call n8n's
// API again on the user's behalf).
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
if(!Array.isArray(store.n8nConnections))store.n8nConnections=[];
let migratedN8nConnections=false;for(const connection of store.n8nConnections){if(!connection.kind){connection.kind='standard';migratedN8nConnections=true}}if(migratedN8nConnections)persist();
if(!Array.isArray(store.llmConfigs))store.llmConfigs=[];
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
const inboxRecencyMs=(Number(process.env.GAKAI_INBOX_RECENCY_DAYS)||60)*24*60*60*1000;
const inboxChatLimit=Number(process.env.GAKAI_INBOX_CHAT_LIMIT)||40;
const instagramPreviewRetryMs=Number(process.env.GAKAI_INSTAGRAM_PREVIEW_RETRY_MS)||5*60*1000;
// Guards against a double-click or slow-retry racing two concurrent n8n
// connect attempts for the same account: each spans several awaited n8n API
// calls with no atomic "does a connection already exist" check in between.
const n8nConnectLocks=new Map();
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
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const send = (res, status, data) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(data)); };
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
    if (stream.accountId === event.account.id) writeSseEvent(stream.res, event, event.id);
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
function handleProviderEvent(kind,payload){
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
const n8nWebhookUrl=async value=>(await validatePublicUrl(value,{requireHttps:true}))?.url||null;
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
  return view;
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
// an automation (the Gakai-managed n8n templates, or any hand-authored
// webhook) generate a reply without ever calling back into Gakai's own
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
// A 404 from an n8n webhook path is most often the ordinary "this workflow
// exists but was never activated/published" case, not a wrong URL — n8n's
// own JSON error body already says so via its `hint`/`message` fields, so
// surface that instead of a bare, confusing status code.
async function describeWebhookFailure(response){
  let detail='';
  try{const body=await response.json();detail=String(body?.hint||body?.message||'').trim();}catch{}
  if(response.status===404)return detail?`This n8n workflow isn't reachable: ${detail}`:"This n8n workflow isn't published yet. Activate it in n8n (the toggle in the top-right of the workflow editor), then try again.";
  return detail?`Webhook returned ${response.status}: ${detail}`:`Webhook returned ${response.status}`;
}
async function deliverAutomation(subscription,event,options={}){subscription.secret=subscription.secret||ensureN8nKey(subscription.accountId);
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
// The Gakai-managed n8n subscriptions (created by the Settings n8n connect
// flow) are meant for messages the account owner needs to act on
// personally — a direct message, or a group message where they're
// explicitly @-tagged — not every message in every group the account
// happens to be in. A hand-authored automation added through the generic
// automations API is unaffected: that's a deliberate integration the user
// built for their own purpose, which may well want every message.
const N8N_REPLY_SUBSCRIPTION_NAMES=new Set(['n8n auto-connect','n8n auto-connect (AI Agent)']);

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
    ?mentionsIdentity(message.mentionedJids,provider.getAccount(accountId)?.ownJid)
    :false;
  const event={id:`evt_${message.id}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id:accountId},chat,message,mentionsYou,source:"whatsapp"};
  // Persist before notifying the browser or downstream automation. This gives
  // reconnecting clients a small durable replay window and avoids exposing raw
  // provider payloads outside the adapter boundary.
  if (!recordAppEvent(event)) return;
  const ownMentioned=kind==="direct"||mentionsYou;
  const nativeEnabled=Boolean(llmConfig(accountId)?.nativeEnabled);
  // Native mode is intentionally a hard boundary for Gakai-managed n8n
  // reply templates. This also protects an account that has stale persisted
  // subscriptions from producing a duplicate n8n reply while native mode is
  // selected. Hand-authored automations remain opt-in and untouched.
  const subscriptions=store.automationSubscriptions.filter(subscription=>subscription.accountId===accountId&&subscription.enabled&&subscription.events.includes(event.type)&&(!N8N_REPLY_SUBSCRIPTION_NAMES.has(subscription.name)||ownMentioned)&&(!nativeEnabled||!N8N_REPLY_SUBSCRIPTION_NAMES.has(subscription.name)));
  await Promise.allSettled([
    ...subscriptions.map(subscription=>deliverAutomation(subscription,event)),
    nativeEnabled?dispatchLLMReply(accountId,event):hasEnabledAgenticN8n(accountId)?Promise.resolve():dispatchLLMReply(accountId,event)
  ]);
}

function ensureN8nKey(accountId){
  let key=store.keys.find(item=>item.accountId===accountId&&item.name==='n8n integration');
  if(key?.token)return key.token;
  const token=`wh_live_${randomBytes(24).toString('base64url')}`;
  if(key){key.token=token;key.hash=hash(token);key.lastUsedAt=null}else store.keys.push({id:randomBytes(8).toString('hex'),accountId:accountId,name:'n8n integration',scopes:['messages:read','messages:send'],createdAt:new Date().toISOString(),lastUsedAt:null,token,hash:hash(token)});
  return token;
}
function normalizeN8nBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
}

async function n8nRequest(n8nUrl, n8nApiKey, path, options={}) {
  const headers = { 'X-N8N-API-KEY': n8nApiKey, 'accept': 'application/json', ...(options.headers || {}) };
  const response = await fetch(`${n8nUrl}/api/v1${path}`, { ...options, headers, signal: options.signal || AbortSignal.timeout(20000) });
  const text = await response.text(); let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = response.status === 401
      ? 'Invalid n8n API key or insufficient permissions'
      : ((data && (data.message || data.error)) || `n8n API request failed with status ${response.status}`);
    throw Object.assign(new Error(message), {status:response.status, data});
  }
  return data;
}

async function n8nWorkflowExists(n8nUrl,n8nApiKey,workflowId){
  try{await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${encodeURIComponent(workflowId)}`);return true;}
  catch(error){if(error.status===404)return false;throw error;}
}
async function n8nWorkflowActive(n8nUrl,n8nApiKey,workflowId){
  const workflow=await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${encodeURIComponent(workflowId)}`);
  return typeof workflow?.active==='boolean'?workflow.active:(typeof workflow?.isActive==='boolean'?workflow.isActive:null);
}
async function n8nCredentialExists(n8nUrl,n8nApiKey,credentialId){
  try{await n8nRequest(n8nUrl,n8nApiKey,`/credentials/${encodeURIComponent(credentialId)}`);return true;}
  catch(error){if(error.status===404)return false;throw error;}
}

async function publishN8nWorkflow(n8nUrl,n8nApiKey,workflowId){
  try{
    return await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${workflowId}/publish`,{method:'POST'});
  }catch(error){
    // Older n8n releases use /activate. Keep this fallback for self-hosted installs
    // that have not yet moved to the publish endpoint.
    if(![404,405].includes(error.status))throw error;
    return await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${workflowId}/activate`,{method:'POST'});
  }
}

async function activateAndVerifyN8nWorkflow(n8nUrl,n8nApiKey,workflowId){
  const before=await n8nWorkflowActive(n8nUrl,n8nApiKey,workflowId);
  if(before!==true)await publishN8nWorkflow(n8nUrl,n8nApiKey,workflowId);
  const after=await n8nWorkflowActive(n8nUrl,n8nApiKey,workflowId);
  if(after===false)throw new Error('n8n did not activate the selected workflow');
}

async function unpublishN8nWorkflow(n8nUrl,n8nApiKey,workflowId){
  if(!(await n8nWorkflowExists(n8nUrl,n8nApiKey,workflowId)))return {missing:true};
  if((await n8nWorkflowActive(n8nUrl,n8nApiKey,workflowId))===false)return {missing:false};
  try{
    await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${workflowId}/unpublish`,{method:'POST'});
  }catch(error){
    // n8n previously called this operation deactivate. Keep older
    // self-hosted installs compatible while using the current API first.
    if(![404,405].includes(error.status))throw error;
    try{await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${workflowId}/deactivate`,{method:'POST'});}
    catch(fallbackError){
      // The workflow may have been deleted directly in n8n. It cannot be
      // active in that state, so it must not prevent the remaining reply
      // mode from being selected.
      if(fallbackError.status===404)return {missing:true};
      throw fallbackError;
    }
  }
  if((await n8nWorkflowActive(n8nUrl,n8nApiKey,workflowId))===true)throw new Error('n8n did not deactivate the other workflow');
  return {missing:false};
}

async function deleteN8nCredentialQuietly(n8nUrl,n8nApiKey,credentialId){
  if(!credentialId)return;
  try{await n8nRequest(n8nUrl,n8nApiKey,`/credentials/${credentialId}`,{method:'DELETE'});}catch{}
}

async function deleteN8nWorkflowQuietly(n8nUrl,n8nApiKey,workflowId){
  if(!workflowId)return;
  try{await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${workflowId}`,{method:'DELETE'});}catch{}
}
function makeUUID() {
  const b = randomBytes(16).toString('hex');
  return `${b.slice(0,8)}-${b.slice(8,12)}-${b.slice(12,16)}-${b.slice(16,20)}-${b.slice(20,32)}`;
}
function llmConfig(accountId){return store.llmConfigs.find(c=>c.accountId===accountId)||null;}
// An account can have both native LLM auto-reply and a generated n8n AI
// Agent workflow configured. When both are live, the n8n AI Agent wins and
// native dispatch is skipped, so an inbound message never gets two
// independent AI replies.
function hasEnabledAgenticN8n(accountId){return store.automationSubscriptions.some(item=>item.accountId===accountId&&item.enabled&&item.name==='n8n auto-connect (AI Agent)');}
// An account has one automatic WhatsApp reply handler. The standard n8n
// reply template, the n8n AI Agent, and native AI each send replies through
// the same inbound event, so allowing more than one live handler produces
// duplicate messages.
function disableTheOtherAiReplyPath(accountId,keep){
  if(keep!=='native'){const config=llmConfig(accountId);if(config)config.nativeEnabled=false;}
  if(keep!=='agentic'){const sub=store.automationSubscriptions.find(item=>item.accountId===accountId&&item.name==='n8n auto-connect (AI Agent)');if(sub)sub.enabled=false;}
}
function disableStandardN8nReplies(accountId){const sub=store.automationSubscriptions.find(item=>item.accountId===accountId&&item.name==='n8n auto-connect');if(!sub||!sub.enabled)return false;sub.enabled=false;return true;}
async function unpublishOtherN8nReplyWorkflow(accountId,selectedKind){
  const otherKind=selectedKind==='agentic'?'standard':'agentic';
  const connection=store.n8nConnections.find(item=>item.accountId===accountId&&item.kind===otherKind);
  if(!connection?.workflowId)return {unpublished:false,missing:false};
  const n8nApiKey=decryptSecret(connection.n8nApiKeyEncrypted);
  if(!n8nApiKey)throw Object.assign(new Error(`The ${otherKind==='agentic'?'AI Agent':'standard'} n8n workflow has no saved API key`),{status:409});
  const result=await unpublishN8nWorkflow(connection.n8nUrl,n8nApiKey,connection.workflowId);
  return {unpublished:!result?.missing,missing:Boolean(result?.missing)};
}
async function deactivateN8nReplyWorkflows(accountId){
  for(const kind of ['standard','agentic']){
    const connection=store.n8nConnections.find(item=>item.accountId===accountId&&item.kind===kind);
    if(!connection?.workflowId)continue;
    const n8nApiKey=decryptSecret(connection.n8nApiKeyEncrypted);
    if(!n8nApiKey)throw Object.assign(new Error('Reauthorize n8n before disabling replies'),{status:409});
    await unpublishN8nWorkflow(connection.n8nUrl,n8nApiKey,connection.workflowId);
  }
}
const llmProviders=new Set(['omniroute','litellm']);
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
function llmChatCompletionsUrl(baseUrl){
  const url=new URL(baseUrl);
  url.pathname=`${url.pathname.replace(/\/+$/,'')}/chat/completions`.replace(/\/\/+/g,'/');
  return url.href;
}
function llmRequestBody(config,messages,extra={}){
  // Both supported proxies use OpenAI Chat Completions. This shared adapter
  // keeps native replies, connection verification, and n8n in agreement.
  return {model:config.model,stream:false,messages,...extra};
}
const defaultAssistantInstructions=`You are the WhatsApp assistant for this business.

Use a friendly, warm, professional tone. Keep replies concise and natural for WhatsApp. Answer customer questions, help with scheduling and next steps, and ask one clear follow-up question when information is missing.
Do not make up facts, prices, availability, or promises. If a request needs a human, say that you will pass it on. Reply with only the message text—no labels, markdown, or explanation.`;
function assistantInstructions(value){return String(value||'').trim()||defaultAssistantInstructions;}

// n8n's current public API updates a credential in place with PATCH. Keeping
// this account-scoped credential ID stable avoids creating a new credential
// every time the proxy URL or API key is saved. Older n8n versions that do
// not expose PATCH use the replacement fallback below.
async function syncN8nLlmCredential(connection,n8nApiKey,config){
  const name=`Gakai LLM Proxy – ${config.accountId}`;
  const body={name,type:'openAiApi',data:{apiKey:config.apiKey,url:config.baseUrl},isPartialData:false};
  try{
    await n8nRequest(connection.n8nUrl,n8nApiKey,`/credentials/${encodeURIComponent(connection.llmCredentialId)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {id:String(connection.llmCredentialId),name,replacedCredentialId:null};
  }catch(error){
    // A credential can be removed directly in n8n. Create a replacement
    // only in that case (or on legacy n8n without PATCH), then store its ID.
    if(![404,405].includes(error.status))throw error;
    const replacement=await n8nRequest(connection.n8nUrl,n8nApiKey,'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {id:String(replacement.id),name:replacement.name||name,replacedCredentialId:String(connection.llmCredentialId)};
  }
}

// Builds the node/connection graph for one Gakai-managed n8n workflow:
// Webhook -> [Set | AI Agent] -> Respond to Webhook.
//
// The workflow replies by responding synchronously to the same inbound
// webhook call Gakai already made to deliver the message — n8n's Webhook
// node holds the HTTP connection open (responseMode: 'responseNode') until
// the "Respond to Webhook" node runs, and its JSON body becomes the
// response Gakai reads back. This deliberately avoids an *outbound* call
// from n8n back into Gakai's own API: that direction requires n8n to know
// an address for Gakai, and there is no address Gakai can hand it that's
// guaranteed reachable — not a LAN IP, not a `.local` hostname, not even
// 127.0.0.1 (which from n8n's own process always means n8n's own host, never
// Gakai's). Gakai is always the one making the request here, and it already
// knows how to reach the WhatsApp provider — so only Gakai ever needs to
// know an address, regardless of whether n8n runs on the same machine, the
// same LAN, or n8n Cloud on the other side of the world.
function buildN8nWorkflowGraph({kind,webhookPath,inboundCred,accountLlm,llmCred,systemPrompt}){
  const webhookNodeId=makeUUID(),middleNodeId=makeUUID(),respondNodeId=makeUUID(),llmNodeId=makeUUID();
  const webhookNode={
    id:webhookNodeId,
    name:'Webhook',
    type:'n8n-nodes-base.webhook',
    typeVersion:2.1,
    position:[250,300],
    parameters:{httpMethod:'POST',path:webhookPath,authentication:'headerAuth',responseMode:'responseNode',options:{}},
    credentials:{httpHeaderAuth:{id:String(inboundCred.id),name:inboundCred.name}}
  };
  const respondNode={
    id:respondNodeId,
    name:'Respond to Webhook',
    type:'n8n-nodes-base.respondToWebhook',
    typeVersion:1.4,
    position:[1000,300],
    parameters:{
      respondWith:'json',
      responseBody:"={{ { reply: $json.output || $json.reply || $json.text || $json.message_body || '' } }}"
    }
  };
  let nodes,connections;
  if(accountLlm){
    const agentNode={
      id:middleNodeId,
      name:'AI Agent',
      type:'@n8n/n8n-nodes-langchain.agent',
      typeVersion:3.1,
      position:[625,300],
      parameters:{
        promptType:'define',
        text:"={{ $('Webhook').item.json.body.message.body || $('Webhook').item.json.body.message.text || '' }}",
        options:{systemMessage:systemPrompt}
      }
    };
    const llmNode={
      id:llmNodeId,
      name:'OpenAI Chat Model',
      type:'@n8n/n8n-nodes-langchain.lmChatOpenAi',
      typeVersion:1.3,
      position:[625,500],
      // n8n 1.3 defaults this node to the newer Responses API when the
      // setting is omitted. Gakai proxies use OpenAI Chat Completions, so
      // make the compatible mode explicit for both new and repaired flows.
      parameters:{model:{__rl:true,mode:'list',value:accountLlm.model},responsesApiEnabled:false,options:{}},
      credentials:{openAiApi:{id:String(llmCred.id),name:llmCred.name}}
    };
    nodes=[webhookNode,agentNode,llmNode,respondNode];
    connections={Webhook:{main:[[{node:'AI Agent',type:'main',index:0}]]},'OpenAI Chat Model':{ai_languageModel:[[{node:'AI Agent',type:'ai_languageModel',index:0}]]},'AI Agent':{main:[[{node:'Respond to Webhook',type:'main',index:0}]]}};
  }else{
    const setNode={
      id:middleNodeId,
      name:'Set',
      type:'n8n-nodes-base.set',
      typeVersion:3.4,
      position:[625,300],
      parameters:{
        assignments:{assignments:[
          {id:makeUUID(),name:'message_body',type:'string',value:"={{ $('Webhook').item.json.body.message.body || $('Webhook').item.json.body.message.text || '' }}"}
        ]},
        options:{}
      }
    };
    nodes=[webhookNode,setNode,respondNode];
    connections={Webhook:{main:[[{node:'Set',type:'main',index:0}]]},Set:{main:[[{node:'Respond to Webhook',type:'main',index:0}]]}};
  }
  return {nodes,connections};
}

// Upgrades an already-created workflow still using the old outbound
// "Send Reply" HTTP node to the current synchronous-response shape, reusing
// its existing inbound credential and (for the agentic kind) LLM credential
// so nothing needs re-authorizing. A no-op if the workflow already has no
// Send Reply node. Cleans up the now-orphaned outbound bearer credential.
async function repairN8nWorkflowGraph(n8nUrl,n8nApiKey,connection,accountId){
  const workflow=await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${encodeURIComponent(connection.workflowId)}`);
  const webhookNode=workflow?.nodes?.find(node=>node.name==='Webhook'&&node.type==='n8n-nodes-base.webhook');
  const oldHttpNode=workflow?.nodes?.find(node=>node.name==='Send Reply'&&node.type==='n8n-nodes-base.httpRequest');
  if(!webhookNode||!oldHttpNode)return false;
  const inboundCred=webhookNode.credentials?.httpHeaderAuth;
  if(!inboundCred?.id)return false;
  const accountLlm=connection.kind==='agentic'?llmConfig(accountId):null;
  let llmCred=null;
  if(accountLlm){
    const modelNode=workflow.nodes.find(node=>node.name==='OpenAI Chat Model'&&node.type==='@n8n/n8n-nodes-langchain.lmChatOpenAi');
    llmCred=modelNode?.credentials?.openAiApi;
    if(!llmCred?.id)return false;
  }
  const {nodes,connections}=buildN8nWorkflowGraph({
    kind:connection.kind,
    webhookPath:webhookNode.parameters?.path,
    inboundCred,
    accountLlm,
    llmCred,
    systemPrompt:accountLlm?assistantInstructions(accountLlm.systemPrompt):undefined
  });
  await n8nRequest(n8nUrl,n8nApiKey,`/workflows/${encodeURIComponent(connection.workflowId)}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:workflow.name,nodes,connections,settings:workflow.settings||{executionOrder:'v1'}})});
  await publishN8nWorkflow(n8nUrl,n8nApiKey,connection.workflowId);
  if(oldHttpNode.credentials?.httpBearerAuth?.id)await deleteN8nCredentialQuietly(n8nUrl,n8nApiKey,oldHttpNode.credentials.httpBearerAuth.id);
  return true;
}

// Keep Gakai's LLM settings and the generated n8n AI Agent in lockstep.
// We fetch first so any customer edits to other workflow nodes remain intact.
async function syncAgenticN8nInstructions(accountId,config,{workflowId:requestedWorkflowId}={}){
  const connection=store.n8nConnections.find(item=>item.accountId===accountId&&item.kind==='agentic');
  if(!connection)return {synced:false,agentExampleAdded:false};
  const n8nApiKey=decryptSecret(connection.n8nApiKeyEncrypted);
  if(!n8nApiKey)throw new Error('Reauthorize n8n before updating the AI Agent settings');
  const workflowId=requestedWorkflowId||connection.workflowId;
  const retargeted=workflowId!==connection.workflowId;
  if(!retargeted&&!(await n8nWorkflowExists(connection.n8nUrl,n8nApiKey,workflowId))){
    const rebuilt=await recreateMissingN8nWorkflow(connection,accountId);
    return {synced:true,agentExampleAdded:false,recreated:true,workflowId:rebuilt.workflowId};
  }
  // Upgrade a legacy workflow shape (the old direct-callback Send Reply
  // node) before touching anything else, so the fetch below sees the
  // current node names.
  if(!retargeted)await repairN8nWorkflowGraph(connection.n8nUrl,n8nApiKey,connection,accountId).catch(error=>console.error('Failed to upgrade n8n AI Agent workflow shape:',error.message));
  const workflow=await n8nRequest(connection.n8nUrl,n8nApiKey,`/workflows/${encodeURIComponent(workflowId)}`);
  if(!workflow?.id||!Array.isArray(workflow.nodes))throw new Error('The selected n8n workflow could not be loaded');
  const webhook=workflow.nodes.find(node=>node.type==='n8n-nodes-base.webhook');
  const webhookPath=String(webhook?.parameters?.path||'').replace(/^\/+|\/+$/g,'');
  if(!webhookPath)throw new Error('The selected workflow needs a Webhook node with a path before Gakai can route messages to it');
  let agent=workflow.nodes.find(node=>node.name==='AI Agent'&&node.type==='@n8n/n8n-nodes-langchain.agent');
  let model=workflow.nodes.find(node=>node.name==='OpenAI Chat Model'&&node.type==='@n8n/n8n-nodes-langchain.lmChatOpenAi');
  if(!connection.llmCredentialId)throw new Error('The generated n8n LLM credential could not be found. Recreate the AI workflow before saving settings.');
  const credential=await syncN8nLlmCredential(connection,n8nApiKey,config);
  let agentExampleAdded=false;
  if(!agent||!model){
    // A user-selected workflow keeps all of its nodes and main-flow links.
    // This is an intentionally disconnected example: the user decides where
    // their own workflow should connect it.
    agentExampleAdded=true;
    if(!agent){agent={id:makeUUID(),name:'AI Agent',type:'@n8n/n8n-nodes-langchain.agent',typeVersion:3.1,position:[625,300],parameters:{promptType:'define',text:"={{ $('Webhook').item.json.body.message.body || $('Webhook').item.json.body.message.text || '' }}",options:{systemMessage:assistantInstructions(config.systemPrompt)}}};workflow.nodes.push(agent);}
    if(!model){model={id:makeUUID(),name:'OpenAI Chat Model',type:'@n8n/n8n-nodes-langchain.lmChatOpenAi',typeVersion:1.3,position:[625,500],parameters:{model:{__rl:true,mode:'list',value:config.model},responsesApiEnabled:false,options:{}},credentials:{openAiApi:{id:credential.id,name:credential.name}}};workflow.nodes.push(model);}
    const modelLinks=workflow.connections?.[model.name]?.ai_languageModel||[];
    if(!modelLinks.some(branch=>branch.some(link=>link.node===agent.name&&link.type==='ai_languageModel')))workflow.connections={...(workflow.connections||{}),[model.name]:{...(workflow.connections?.[model.name]||{}),ai_languageModel:[...modelLinks,[{node:agent.name,type:'ai_languageModel',index:0}]]}};
  }
  agent.parameters={...(agent.parameters||{}),options:{...(agent.parameters?.options||{}),systemMessage:assistantInstructions(config.systemPrompt)}};
  model.parameters={...(model.parameters||{}),model:{...(typeof model.parameters?.model==='object'?model.parameters.model:{}),__rl:true,mode:'list',value:config.model},responsesApiEnabled:false};
  model.credentials={...(model.credentials||{}),openAiApi:{id:credential.id,name:credential.name}};
  await n8nRequest(connection.n8nUrl,n8nApiKey,`/workflows/${encodeURIComponent(workflowId)}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:workflow.name,nodes:workflow.nodes,connections:workflow.connections||{},settings:workflow.settings||{executionOrder:'v1'}})});
  await publishN8nWorkflow(connection.n8nUrl,n8nApiKey,workflowId);
  if(retargeted){
    connection.workflowId=String(workflow.id);connection.workflowName=workflow.name||String(workflow.id);connection.webhookUrl=`${connection.n8nUrl}/webhook/${webhookPath}`;
    const subscription=store.automationSubscriptions.find(item=>item.accountId===accountId&&item.name==='n8n auto-connect (AI Agent)');
    if(subscription){subscription.url=connection.webhookUrl;subscription.productionUrl=connection.webhookUrl;}
  }
  connection.llmCredentialId=credential.id;
  if(credential.replacedCredentialId)await deleteN8nCredentialQuietly(connection.n8nUrl,n8nApiKey,credential.replacedCredentialId);
  return {synced:true,agentExampleAdded,retargeted};
}

// Builds one n8n workflow (Webhook -> [Set | AI Agent] -> Respond to Webhook)
// and its dedicated credentials. Used both for the initial n8n connect and
// for creating the paired AI Agent workflow once LiteLLM is configured.
// Never mutates an existing n8n workflow; each call creates a brand-new one.
async function createN8nWorkflow({n8nBaseUrl,n8nApiKey,accountId,kind,existingConnection=null}){
  const inboundSecret=existingConnection?.inboundSecret||'gs_inbound_'+randomBytes(24).toString('base64url');
  let inboundCred=null,llmCred=null,workflow=null,inboundCredentialCreated=false,llmCredentialCreated=false;
  try{
    const inboundName=`Gakai Inbound Secret – ${accountId}${kind==='agentic'?' (AI Agent)':''}`;
    if(existingConnection?.inboundCredentialId&&await n8nCredentialExists(n8nBaseUrl,n8nApiKey,existingConnection.inboundCredentialId))inboundCred={id:existingConnection.inboundCredentialId,name:inboundName};
    else {inboundCredentialCreated=true;inboundCred=await n8nRequest(n8nBaseUrl,n8nApiKey,'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:inboundName,type:'httpHeaderAuth',data:{name:'X-Gakai-Secret',value:inboundSecret}})});}

    const webhookPath='gakai-'+accountId.replace(/[^a-z0-9]/gi,'-').toLowerCase().slice(0,24)+(kind==='agentic'?'-ai':'');
    const accountLabel=store.accountLabels[accountId]||provider.getAccount(accountId)?.profile||accountId;
    const workflowName=`Gakai – ${accountLabel}${kind==='agentic'?' (AI Agent)':''}`;
    const accountLlm=kind==='agentic'?llmConfig(accountId):null;
    if(accountLlm){
      // n8n's OpenAI credential uses `url` for an OpenAI-compatible base endpoint.
      if(existingConnection?.llmCredentialId)llmCred=await syncN8nLlmCredential(existingConnection,n8nApiKey,accountLlm);
      else {llmCredentialCreated=true;llmCred=await n8nRequest(n8nBaseUrl,n8nApiKey,'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:`Gakai LLM Proxy – ${accountId}`,type:'openAiApi',data:{apiKey:accountLlm.apiKey,url:accountLlm.baseUrl}})});}
    }
    const {nodes,connections}=buildN8nWorkflowGraph({
      kind,
      webhookPath,
      inboundCred,
      accountLlm,
      llmCred,
      systemPrompt:accountLlm?assistantInstructions(accountLlm.systemPrompt):undefined
    });

    const workflowBody={name:workflowName,nodes,connections,settings:{executionOrder:'v1'}};
    workflow=await n8nRequest(n8nBaseUrl,n8nApiKey,'/workflows',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(workflowBody)});
    if(!workflow?.id||!workflow?.nodes?.length)throw new Error('n8n created an incomplete workflow. Please try again.');

    const workflowId=String(workflow.id);
    let activationWarning=null;
    try{await publishN8nWorkflow(n8nBaseUrl,n8nApiKey,workflowId);}
    catch(err){activationWarning=err.message||'Workflow publish failed';console.error('n8n workflow publish failed:',err.message);}

    return {
      workflowId,workflowName,
      webhookUrl:`${n8nBaseUrl}/webhook/${webhookPath}`,
      inboundSecret,activationWarning,
      inboundCredentialId:String(inboundCred.id),llmCredentialId:llmCred?String(llmCred.id):null,
      agentic:Boolean(accountLlm)
    };
  }catch(err){
    await deleteN8nWorkflowQuietly(n8nBaseUrl,n8nApiKey,workflow?.id);
    if(llmCredentialCreated)await deleteN8nCredentialQuietly(n8nBaseUrl,n8nApiKey,llmCred?.id);
    if(inboundCredentialCreated)await deleteN8nCredentialQuietly(n8nBaseUrl,n8nApiKey,inboundCred?.id);
    throw err;
  }
}

async function recreateMissingN8nWorkflow(connection,accountId){
  const n8nApiKey=decryptSecret(connection.n8nApiKeyEncrypted);
  if(!n8nApiKey)throw new Error('Reauthorize n8n before recreating its workflow');
  const built=await createN8nWorkflow({n8nBaseUrl:connection.n8nUrl,n8nApiKey,accountId,kind:connection.kind,existingConnection:connection});
  connection.workflowId=built.workflowId;connection.workflowName=built.workflowName;connection.webhookUrl=built.webhookUrl;
  connection.inboundCredentialId=built.inboundCredentialId;connection.llmCredentialId=built.llmCredentialId;connection.inboundSecret=built.inboundSecret;
  const subscription=store.automationSubscriptions.find(item=>item.accountId===accountId&&item.name===(connection.kind==='agentic'?'n8n auto-connect (AI Agent)':'n8n auto-connect'));
  if(subscription){subscription.url=built.webhookUrl;subscription.productionUrl=built.webhookUrl;subscription.secret=built.inboundSecret;}
  return built;
}

async function ensureN8nReplyWorkflow(accountId,kind){
  const connection=store.n8nConnections.find(item=>item.accountId===accountId&&item.kind===kind);
  if(!connection)throw Object.assign(new Error(`No ${kind==='agentic'?'AI Agent':'standard'} n8n workflow is configured`),{status:409});
  const n8nApiKey=decryptSecret(connection.n8nApiKeyEncrypted);
  if(!n8nApiKey)throw Object.assign(new Error('Reauthorize n8n before enabling replies'),{status:409});
  if(await n8nWorkflowExists(connection.n8nUrl,n8nApiKey,connection.workflowId)){await activateAndVerifyN8nWorkflow(connection.n8nUrl,n8nApiKey,connection.workflowId);return {connection,recreated:false};}
  const built=await recreateMissingN8nWorkflow(connection,accountId);
  await activateAndVerifyN8nWorkflow(connection.n8nUrl,n8nApiKey,built.workflowId);
  return {connection,recreated:true,built};
}

// Creates the paired AI Agent workflow for an account that already has a
// standard n8n connection, reusing the same n8n instance/API key on file.
// Leaves the existing standard workflow untouched. Routes live delivery to
async function createAgenticN8nWorkflow(accountId){
  const standard=store.n8nConnections.find(c=>c.accountId===accountId&&c.kind==='standard');
  if(!standard)throw Object.assign(new Error('No existing n8n integration is available'),{status:409});
  if(store.n8nConnections.some(c=>c.accountId===accountId&&c.kind==='agentic'))throw Object.assign(new Error('The AI workflow already exists'),{status:409});
  const n8nApiKey=decryptSecret(standard.n8nApiKeyEncrypted);
  if(!n8nApiKey)throw Object.assign(new Error('Reauthorize the existing n8n integration with its API key before creating an AI workflow'),{status:409});
  // Verify the stored n8n connection before creating anything.
  await n8nRequest(standard.n8nUrl,n8nApiKey,'/workflows?limit=1');
  const built=await createN8nWorkflow({n8nBaseUrl:standard.n8nUrl,n8nApiKey,accountId,kind:'agentic'});
  const connectedAt=new Date().toISOString();
  // The generated AI workflow is deliberately isolated: it receives no live
  // events until a later explicit activation step, and never alters the
  // existing n8n workflow or its automation subscription.
  store.automationSubscriptions=store.automationSubscriptions.filter(item=>!(item.accountId===accountId&&item.name==='n8n auto-connect (AI Agent)'));
  store.automationSubscriptions.push({id:randomBytes(8).toString('hex'),accountId,name:'n8n auto-connect (AI Agent)',url:built.webhookUrl,productionUrl:built.webhookUrl,testUrl:null,testPhone:null,enabled:false,events:['message.received'],secret:built.inboundSecret,createdAt:connectedAt,lastDelivery:null});
  store.n8nConnections.push({accountId,kind:'agentic',n8nUrl:standard.n8nUrl,n8nApiKeyEncrypted:standard.n8nApiKeyEncrypted,workflowId:built.workflowId,workflowName:built.workflowName,webhookUrl:built.webhookUrl,inboundCredentialId:built.inboundCredentialId,llmCredentialId:built.llmCredentialId,inboundSecret:built.inboundSecret,connectedAt});
  await persist();
  return built;
}
async function llmChat(config,messages){
  // allowPrivate: an admin-configured LLM proxy is trusted input, and a
  // self-hosted proxy on a private/local address is an expected setup here
  // (unlike Instagram/link-preview URLs) — still resolve-once-and-pin to
  // close the DNS-rebind gap without rejecting private targets.
  const response=await fetchPinned(llmChatCompletionsUrl(config.baseUrl),{allowPrivate:true,method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${config.apiKey}`},body:JSON.stringify(llmRequestBody(config,messages)),signal:AbortSignal.timeout(30000)});
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{throw new Error('LLM proxy returned invalid JSON')}
  if(!response.ok)throw new Error(data?.error?.message||data?.message||`LLM proxy error ${response.status}`);
  return data?.choices?.[0]?.message?.content||'';
}
async function dispatchLLMReply(accountId,event){
  const config=llmConfig(accountId);if(!config||!config.nativeEnabled)return;
  const chatId=event.chat?.id;const userText=event.message?.body||event.message?.text||'';if(!chatId||!userText)return;
  const systemPrompt=assistantInstructions(config.systemPrompt);
  try{
    const reply=await llmChat(config,[{role:'system',content:systemPrompt},{role:'user',content:userText}]);
    if(!reply.trim())return;
    await provider.sendText(accountId,chatId,reply.trim());
  }catch(err){console.error('Native LLM reply failed:',err.message);}
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
    view={...view,body:resolveMentionLabels(body,labels),text:resolveMentionLabels(body,labels),replyTo:view.replyTo?{...view.replyTo,body:resolveMentionLabels(replyBody,labels)}:view.replyTo};
  }
  return view;
}
  if(url.pathname.startsWith('/api/integrations/v1/')){
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const key=store.keys.find(k=>equalHex(k.hash,hash(token)));
    if(!key)return send(res,401,{message:'Invalid integration key'});key.lastUsedAt=new Date().toISOString();persist();
    const endpoint=url.pathname.slice('/api/integrations/v1/'.length);
    if(req.method==='GET'&&endpoint==='chats'&&key.scopes.includes('messages:read')){const chats=await provider.getChatsOverview(key.accountId);return send(res,200,{accountId:key.accountId,chats:chats.slice(0,35).sort((a,b)=>b.timestamp-a.timestamp)});}
    if(req.method==='GET'&&endpoint==='messages'&&key.scopes.includes('messages:read')){const chatId=url.searchParams.get('chatId');if(!chatId)return send(res,400,{message:'chatId is required'});const messages=await provider.getMessages(key.accountId,chatId,{limit:30});return send(res,200,{messages:messages.sort((a,b)=>a.timestamp-b.timestamp)});}
    if(req.method==='POST'&&endpoint==='messages'&&key.scopes.includes('messages:send')){const input=await readBody(req);if(!input.chatId||!input.text)return send(res,400,{message:'chatId and text are required'});const sent=await provider.sendText(key.accountId,input.chatId,input.text);return send(res,200,{message:sent});}
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
  if(url.pathname==="/api/app/auth/login"&&req.method==="POST"){const {username,password,remember}=await readBody(req);const expectedUsername=store.username;if(!store.password||(expectedUsername&&String(username||"").trim()!==expectedUsername)||!passwordMatches(password||""))return send(res,401,{message:"Incorrect username or password"});const token=issueSession(remember);res.writeHead(200,{"set-cookie":sessionCookie(token,Boolean(remember)),"content-type":"application/json"});return res.end(JSON.stringify({ok:true}));}
  if(url.pathname==="/api/app/auth/logout"&&req.method==="POST"){const token=cookie(req).home_session;sessions.delete(token);res.writeHead(200,{"set-cookie":"home_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0","content-type":"application/json"});return res.end(JSON.stringify({ok:true}));}
  if(url.pathname==="/api/app/auth/profile"&&req.method==="GET"){if(!admin(req))return send(res,401,{message:"Sign in required"});return send(res,200,{username:store.username||null});}
  if(url.pathname==="/api/app/auth/profile"&&req.method==="PATCH"){if(!admin(req))return send(res,401,{message:"Sign in required"});const input=await readBody(req),username=String(input.username||"").trim(),currentPassword=String(input.currentPassword||"");if(!currentPassword||!passwordMatches(currentPassword))return send(res,401,{message:"Current password is incorrect"});if(username&&(username.length<3||username.length>40))return send(res,400,{message:"Use a username between 3 and 40 characters"});if(input.newPassword&&String(input.newPassword).length<10)return send(res,400,{message:"Use a password with at least 10 characters"});if(username)store.username=username;
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
    res.writeHead(200,headers);return res.end(JSON.stringify({ok:true,username:store.username}));
  }
  if(!admin(req))return send(res,401,{message:'Sign in required'});
  if(req.method==='GET'&&url.pathname==='/api/app/events'){
    const accountId=String(url.searchParams.get('accountId')||'');
    if(!accountId)return send(res,400,{message:'accountId is required'});
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
    const rows=skipHistory?[]:(after
      ?db.prepare('SELECT id,payload FROM app_events WHERE account_id=? AND created_at>? ORDER BY created_at ASC LIMIT 250').all(accountId,after)
      :db.prepare('SELECT id,payload FROM app_events WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(accountId).reverse());
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});
    res.write(': connected\n\n');
    for(const row of rows){try{writeSseEvent(res,JSON.parse(row.payload),row.id)}catch{}}
    const stream={res,accountId};liveEventStreams.add(stream);
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
  if (req.method==="DELETE" && parts.length===4) {await provider.deleteAccount(id).catch(()=>null);delete store.accountLabels[id];store.n8nConnections=(store.n8nConnections||[]).filter(item=>item.accountId!==id);store.llmConfigs=(store.llmConfigs||[]).filter(item=>item.accountId!==id);store.automationSubscriptions=(store.automationSubscriptions||[]).filter(item=>item.accountId!==id);store.keys=(store.keys||[]).filter(item=>item.accountId!==id);await persist();return send(res,200,{ok:true});}
  if (req.method==='GET' && parts[4]==='qr') return send(res,200,(await provider.getQr(id))||{});
  if (req.method==='POST' && parts[4]==='start') {await provider.startAccount(id,{label:store.accountLabels[id]}); return send(res,200,{ok:true});}
  if (req.method==='POST' && parts[4]==='restart') {await provider.restartAccount(id); return send(res,200,{ok:true});}
  if(req.method==='POST'&&parts[4]==='chats'&&parts[5]&&parts[6]==='read'){await provider.markChatRead(id,decodeURIComponent(parts[5]));return send(res,200,{ok:true});}
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
    const chats=await provider.getChatsOverview(id);
    const wantArchived=url.searchParams.get('archived')==='1';
    if(wantArchived){
      const archived=chats.filter(chat=>chat.archived&&hasMessageContent(chat)).sort((a,b)=>chatTimestamp(b)-chatTimestamp(a)).slice(0,inboxChatLimit);
      return send(res,200,(await mapWithConcurrency(archived,8,chat=>enrichChatOverview(id,chat,{pictures:false}))).sort((a,b)=>b.timestamp-a.timestamp));
    }
    const recencyFloor=Math.floor((Date.now()-inboxRecencyMs)/1000);
    // Archived chats drop out of the main list; pinned chats stay regardless of
    // how old their last message is, and sort above everything else.
    const recent=chats.filter(chat=>!chat.archived&&hasMessageContent(chat)&&(chat.pinned||chatTimestamp(chat)>=recencyFloor)).sort((a,b)=>chatTimestamp(b)-chatTimestamp(a)).slice(0,inboxChatLimit);
    // pictures:false — the list must not block on a burst of avatar lookups;
    // the client hydrates them separately via /chats/pictures.
    const enriched=await mapWithConcurrency(recent,8,chat=>enrichChatOverview(id,chat,{pictures:false}));
    return send(res,200,enriched.sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0)||b.timestamp-a.timestamp));
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
  if(parts[4]==="integration-keys"&&parts[5]==="n8n"&&req.method==="GET"){const key=store.keys.find(k=>k.accountId===id&&k.name==="n8n integration");return send(res,200,{token:key?.token||null});}
  if(parts[4]==="integration-keys"&&parts[5]==="n8n"&&req.method==="POST"){let key=store.keys.find(k=>k.accountId===id&&k.name==="n8n integration");const token=`wh_live_${randomBytes(24).toString("base64url")}`;if(key){key.token=token;key.hash=hash(token);key.lastUsedAt=null}else{key={id:randomBytes(8).toString("hex"),accountId:id,name:"n8n integration",scopes:["messages:read","messages:send"],createdAt:new Date().toISOString(),lastUsedAt:null,token,hash:hash(token)}}store.keys=store.keys.filter(item=>item===key||!(item.accountId===id&&item.name==="n8n integration"));store.keys.push(key);await persist();return send(res,200,{token});}
  if(parts[4]==="integration-keys"&&req.method==="GET")return send(res,200,{keys:store.keys.filter(k=>k.accountId===id).map(({hash,token,...key})=>key)});
  if(parts[4]==="integration-keys"&&req.method==="POST"){const input=await readBody(req);const token=`wh_live_${randomBytes(24).toString("base64url")}`;const key={id:randomBytes(8).toString("hex"),accountId:id,name:String(input.name||"Integration").slice(0,80),scopes:Array.isArray(input.scopes)?input.scopes:["messages:read","messages:send"],createdAt:new Date().toISOString(),lastUsedAt:null,hash:hash(token)};store.keys.push(key);await persist();return send(res,201,{key:{...key,hash:undefined},token});}
  if(parts[4]==="automations"&&req.method==="GET")return send(res,200,{subscriptions:store.automationSubscriptions.filter(subscription=>subscription.accountId===id).map(automationSummary)});
  if(parts[4]==="automations"&&parts[5]==="test-delivery"&&req.method==="POST"){const input=await readBody(req),url=await n8nWebhookUrl(input.url||""),secret=String(input.secret||"").trim();if(!url)return send(res,400,{message:"Use the public HTTPS n8n test webhook URL"});if(!secret||secret.length>256)return send(res,400,{message:"Enter the Header Auth secret"});const event={id:`evt_test_${randomBytes(8).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id},chat:{id:"demo@s.whatsapp.net",kind:"direct"},message:{id:"demo-message",timestamp:Math.floor(Date.now()/1000),fromMe:false,body:"This is a Gakai test event.",text:"This is a Gakai test event.",hasMedia:false,media:null},source:"test"};try{const response=await automationFetch({secret,url:url.href},event);if(!response.ok)return send(res,502,{message:await describeWebhookFailure(response)});return send(res,200,{ok:true})}catch(error){return send(res,502,{message:error.message||"Test delivery failed"})}}
  if(parts[4]==="automations"&&!parts[5]&&req.method==="POST"){const input=await readBody(req),production=await n8nWebhookUrl(input.productionUrl||input.url||""),test=await n8nWebhookUrl(input.testUrl||""),requestedSecret=String(input.secret||"").trim();if(!production)return send(res,400,{message:"Use an HTTPS n8n production webhook URL"});if(input.testUrl&&!test)return send(res,400,{message:"Use an HTTPS n8n test webhook URL"});if(requestedSecret.length>256)return send(res,400,{message:"Invalid Header Auth secret"});const subscription={id:randomBytes(8).toString("hex"),accountId:id,name:String(input.name||"n8n automation").trim().slice(0,80)||"n8n automation",url:production.href,productionUrl:production.href,testUrl:test?.href||null,testPhone:String(input.testPhone||"").replace(/[^0-9]/g,"")||null,enabled:true,events:["message.received"],secret:requestedSecret||ensureN8nKey(id),createdAt:new Date().toISOString(),lastDelivery:null};store.automationSubscriptions=store.automationSubscriptions.filter(item=>item.accountId!==id);store.automationSubscriptions.push(subscription);await persist();return send(res,201,{subscription:automationSummary(subscription),secret:subscription.secret});}
  if(parts[4]==="automations"&&parts[5]&&req.method==="PATCH"){
    const subscription=store.automationSubscriptions.find(item=>item.id===parts[5]&&item.accountId===id);
    if(!subscription)return send(res,404,{message:"Automation not found"});
    const input=await readBody(req);let aiRepliesDisabled=false,aiWorkflowUnpublished=false,aiWorkflowMissing=false,standardWorkflowRecreated=false,n8nWorkflowsDeactivated=false;
    if(typeof input.enabled==="boolean"){
      const isN8nReply=['n8n auto-connect','n8n auto-connect (AI Agent)'].includes(subscription.name);
      if(input.enabled&&subscription.name==='n8n auto-connect'){
        try{standardWorkflowRecreated=(await ensureN8nReplyWorkflow(id,'standard')).recreated;const result=await unpublishOtherN8nReplyWorkflow(id,'standard');aiWorkflowUnpublished=result.unpublished;aiWorkflowMissing=result.missing;}catch(error){return send(res,error.status||502,{message:'Failed to prepare standard n8n workflow: '+(error.message||'Unknown error')});}
        subscription.enabled=true;const agent=store.automationSubscriptions.find(item=>item.accountId===id&&item.name==='n8n auto-connect (AI Agent)');if(agent?.enabled){agent.enabled=false;aiRepliesDisabled=true;}const config=llmConfig(id);if(config?.nativeEnabled){config.nativeEnabled=false;aiRepliesDisabled=true;}
      }else if(!input.enabled&&isN8nReply){
        const otherName=subscription.name==='n8n auto-connect'?'n8n auto-connect (AI Agent)':'n8n auto-connect';
        const other=store.automationSubscriptions.find(item=>item.accountId===id&&item.name===otherName);
        if(!other?.enabled){try{await deactivateN8nReplyWorkflows(id);n8nWorkflowsDeactivated=true;}catch(error){return send(res,error.status||502,{message:'Failed to deactivate n8n workflows: '+(error.message||'Unknown error')});}}
        subscription.enabled=false;
      }else subscription.enabled=input.enabled;
    }
    await persist();return send(res,200,{subscription:automationSummary(subscription),aiRepliesDisabled,aiWorkflowUnpublished,aiWorkflowMissing,standardWorkflowRecreated,n8nWorkflowsDeactivated});
  }
  if(parts[4]==="automations"&&parts[5]&&parts[6]==="test"&&req.method==="POST"){const subscription=store.automationSubscriptions.find(item=>item.id===parts[5]&&item.accountId===id);if(!subscription)return send(res,404,{message:"Automation not found"});const input=await readBody(req),phone=String(input.phone||subscription.testPhone||"").replace(/[^0-9]/g,"");if(phone.length>30)return send(res,400,{message:"Invalid test phone number"});const target=phone?`${phone}@s.whatsapp.net`:"demo@s.whatsapp.net",event={id:`evt_test_${randomBytes(8).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id},chat:{id:target,kind:"direct",phone:phone||null},message:{id:"demo-message",timestamp:Math.floor(Date.now()/1000),fromMe:false,body:String(input.text||"This is a Gakai test event."),text:String(input.text||"This is a Gakai test event."),hasMedia:false,media:null,sender:phone?{id:target,phone}:null},source:"test"};const destination=String(input.destination||"production")==="test"?subscription.testUrl:subscription.productionUrl||subscription.url;if(!destination)return send(res,400,{message:"This webhook URL is not configured"});
    // Route through the same delivery path production events use so this
    // test send updates subscription.lastDelivery like a real one does,
    // instead of the status vanishing after a hand-rolled fetch.
    try{const reply=await deliverAutomation(subscription,event,{url:destination});return send(res,200,{ok:true,reply,subscription:automationSummary(subscription)})}
    catch(error){return send(res,502,{message:error.message||"Test delivery failed",subscription:automationSummary(subscription)})}}
  if(parts[4]==="automations"&&parts[5]&&req.method==="DELETE"){store.automationSubscriptions=store.automationSubscriptions.filter(item=>!(item.id===parts[5]&&item.accountId===id));await persist();return send(res,200,{ok:true});}
  if(parts[4]==='integration-keys'&&req.method==='DELETE'){const keyId=parts[5];store.keys=store.keys.filter(k=>!(k.id===keyId&&k.accountId===id));await persist();return send(res,200,{ok:true});}
  // LLM proxy config endpoints
  if(parts[4]==='llm'&&parts[5]==='test'&&req.method==='POST'){
    const cfg=llmConfig(id),input=await readBody(req),prompt=String(input.prompt||'').trim();
    if(!cfg)return send(res,409,{message:'Save an LLM proxy before testing it'});
    if(!prompt||prompt.length>4000)return send(res,400,{message:'Enter a test prompt up to 4,000 characters'});
    const phone=String(input.phone||'').replace(/[^0-9]/g,'');
    if(phone.length>30)return send(res,400,{message:'Invalid test phone number'});
    let reply;
    try{reply=await llmChat(cfg,[{role:'system',content:cfg.systemPrompt||'You are a helpful assistant.'},{role:'user',content:prompt}]);}
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
  if(parts[4]==='llm'&&req.method==='GET'){const cfg=llmConfig(id);return send(res,200,cfg?{configured:true,provider:cfg.provider||inferLlmProvider(cfg.baseUrl),baseUrl:cfg.baseUrl,model:cfg.model,systemPrompt:cfg.systemPrompt||'',nativeEnabled:cfg.nativeEnabled||false,apiKeyLength:String(cfg.apiKey||'').length,apiKeyLast4:String(cfg.apiKey||'').slice(-4)}:{configured:false});}
  if(parts[4]==='llm'&&req.method==='POST'){
    const input=await readBody(req);
    let baseUrl=String(input.baseUrl||'').trim().replace(/\/+$/,'');
    const existing=llmConfig(id);
    // __keep__ means "don't change the stored API key" (used by the skill/settings update form)
    const apiKey=String(input.apiKey||'')==='__keep__'?(existing?.apiKey||''):String(input.apiKey||'').trim();
    const model=String(input.model||'').trim();
    if(!baseUrl)return send(res,400,{message:'Proxy URL is required'});
    const provider=inferLlmProvider(baseUrl,String(input.provider||''));
    try{baseUrl=normalizeLlmBaseUrl(baseUrl,provider)}catch{return send(res,400,{message:'Enter a valid proxy URL'});}
    if(!apiKey)return send(res,400,{message:'API key is required'});
    if(!model)return send(res,400,{message:'Model name is required'});
    // Skip connection test when only updating skill/settings (apiKey kept, baseUrl+model unchanged)
    const settingsOnly=String(input.apiKey||'')==='__keep__'&&existing&&existing.baseUrl===baseUrl&&existing.model===model;
    if(!settingsOnly){
      try{
        const test=await fetchPinned(llmChatCompletionsUrl(baseUrl),{allowPrivate:true,method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},body:JSON.stringify(llmRequestBody({model},[{role:'user',content:'hi'}],{max_tokens:1})),signal:AbortSignal.timeout(15000)});
        const td=await test.json().catch(()=>({}));
        if(!test.ok&&test.status!==400)throw new Error(td?.error?.message||`Proxy returned ${test.status}`);
      }catch(err){return send(res,400,{message:'Could not connect to LLM proxy: '+err.message});}
    }
    // nativeEnabled is managed by its own immediate PATCH /llm toggle below,
    // not this form — preserve whatever it's currently set to rather than
    // reading a stale/absent field from this save.
    const nextConfig={accountId:id,provider,baseUrl,apiKey,model,systemPrompt:assistantInstructions(String(input.systemPrompt||'').slice(0,4000)),nativeEnabled:existing?.nativeEnabled||false,configuredAt:existing?.configuredAt||new Date().toISOString()};
    const requestedWorkflowId=String(input.n8nWorkflowId||'').trim();
    if(requestedWorkflowId.length>120)return send(res,400,{message:'The n8n workflow ID is too long'});
    let n8nSync={synced:false,agentExampleAdded:false};
    try{n8nSync=await syncAgenticN8nInstructions(id,nextConfig,{workflowId:requestedWorkflowId||undefined});}catch(error){return send(res,502,{message:'LLM proxy verified, but the n8n AI workflow was not updated: '+(error.message||'Unknown error')});}
    store.llmConfigs=store.llmConfigs.filter(c=>c.accountId!==id);
    store.llmConfigs.push(nextConfig);
    await persist();
    return send(res,200,{ok:true,n8nInstructionsSynced:n8nSync.synced,n8nAgentExampleAdded:n8nSync.agentExampleAdded,n8nWorkflowRetargeted:n8nSync.retargeted||false});
  }
  // Immediate "Enable native AI replies" toggle — mirrors /n8n/connect/ai's
  // immediacy so both mutually-exclusive reply paths behave the same way
  // (no need to resubmit the whole proxy form just to flip this).
  if(parts[4]==='llm'&&parts[5]==='native'&&req.method==='PATCH'){
    const config=llmConfig(id);
    if(!config)return send(res,404,{message:'Save an LLM proxy before enabling native replies'});
    const input=await readBody(req);
    const nativeEnabled=Boolean(input.nativeEnabled);
    let agentRepliesDisabled=false,standardRepliesDisabled=false,n8nWorkflowsDeactivated=false;
    if(nativeEnabled){
      // Do the remote operation before changing local routing. If n8n rejects
      // the request, leave the current reply path intact instead of claiming
      // native mode is safe while a workflow may still be published.
      try{await deactivateN8nReplyWorkflows(id);n8nWorkflowsDeactivated=true;}
      catch(error){return send(res,error.status||502,{message:'Could not deactivate the n8n reply workflows: '+(error.message||'Unknown error')});}
      agentRepliesDisabled=hasEnabledAgenticN8n(id);
      standardRepliesDisabled=disableStandardN8nReplies(id);
      disableTheOtherAiReplyPath(id,'native');
    }
    config.nativeEnabled=nativeEnabled;
    await persist();
    return send(res,200,{ok:true,nativeEnabled:config.nativeEnabled,agentRepliesDisabled,standardRepliesDisabled,n8nWorkflowsDeactivated});
  }
  if(parts[4]==='llm'&&req.method==='DELETE'){store.llmConfigs=store.llmConfigs.filter(c=>c.accountId!==id);await persist();return send(res,200,{ok:true});}
  if(parts[4]==='n8n'&&parts[5]==='connect'&&!parts[6]&&req.method==='POST'){
    if(n8nConnectLocks.has(id))return send(res,409,{message:'A connection attempt is already in progress for this account'});
    const attempt=(async()=>{
      const input=await readBody(req);
      let n8nBaseUrl=normalizeN8nBaseUrl(input.n8nUrl);
      const existingStandard=store.n8nConnections.find(connection=>connection.accountId===id&&connection.kind==='standard');
      const requestedApiKey=String(input.n8nApiKey||'').trim();
      const n8nApiKey=requestedApiKey==='__keep__'?(decryptSecret(existingStandard?.n8nApiKeyEncrypted)||''):requestedApiKey;
      try{new URL(n8nBaseUrl)}catch{return send(res,400,{message:'Enter a valid n8n URL (e.g. https://yourname.app.n8n.cloud)'});}
      if(!n8nBaseUrl.startsWith('https://'))return send(res,400,{message:'The n8n URL must use HTTPS'});
      if(!n8nApiKey)return send(res,400,{message:'n8n API key is required'});
      try{await n8nRequest(n8nBaseUrl,n8nApiKey,'/workflows?limit=1')}catch(err){return send(res,400,{message:err.message||'Could not connect to n8n'});}
      if(existingStandard){
        existingStandard.n8nUrl=n8nBaseUrl;existingStandard.n8nApiKeyEncrypted=encryptSecret(n8nApiKey);
        const existingAgent=store.n8nConnections.find(connection=>connection.accountId===id&&connection.kind==='agentic');
        if(existingAgent){existingAgent.n8nUrl=n8nBaseUrl;existingAgent.n8nApiKeyEncrypted=encryptSecret(n8nApiKey);}
        const requestedWorkflowId=String(input.n8nWorkflowId||'').trim();
        if(requestedWorkflowId.length>120)return send(res,400,{message:'The n8n workflow ID is too long'});
        const retargeted=requestedWorkflowId&&requestedWorkflowId!==existingStandard.workflowId;
        if(retargeted){
          const workflow=await n8nRequest(n8nBaseUrl,n8nApiKey,`/workflows/${encodeURIComponent(requestedWorkflowId)}`);
          const webhook=workflow?.nodes?.find(node=>node.type==='n8n-nodes-base.webhook');
          const webhookPath=String(webhook?.parameters?.path||'').replace(/^\/+|\/+$/g,'');
          if(!workflow?.id||!webhookPath)return send(res,400,{message:'The selected workflow needs a Webhook node with a path before Gakai can route messages to it'});
          existingStandard.workflowId=String(workflow.id);existingStandard.workflowName=workflow.name||String(workflow.id);existingStandard.webhookUrl=`${n8nBaseUrl}/webhook/${webhookPath}`;
          const subscription=store.automationSubscriptions.find(item=>item.accountId===id&&item.name==='n8n auto-connect');
          if(subscription){subscription.url=existingStandard.webhookUrl;subscription.productionUrl=existingStandard.webhookUrl;}
        }
        let recreated=false,activationWarning=null;
        if(!retargeted&&!(await n8nWorkflowExists(n8nBaseUrl,n8nApiKey,existingStandard.workflowId))){
          const built=await recreateMissingN8nWorkflow(existingStandard,id);
          recreated=true;activationWarning=built.activationWarning;
        }
        // Reconnecting is also the repair path for a workflow still on the
        // old outbound-callback shape (see repairN8nWorkflowGraph) — fix it
        // in place rather than requiring the whole integration to be
        // deleted and recreated.
        if(!retargeted&&!recreated)try{await repairN8nWorkflowGraph(n8nBaseUrl,n8nApiKey,existingStandard,id);}catch(error){console.error('Failed to upgrade n8n workflow shape:',error.message);}
        await persist();return send(res,200,{ok:true,reused:!recreated,recreated,retargeted:Boolean(retargeted),workflowId:existingStandard.workflowId,workflowName:existingStandard.workflowName,workflowUrl:`${n8nBaseUrl}/workflow/${existingStandard.workflowId}`,activationWarning});
      }
      let built;
      try{ built=await createN8nWorkflow({n8nBaseUrl,n8nApiKey,accountId:id,kind:'standard'}); }
      catch(err){ return send(res,502,{message:'Failed to configure n8n: '+(err.message||'Unknown n8n error')}); }
      const connectedAt=new Date().toISOString();
      // Create/replace automation subscription (remove all for this account, then re-add the new one)
      store.automationSubscriptions=store.automationSubscriptions.filter(item=>item.accountId!==id);
      store.automationSubscriptions.push({id:randomBytes(8).toString('hex'),accountId:id,name:'n8n auto-connect',url:built.webhookUrl,productionUrl:built.webhookUrl,testUrl:null,testPhone:null,enabled:true,events:['message.received'],secret:built.inboundSecret,createdAt:connectedAt,lastDelivery:null});
      // Remove old connections for this account (both kinds) and start fresh with the standard workflow
      store.n8nConnections=store.n8nConnections.filter(c=>c.accountId!==id);
      store.n8nConnections.push({accountId:id,kind:'standard',n8nUrl:n8nBaseUrl,n8nApiKeyEncrypted:encryptSecret(n8nApiKey),workflowId:built.workflowId,workflowName:built.workflowName,webhookUrl:built.webhookUrl,inboundCredentialId:built.inboundCredentialId,llmCredentialId:built.llmCredentialId,inboundSecret:built.inboundSecret,connectedAt});
      await persist();
      return send(res,201,{ok:true,workflowId:built.workflowId,workflowName:built.workflowName,workflowUrl:`${n8nBaseUrl}/workflow/${built.workflowId}`,webhookUrl:built.webhookUrl,connectedAt,activationWarning:built.activationWarning});
    })();
    n8nConnectLocks.set(id,attempt);
    try{ return await attempt; } finally{ n8nConnectLocks.delete(id); }
  }
  // "Enable n8n AI Agent replies": creates the AI Agent workflow the first
  // time (this is the "later explicit activation step" the workflow was
  // deliberately left disabled for), or just re-activates and re-syncs an
  // existing one — idempotent either way, so the client only needs one
  // action for both "set it up" and "turn it back on".
  if(parts[4]==='n8n'&&parts[5]==='connect'&&parts[6]==='ai'&&req.method==='POST'){
    const lockKey=`${id}:agentic`;
    if(n8nConnectLocks.has(lockKey))return send(res,409,{message:'A connection attempt is already in progress for this account'});
    const attempt=(async()=>{
      const config=llmConfig(id);
      if(!config)return send(res,400,{message:'Connect an LLM proxy before enabling AI Agent replies'});
      try{
        let connection=store.n8nConnections.find(c=>c.accountId===id&&c.kind==='agentic');
        let activationWarning=null;
        if(!connection){
          const built=await createAgenticN8nWorkflow(id);
          activationWarning=built.activationWarning;
          connection=store.n8nConnections.find(c=>c.accountId===id&&c.kind==='agentic');
        }else{
          // Bring an already-existing workflow's instructions/model/shape
          // up to date before going live with it again.
          const synced=await syncAgenticN8nInstructions(id,config);
          if(synced.recreated)activationWarning='The missing AI Agent workflow was recreated.';
        }
        await ensureN8nReplyWorkflow(id,'agentic');
        let standardWorkflowUnpublished=false,standardWorkflowMissing=false;
        try{const result=await unpublishOtherN8nReplyWorkflow(id,'agentic');standardWorkflowUnpublished=result.unpublished;standardWorkflowMissing=result.missing;}
        catch(error){return send(res,error.status||502,{message:'Failed to unpublish standard n8n workflow: '+(error.message||'Unknown error')});}
        const subscription=store.automationSubscriptions.find(item=>item.accountId===id&&item.name==='n8n auto-connect (AI Agent)');
        if(subscription)subscription.enabled=true;
        // One inbound event has one automatic reply handler.
        disableTheOtherAiReplyPath(id,'agentic');
        const standardRepliesDisabled=disableStandardN8nReplies(id);
        await persist();
        return send(res,200,{ok:true,workflowId:connection.workflowId,workflowName:connection.workflowName,workflowUrl:`${connection.n8nUrl}/workflow/${connection.workflowId}`,activationWarning,standardRepliesDisabled,standardWorkflowUnpublished,standardWorkflowMissing});
      }catch(error){return send(res,error.status||502,{message:'Failed to enable n8n AI Agent replies: '+(error.message||'Unknown error')});}
    })();
    n8nConnectLocks.set(lockKey,attempt);
    try{ return await attempt; } finally{ n8nConnectLocks.delete(lockKey); }
  }
  if(parts[4]==='n8n'&&parts[5]==='connect'&&req.method==='GET'){
    const connections=store.n8nConnections.filter(c=>c.accountId===id);
    if(!connections.length)return send(res,200,{connected:false});
    const workflows=connections.map(connection=>{
      const subscription=store.automationSubscriptions.find(item=>item.accountId===id&&item.name===(connection.kind==='agentic'?'n8n auto-connect (AI Agent)':'n8n auto-connect'));
      return {kind:connection.kind,workflowId:connection.workflowId,workflowName:connection.workflowName,workflowUrl:`${connection.n8nUrl}/workflow/${connection.workflowId}`,webhookUrl:connection.webhookUrl||subscription?.url||null,subscriptionId:subscription?.id||null,active:subscription?.enabled!==false,lastDelivery:subscription?.lastDelivery||null,connectedAt:connection.connectedAt};
    });
    const standardConnection=connections.find(connection=>connection.kind==='standard')||connections[0];
    const standard=workflows.find(w=>w.kind==='standard')||workflows[0];
    const storedApiKey=decryptSecret(standardConnection?.n8nApiKeyEncrypted)||'';
    return send(res,200,{connected:true,n8nUrl:standardConnection?.n8nUrl||null,n8nApiKeyLength:storedApiKey.length,n8nApiKeyLast4:storedApiKey.slice(-4),...standard,workflows});
  }
  if(parts[4]==='n8n'&&parts[5]==='connect'&&req.method==='DELETE'){
    const connections=store.n8nConnections.filter(c=>c.accountId===id);
    for(const connection of connections){
      const n8nApiKey=decryptSecret(connection.n8nApiKeyEncrypted);
      if(n8nApiKey){
        await deleteN8nWorkflowQuietly(connection.n8nUrl,n8nApiKey,connection.workflowId);
        await deleteN8nCredentialQuietly(connection.n8nUrl,n8nApiKey,connection.llmCredentialId);
        await deleteN8nCredentialQuietly(connection.n8nUrl,n8nApiKey,connection.outboundCredentialId);
        await deleteN8nCredentialQuietly(connection.n8nUrl,n8nApiKey,connection.inboundCredentialId);
      }
    }
    store.n8nConnections=store.n8nConnections.filter(c=>c.accountId!==id);
    store.keys=store.keys.filter(k=>!(k.accountId===id&&(k.name==='n8n auto-connect'||k.name==='n8n auto-connect (AI Agent)')));
    store.automationSubscriptions=store.automationSubscriptions.filter(item=>!(item.accountId===id&&(item.name==='n8n auto-connect'||item.name==='n8n auto-connect (AI Agent)')));
    await persist();
    return send(res,200,{ok:true});
  }
  return send(res,404,{message:'Not found'});
}
const server=http.createServer(async (req,res)=>{ const url=new URL(req.url,`http://${req.headers.host}`); try {
  if (url.pathname === '/healthz' || url.pathname === '/readyz' || url.pathname.startsWith('/api/')) return await api(req,res,url);
  // React owns application routes. Serve the shell for deep links so a direct
  // visit to an account details page does not get treated as a missing file.
  const requested=(url.pathname==='/'||url.pathname.startsWith('/accounts/')||url.pathname.startsWith('/details/'))?'/index.html':url.pathname, file=normalize(join(publicDir,requested));
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
  server.close(()=>{clearTimeout(forceExit);process.exit(0);});
}
process.on('SIGTERM',()=>{shutdown('SIGTERM')});
process.on('SIGINT',()=>{shutdown('SIGINT')});

export { server, readBody, store, sessions, buildN8nWorkflowGraph, sendAutomationReply, describeWebhookFailure, provider, dispatchAutomationEvent };
