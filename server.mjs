import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createProviderClient } from './src/providers/index.mjs';
import { WebSocketServer } from 'ws';
import { avatarUrl as domainAvatarUrl, chatOverview as domainChatOverview, chatTimestamp, messageView as domainMessageView, providerMessageId } from './src/domain/message.mjs';
import { fetchPinned, validatePublicUrl } from './src/lib/safe-fetch.mjs';

const port = Number(process.env.PORT || 3000);
const configuredPublicUrl = String(process.env.GAKAI_PUBLIC_URL || '').trim().replace(/\/$/, '');
const publicPort = Number(process.env.GAKAI_PUBLIC_PORT || port);

function requestPublicUrl(req) {
  // Explicit configuration always wins. This is ideal for Cloudflare Tunnel,
  // reverse proxies, or any deployment with a stable public hostname.
  if (configuredPublicUrl) return configuredPublicUrl;

  // Reverse proxies such as Cloudflare normally provide the original scheme/host.
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();

  // Without a reverse proxy, use exactly what the user used to open Gakai:
  // hostname.local, LAN IP, DNS hostname, custom domain, etc.
  const host = forwardedHost || String(req.headers.host || '').trim();
  const protocol = forwardedProto || 'http';

  if (host) return `${protocol}://${host}`.replace(/\/$/, '');

  // Last-resort fallback. This keeps local-only Gakai usable, although an
  // external n8n instance cannot call a loopback address.
  return `http://127.0.0.1:${publicPort}`;
}
const providerUrl = (process.env.GAKAI_PROVIDER_URL || process.env.WAHA_INTERNAL_URL || 'http://provider:3000').replace(/\/$/, '');
const providerApiKey=process.env.GAKAI_PROVIDER_API_KEY || "";
const providerWebhookSecret=process.env.GAKAI_PROVIDER_WEBHOOK_SECRET || "";
const provider = createProviderClient({
  kind: process.env.GAKAI_PROVIDER_KIND || 'waha',
  baseUrl: providerUrl,
  apiKey: providerApiKey,
});
// Encrypts secrets we must read back later (e.g. the n8n API key, to call n8n's
// API again on the user's behalf). Falls back to the provider webhook secret so
// existing deployments keep working without a new required env var.
const stateSecretKey=createHash('sha256').update(process.env.GAKAI_STATE_SECRET || providerWebhookSecret || 'gakai-dev-secret').digest();
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
await mkdir(dataDir,{recursive:true});
const db=new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS app_events_account_created ON app_events(account_id, created_at);");
let legacy={username:null,password:null,keys:[]};try{legacy=JSON.parse(await readFile(dataFile,"utf8"))}catch{}
const savedState=db.prepare("SELECT data FROM app_state WHERE id=1").get();
let store=savedState?JSON.parse(savedState.data):legacy;
// Reactions/deleted-chat records otherwise only ever grow (including for
// accounts that no longer exist, before the account-delete cleanup below
// existed) and are never useful past a retention window.
const retentionMs=365*24*60*60*1000;
function pruneStore(){
  const now=Date.now();
  const keep=(items,dateField)=>items.filter(item=>{const at=Date.parse(item[dateField]);return !Number.isFinite(at)||now-at<retentionMs});
  if(Array.isArray(store.messageReactions))store.messageReactions=keep(store.messageReactions,'reactedAt');
  if(Array.isArray(store.deletedChats))store.deletedChats=keep(store.deletedChats,'deletedAt');
}
const persist=()=>{pruneStore();db.prepare("INSERT INTO app_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(store));};
if(!Array.isArray(store.deletingAccounts))store.deletingAccounts=[];
if(!Array.isArray(store.deletedChats))store.deletedChats=[];
if(!Array.isArray(store.messageReactions))store.messageReactions=[];
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
const providerRequest = provider.request;
const providerFile = provider.file;
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
const presencePolls=new Map();
const socketOpen=socket=>socket.readyState===1;
const presenceValue=value=>String(value?.presence||value?.status||value?.state||value?.data?.presence||'').toLowerCase();
function broadcastTyping(accountId,chatId,payload,except){for(const socket of typingSockets)if(socket!==except&&socket.accountId===accountId&&socket.chatId===chatId&&socketOpen(socket))socket.send(JSON.stringify(payload));}
function stopPresencePoll(key){const poll=presencePolls.get(key);if(!poll)return;clearInterval(poll.timer);presencePolls.delete(key)}
function maybeStopPresencePoll(key){if(![...typingSockets].some(socket=>`${socket.accountId}:${socket.chatId}`===key))stopPresencePoll(key)}
function startPresencePoll(accountId,chatId){
  const key=`${accountId}:${chatId}`;if(presencePolls.has(key))return;
  const poll={last:'',timer:null};
  const read=async()=>{try{await providerRequest(`/api/${encodeURIComponent(accountId)}/presence/${encodeURIComponent(chatId)}/subscribe`,{method:'POST'});const value=presenceValue(await providerRequest(`/api/${encodeURIComponent(accountId)}/presence/${encodeURIComponent(chatId)}`));if(value!==poll.last){poll.last=value;broadcastTyping(accountId,chatId,{type:'presence',accountId,chatId,presence:value||'paused'})}}catch{}};
  poll.timer=setInterval(read,2000);presencePolls.set(key,poll);read();
}
const mediaCache=new Map();
async function cachedMedia(path){
  const cached=mediaCache.get(path);if(cached)return cached;
  const response=await providerFile(path);const value={buffer:Buffer.from(await response.arrayBuffer()),type:response.headers.get('content-type')||'application/octet-stream'};
  if(value.buffer.length<=3*1024*1024){mediaCache.set(path,value);if(mediaCache.size>24)mediaCache.delete(mediaCache.keys().next().value)}
  return value;
}
const instagramPreviewCache=new Map();
const safeInstagramPage=value=>{try{const url=new URL(value);return url.protocol==='https:'&&/instagram\.com$/i.test(url.hostname)?url:null}catch{return null}};
const safeInstagramImage=value=>{try{const url=new URL(value);return url.protocol==='https:'&&/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)?url:null}catch{return null}};
const htmlMeta=(html,key)=>{
  const patterns=[
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`,'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`,'i'),
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`,'i'),
  ];
  for(const re of patterns){const m=html.match(re);if(m?.[1])return m[1].replace(/&/g,'&');}
  return null;
};

function extractJSONLD(html){
  const m=html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!m)return null;
  try{return JSON.parse(m[1])}catch{return null}
}

async function instagramPreview(value){
  const url=safeInstagramPage(value);if(!url)throw Object.assign(new Error('Invalid Instagram URL'),{status:400});
  const cached=instagramPreviewCache.get(url.href);if(cached)return cached;
  const ua='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  let html='';
  try{
    const response=await fetch(url,{headers:{'user-agent':ua,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','accept-language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(10000)});
    if(response.ok)html=await response.text();
  }catch{}
  
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
  instagramPreviewCache.set(url.href,result);
  if(instagramPreviewCache.size>40)instagramPreviewCache.delete(instagramPreviewCache.keys().next().value);
  return result;
}
const externalPreviewCache=new Map();
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
  if(externalPreviewCache.size>80)externalPreviewCache.delete(externalPreviewCache.keys().next().value);
  return result;
}
const avatarUrl = value => domainAvatarUrl(value, providerUrl);
function account(s) { const rawStatus=s.status; return { id:s.name, label:store.accountLabels[s.name] || s.config?.metadata?.['gakai.label'] || s.config?.metadata?.['waha-home.label'] || s.me?.pushName || s.name, status:['WORKING','CONNECTED','READY'].includes(rawStatus)?'WORKING':rawStatus, phone:s.me?.id?.split('@')[0] || null, profile:s.me?.pushName || null }; }
async function accountView(session){
  const view=account(session);if(!session.me?.id)return view;

  try{const contacts=await providerRequest(`/api/contacts/all?session=${encodeURIComponent(session.name)}`);const self=(Array.isArray(contacts)?contacts:[]).find(contact=>contact.id===session.me.id||contact.number===session.me.id.split("@")[0])||{};const photo=await providerRequest(`/api/contacts/profile-picture?contactId=${encodeURIComponent(session.me.id)}&session=${encodeURIComponent(session.name)}`);view.picture=avatarUrl(photo?.profilePictureURL||photo?.url);view.mentionNames=[view.label,view.profile,self.name,self.pushName,self.shortName,view.phone].filter(Boolean)}catch{view.picture=null;view.mentionNames=[view.label,view.profile,view.phone].filter(Boolean)}
  return view;
}
const config = label => label ? ({metadata:{'gakai.label':label}}) : {};
const chatOverview = chat => domainChatOverview(chat, providerUrl);
const chatPictureCache=new Map();
const chatPictureCacheTtl=24*60*60*1000;
function chatPictureFor(session,chatId){
  const key=`${session}:${chatId}`,cached=chatPictureCache.get(key);
  if(cached&&cached.expiresAt>Date.now())return cached.value;
  const entry={value:null,expiresAt:Date.now()+5*60*1000};
  const task=providerRequest(`/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/picture?refresh=true`).then(picture=>{entry.expiresAt=Date.now()+chatPictureCacheTtl;return avatarUrl(picture?.profilePictureURL||picture?.url||picture?.profilePicture||picture)}).catch(()=>null);
  entry.value=task;chatPictureCache.set(key,entry);
  if(chatPictureCache.size>500)chatPictureCache.delete(chatPictureCache.keys().next().value);
  return task;
}
async function enrichChatOverview(session,chat){const view=chatOverview(chat);if(!view.picture&&view.id)view.picture=await chatPictureFor(session,view.id);return view}
async function mapWithConcurrency(values,limit,worker){const result=new Array(values.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{while(next<values.length){const index=next++;result[index]=await worker(values[index])}}));return result}
async function allChatOverviews(session){
  const limit=100,all=[];let offset=0;
  for(;;){
    const page=await providerRequest(`/api/${encodeURIComponent(session)}/chats/overview?limit=${limit}&offset=${offset}`);
    if(!Array.isArray(page))return all;
    all.push(...page);
    if(page.length<limit)return all;
    offset+=page.length;
  }
}
const messageView = message => domainMessageView(message, providerUrl);
const contactsListCache=new Map();
async function contactsFor(session){
  const cached=contactsListCache.get(session);if(cached)return await cached;
  const task=providerRequest(`/api/contacts/all?session=${encodeURIComponent(session)}`).catch(error=>{contactsListCache.delete(session);throw error});contactsListCache.set(session,task);if(contactsListCache.size>50)contactsListCache.delete(contactsListCache.keys().next().value);return await task;
}
const contactCache=new Map();
const profilePictureCache=new Map();
const accountIdentityCache=new Map();
const profileCacheTtl=5*60*1000;
async function accountIdentityFor(session){const cached=accountIdentityCache.get(session);if(cached&&cached.expiresAt>Date.now())return cached.id;try{const value=await providerRequest(`/api/sessions/${encodeURIComponent(session)}`),id=String(value?.me?.id||'');accountIdentityCache.set(session,{id,expiresAt:Date.now()+profileCacheTtl});return id}catch{return ''}}
function profilePictureFor(session,contactId){const key=`${session}:${contactId}`,cached=profilePictureCache.get(key);if(cached&&cached.expiresAt>Date.now())return cached.value;profilePictureCache.delete(key);const task=providerRequest(`/api/contacts/profile-picture?contactId=${encodeURIComponent(contactId)}&session=${encodeURIComponent(session)}`);const entry={value:task,expiresAt:Date.now()+profileCacheTtl};profilePictureCache.set(key,entry);task.catch(()=>{if(profilePictureCache.get(key)===entry)profilePictureCache.delete(key)});if(profilePictureCache.size>500)profilePictureCache.delete(profilePictureCache.keys().next().value);return task;}
async function resolveContact(session,rawId){
  const key=`${session}:${rawId}`,cached=contactCache.get(key);if(cached&&cached.expiresAt>Date.now())return cached.value;contactCache.delete(key);
  let contactId=String(rawId||'');
  try{
    if(contactId.endsWith('@lid')){
      const lid=await providerRequest(`/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(contactId)}`);
      const mapped=typeof lid==='string'?lid:(lid.phoneNumber||lid.phone||lid.pn||lid.id||lid.chatId||lid.data?.phoneNumber||lid.data?.id||null);
      if(mapped){contactId=String(mapped);if(!contactId.includes('@'))contactId+='@c.us'}
    }
    const contacts=await contactsFor(session);
    const contact=(Array.isArray(contacts)?contacts:[]).find(item=>item.id===contactId||item.number===contactId.replace(/@.*$/,'')||item.lid===rawId)||{};
    const picture=await profilePictureFor(session,contactId);
    const phone=contact.number||contact.phoneNumber||contact.phone||(contactId.endsWith("@c.us")?contactId.slice(0,-5):null); const value={id:contactId,phone:phone?String(phone).replace(/[^0-9]/g,""):null,name:contact.name||contact.pushName||contact.shortName||contact.verifiedName||null,status:contact.status||contact.about||contact.description||null,picture:avatarUrl(picture?.profilePictureURL||picture?.url)}; contactCache.set(key,{value,expiresAt:Date.now()+profileCacheTtl}); if(contactCache.size>500)contactCache.delete(contactCache.keys().next().value); return value;
  }catch{const value={id:contactId,phone:contactId.endsWith("@c.us")?contactId.slice(0,-5):null,name:null,picture:null};return value}
}
const automationSummary=subscription=>({id:subscription.id,accountId:subscription.accountId,name:subscription.name,url:subscription.url,productionUrl:subscription.productionUrl||subscription.url,testUrl:subscription.testUrl||null,testPhone:subscription.testPhone||null,enabled:subscription.enabled,events:subscription.events,secret:subscription.secret,createdAt:subscription.createdAt,lastDelivery:subscription.lastDelivery||null});
async function automationFetch(subscription,event){
  const request=url=>fetchPinned(url,{requireHttps:true,method:'POST',headers:{'content-type':'application/json','x-gakai-secret':subscription.secret,'x-gakai-event-id':event.id,'user-agent':'Gakai/1.0'},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});
  let response=await request(subscription.url);
  if(!response.ok&&event.source==='test'&&response.status===404&&subscription.url.includes('/webhook/'))response=await request(subscription.url.replace('/webhook/','/webhook-test/'));
  return response;
}
async function deliverAutomation(subscription,event){subscription.secret=subscription.secret||ensureN8nKey(subscription.accountId);
  const started=Date.now();
  try{const response=await automationFetch(subscription,event);subscription.lastDelivery={at:new Date().toISOString(),ok:response.ok,status:response.status,durationMs:Date.now()-started};if(!response.ok)throw new Error(`Webhook returned ${response.status}`)}
  catch(error){subscription.lastDelivery={at:new Date().toISOString(),ok:false,error:error.message||"Delivery failed",durationMs:Date.now()-started};throw error}
  finally{await persist()}
}
async function dispatchAutomationEvent(payload){
  if(payload?.event!=="message"||payload?.payload?.fromMe)return;const accountId=String(payload.session||"");if(!accountId)return;
  const message=messageView(payload.payload||{}),chatId=payload.payload?.from||payload.payload?.chatId||null,kind=String(chatId||"").endsWith("@g.us")?"group":"direct";
  const chat={id:chatId,kind,name:payload.payload?.chatName||payload.payload?._data?.chatName||payload.payload?._data?.notifyName||null};
  if(message.sender?.id){const contact=await resolveContact(accountId,message.sender.id);message.sender={...message.sender,phone:contact.phone||null,name:message.sender.name||contact.name||null};if(kind==="direct")chat.phone=contact.phone||null;}
  const event={id:`evt_${payload.payload?.id||randomBytes(12).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id:accountId},chat,message,source:"whatsapp"};
  // Persist before notifying the browser or downstream automation. This gives
  // reconnecting clients a small durable replay window and avoids exposing raw
  // provider payloads outside the adapter boundary.
  if (!recordAppEvent(event)) return;
  await Promise.allSettled([
    ...store.automationSubscriptions.filter(subscription=>subscription.accountId===accountId&&subscription.enabled&&subscription.events.includes(event.type)).map(subscription=>deliverAutomation(subscription,event)),
    dispatchLLMReply(accountId,event)
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

Reply only to messages from approved phone numbers: +15551234567 and +15557654321. For everyone else, do not send a reply.
Use a friendly, warm, professional tone. Keep replies concise and natural for WhatsApp. Answer customer questions, help with scheduling and next steps, and ask one clear follow-up question when information is missing.
Do not make up facts, prices, availability, or promises. If a request needs a human, say that you will pass it on. Reply with only the message text—no labels, markdown, or explanation.`;
function assistantInstructions(value){return String(value||'').trim()||defaultAssistantInstructions;}

// n8n versions released before the public credential-update endpoint return
// 405 for PUT /credentials/{id}. For those versions, replace only Gakai's
// dedicated credential and repoint the generated Chat Model in the same
// workflow update. This leaves customer-owned credentials untouched.
async function syncN8nLlmCredential(connection,n8nApiKey,config){
  const name=`Gakai LLM Proxy – ${config.accountId}`;
  const body={name,type:'openAiApi',data:{apiKey:config.apiKey,url:config.baseUrl}};
  try{
    await n8nRequest(connection.n8nUrl,n8nApiKey,`/credentials/${encodeURIComponent(connection.llmCredentialId)}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {id:String(connection.llmCredentialId),name,replacedCredentialId:null};
  }catch(error){
    if(error.status!==405)throw error;
    const replacement=await n8nRequest(connection.n8nUrl,n8nApiKey,'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {id:String(replacement.id),name:replacement.name||name,replacedCredentialId:String(connection.llmCredentialId)};
  }
}

// Keep Gakai's LLM settings and the generated n8n AI Agent in lockstep.
// We fetch first so any customer edits to other workflow nodes remain intact.
async function syncAgenticN8nInstructions(accountId,config){
  const connection=store.n8nConnections.find(item=>item.accountId===accountId&&item.kind==='agentic');
  if(!connection)return false;
  const n8nApiKey=decryptSecret(connection.n8nApiKeyEncrypted);
  if(!n8nApiKey)throw new Error('Reauthorize n8n before updating the AI Agent settings');
  const workflow=await n8nRequest(connection.n8nUrl,n8nApiKey,`/workflows/${encodeURIComponent(connection.workflowId)}`);
  const agent=workflow?.nodes?.find(node=>node.name==='AI Agent'&&node.type==='@n8n/n8n-nodes-langchain.agent');
  const model=workflow?.nodes?.find(node=>node.name==='OpenAI Chat Model'&&node.type==='@n8n/n8n-nodes-langchain.lmChatOpenAi');
  if(!agent||!model)throw new Error('The generated n8n AI Agent or Chat Model node could not be found. Recreate the AI workflow before saving settings.');
  if(!connection.llmCredentialId)throw new Error('The generated n8n LLM credential could not be found. Recreate the AI workflow before saving settings.');
  const credential=await syncN8nLlmCredential(connection,n8nApiKey,config);
  agent.parameters={...(agent.parameters||{}),options:{...(agent.parameters?.options||{}),systemMessage:assistantInstructions(config.systemPrompt)}};
  model.parameters={...(model.parameters||{}),model:{...(typeof model.parameters?.model==='object'?model.parameters.model:{}),__rl:true,mode:'list',value:config.model}};
  model.credentials={...(model.credentials||{}),openAiApi:{id:credential.id,name:credential.name}};
  await n8nRequest(connection.n8nUrl,n8nApiKey,`/workflows/${encodeURIComponent(connection.workflowId)}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:workflow.name,nodes:workflow.nodes,connections:workflow.connections,settings:workflow.settings||{executionOrder:'v1'}})});
  await publishN8nWorkflow(connection.n8nUrl,n8nApiKey,connection.workflowId);
  connection.llmCredentialId=credential.id;
  if(credential.replacedCredentialId)await deleteN8nCredentialQuietly(connection.n8nUrl,n8nApiKey,credential.replacedCredentialId);
  return true;
}

// Builds one n8n workflow (Webhook -> [Set | AI Agent] -> Send Reply) and its
// dedicated credentials. Used both for the initial n8n connect and for creating
// the paired AI Agent workflow once LiteLLM is configured. Never mutates an
// existing n8n workflow; each call creates a brand-new one.
async function createN8nWorkflow({n8nBaseUrl,n8nApiKey,accountId,publicUrl,kind}){
  const inboundSecret='gs_inbound_'+randomBytes(24).toString('base64url');
  const integrationToken='wh_n8n_'+randomBytes(24).toString('base64url');
  let inboundCred=null,outboundCred=null,llmCred=null,workflow=null;
  try{
    inboundCred=await n8nRequest(n8nBaseUrl,n8nApiKey,'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:`Gakai Inbound Secret – ${accountId}${kind==='agentic'?' (AI Agent)':''}`,type:'httpHeaderAuth',data:{name:'X-Gakai-Secret',value:inboundSecret}})});
    outboundCred=await n8nRequest(n8nBaseUrl,n8nApiKey,'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:`Gakai Bearer Token – ${accountId}${kind==='agentic'?' (AI Agent)':''}`,type:'httpBearerAuth',data:{token:integrationToken}})});

    const webhookPath='gakai-'+accountId.replace(/[^a-z0-9]/gi,'-').toLowerCase().slice(0,24)+(kind==='agentic'?'-ai':'');
    let accountLabel=accountId;
    try{const sessions=await providerRequest('/api/sessions');const session=(Array.isArray(sessions)?sessions:[]).find(s=>s.name===accountId);if(session)accountLabel=store.accountLabels[accountId]||session.config?.metadata?.['gakai.label']||session.config?.metadata?.['waha-home.label']||session.me?.pushName||accountId;}catch{}
    const workflowName=`Gakai – ${accountLabel}${kind==='agentic'?' (AI Agent)':''}`;
    const webhookNodeId=makeUUID(),middleNodeId=makeUUID(),httpNodeId=makeUUID(),llmNodeId=makeUUID();
    const accountLlm=kind==='agentic'?llmConfig(accountId):null;
    let nodes,connections;

    const webhookNode={
      id:webhookNodeId,
      name:'Webhook',
      type:'n8n-nodes-base.webhook',
      typeVersion:2.1,
      position:[250,300],
      parameters:{httpMethod:'POST',path:webhookPath,authentication:'headerAuth',responseMode:'onReceived',options:{}},
      credentials:{httpHeaderAuth:{id:String(inboundCred.id),name:inboundCred.name}}
    };

    const httpNode={
      id:httpNodeId,
      name:'Send Reply',
      type:'n8n-nodes-base.httpRequest',
      typeVersion:4.2,
      position:[1000,300],
      parameters:{
        method:'POST',
        url:`${publicUrl}/api/integrations/v1/messages`,
        authentication:'genericCredentialType',
        genericAuthType:'httpBearerAuth',
        sendBody:true,
        contentType:'json',
        specifyBody:'keypair',
        bodyParameters:{
          parameters:[
            {
              name:'chatId',
              value:"={{ $('Webhook').item.json.body.chat.id }}"
            },
            {
              name:'text',
              value:"={{ $json.output || $json.reply || $json.text || $json.message_body || '' }}"
            }
          ]
        },
        options:{}
      },
      credentials:{httpBearerAuth:{id:String(outboundCred.id),name:outboundCred.name}}
    };

    if(accountLlm){
      // n8n's OpenAI credential uses `url` for an OpenAI-compatible base endpoint.
      llmCred=await n8nRequest(n8nBaseUrl,n8nApiKey,'/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:`Gakai LLM Proxy – ${accountId}`,type:'openAiApi',data:{apiKey:accountLlm.apiKey,url:accountLlm.baseUrl}})});
      const systemPrompt=assistantInstructions(accountLlm.systemPrompt);
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
        parameters:{model:{__rl:true,mode:'list',value:accountLlm.model},options:{}},
        credentials:{openAiApi:{id:String(llmCred.id),name:llmCred.name}}
      };
      nodes=[webhookNode,agentNode,llmNode,httpNode];
      connections={Webhook:{main:[[{node:'AI Agent',type:'main',index:0}]]},'OpenAI Chat Model':{ai_languageModel:[[{node:'AI Agent',type:'ai_languageModel',index:0}]]},'AI Agent':{main:[[{node:'Send Reply',type:'main',index:0}]]}};
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
      nodes=[webhookNode,setNode,httpNode];
      connections={Webhook:{main:[[{node:'Set',type:'main',index:0}]]},Set:{main:[[{node:'Send Reply',type:'main',index:0}]]}};
    }

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
      inboundSecret,integrationToken,activationWarning,
      inboundCredentialId:String(inboundCred.id),outboundCredentialId:String(outboundCred.id),llmCredentialId:llmCred?String(llmCred.id):null,
      agentic:Boolean(accountLlm)
    };
  }catch(err){
    await deleteN8nWorkflowQuietly(n8nBaseUrl,n8nApiKey,workflow?.id);
    await deleteN8nCredentialQuietly(n8nBaseUrl,n8nApiKey,llmCred?.id);
    await deleteN8nCredentialQuietly(n8nBaseUrl,n8nApiKey,outboundCred?.id);
    await deleteN8nCredentialQuietly(n8nBaseUrl,n8nApiKey,inboundCred?.id);
    throw err;
  }
}

// Creates the paired AI Agent workflow for an account that already has a
// standard n8n connection, reusing the same n8n instance/API key on file.
// Leaves the existing standard workflow untouched. Routes live delivery to
async function createAgenticN8nWorkflow(accountId,req){
  const standard=store.n8nConnections.find(c=>c.accountId===accountId&&c.kind==='standard');
  if(!standard)throw Object.assign(new Error('No existing n8n integration is available'),{status:409});
  if(store.n8nConnections.some(c=>c.accountId===accountId&&c.kind==='agentic'))throw Object.assign(new Error('The AI workflow already exists'),{status:409});
  const n8nApiKey=decryptSecret(standard.n8nApiKeyEncrypted);
  if(!n8nApiKey)throw Object.assign(new Error('Reauthorize the existing n8n integration with its API key before creating an AI workflow'),{status:409});
  // Verify the stored n8n connection before creating anything.
  await n8nRequest(standard.n8nUrl,n8nApiKey,'/workflows?limit=1');
  const publicUrl=requestPublicUrl(req);
  const built=await createN8nWorkflow({n8nBaseUrl:standard.n8nUrl,n8nApiKey,accountId,publicUrl,kind:'agentic'});
  const connectedAt=new Date().toISOString();
  store.keys=store.keys.filter(k=>!(k.accountId===accountId&&k.name==='n8n auto-connect (AI Agent)'));
  store.keys.push({id:randomBytes(8).toString('hex'),accountId,name:'n8n auto-connect (AI Agent)',scopes:['messages:read','messages:send'],createdAt:connectedAt,lastUsedAt:null,token:built.integrationToken,hash:hash(built.integrationToken)});
  // The generated AI workflow is deliberately isolated: it receives no live
  // events until a later explicit activation step, and never alters the
  // existing n8n workflow or its automation subscription.
  store.automationSubscriptions=store.automationSubscriptions.filter(item=>!(item.accountId===accountId&&item.name==='n8n auto-connect (AI Agent)'));
  store.automationSubscriptions.push({id:randomBytes(8).toString('hex'),accountId,name:'n8n auto-connect (AI Agent)',url:built.webhookUrl,productionUrl:built.webhookUrl,testUrl:null,testPhone:null,enabled:false,events:['message.received'],secret:built.inboundSecret,createdAt:connectedAt,lastDelivery:null});
  store.n8nConnections.push({accountId,kind:'agentic',n8nUrl:standard.n8nUrl,n8nApiKeyEncrypted:standard.n8nApiKeyEncrypted,workflowId:built.workflowId,workflowName:built.workflowName,webhookUrl:built.webhookUrl,inboundCredentialId:built.inboundCredentialId,outboundCredentialId:built.outboundCredentialId,llmCredentialId:built.llmCredentialId,inboundSecret:built.inboundSecret,integrationToken:built.integrationToken,connectedAt});
  await persist();
  return built;
}
async function llmChat(config,messages){
  const response=await fetch(llmChatCompletionsUrl(config.baseUrl),{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${config.apiKey}`},body:JSON.stringify(llmRequestBody(config,messages)),signal:AbortSignal.timeout(30000)});
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
    await providerRequest('/api/sendText',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:accountId,chatId,text:reply.trim()})});
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
  if(req.method==="POST"&&url.pathname==="/api/app/provider-events"){const payload=await readBody(req);const signature=req.headers["x-webhook-hmac"];const expected=providerWebhookSecret?createHmac("sha512",providerWebhookSecret).update(req.rawBody||"").digest("hex"):"";if(!providerWebhookSecret||!signature||!equalHex(signature,expected))return send(res,401,{message:"Invalid provider webhook"});dispatchAutomationEvent(payload).catch(error=>console.error("Automation dispatch failed",error));return send(res,202,{ok:true});}
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, {ok:true, service:'gakai'});
  if (req.method === 'GET' && url.pathname === '/readyz') {
    try { await providerRequest('/api/sessions'); return send(res, 200, {ok:true, service:'gakai', provider:true}); }
    catch { return send(res, 503, {ok:false, service:'gakai', provider:false}); }
  }
async function enrichMessage(session,message){
  const view=messageView(message);
  const reaction=store.messageReactions.find(item=>item.accountId===session&&item.messageId===String(view.id));
  if(reaction)view.reaction=reaction.reaction;
  if(view.sender?.id){
    const resolved=await resolveContact(session,view.sender.id);
    view.sender={...view.sender,id:resolved.id||view.sender.id,name:resolved.name||view.sender.name||String(resolved.id||view.sender.id).replace(/@(c|s|g)\.us$/,''),picture:resolved.picture||view.sender.picture||null};
  }
  if(view.linkPreview)view.linkPreview.image=normalizedPreviewImage(view.linkPreview.image);
  const rawMentionIds=Array.isArray(message._data?.mentionedJidList)?message._data.mentionedJidList:[];
  if(rawMentionIds.length){
    const ownId=await accountIdentityFor(session);
    view.mentions=(await Promise.all(rawMentionIds.slice(0,8).map(async rawId=>{const contact=await resolveContact(session,String(rawId));const id=contact.id||String(rawId);const ownNumber=ownId.replace(/@.*$/,''),mentionNumber=id.replace(/@.*$/,'');return {id,name:contact.name||mentionNumber,isMe:Boolean(ownId&&(id===ownId||mentionNumber===ownNumber))}}))).filter(mention=>mention.name);
  }
  const body=String(view.body||view.text||'');
  const mentionIds=[...new Set([...body.matchAll(/@(\d{5,})/g)].map(match=>match[1]))].slice(0,8);
  if(mentionIds.length){
    const contacts=await Promise.all(mentionIds.map(async id=>[id,await resolveContact(session,`${id}@lid`)]));
    const labels=new Map(contacts.map(([id,contact])=>[id,contact.name||String(contact.id||'').replace(/@(c|s|g)\.us$/,'')]).filter(([,label])=>label));
    view.body=body.replace(/@(\d{5,})/g,(mention,id)=>labels.has(id)?`@${labels.get(id)}`:mention);
    view.text=view.body;
  }
  return view;
}
  if(url.pathname.startsWith('/api/integrations/v1/')){
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const key=store.keys.find(k=>equalHex(k.hash,hash(token)));
    if(!key)return send(res,401,{message:'Invalid integration key'});key.lastUsedAt=new Date().toISOString();persist();
    const endpoint=url.pathname.slice('/api/integrations/v1/'.length);
    if(req.method==='GET'&&endpoint==='chats'&&key.scopes.includes('messages:read')){const chats=await providerRequest(`/api/${encodeURIComponent(key.accountId)}/chats/overview?limit=35`);return send(res,200,{accountId:key.accountId,chats:chats.map(chatOverview).sort((a,b)=>b.timestamp-a.timestamp)});}
    if(req.method==='GET'&&endpoint==='messages'&&key.scopes.includes('messages:read')){const chatId=url.searchParams.get('chatId');if(!chatId)return send(res,400,{message:'chatId is required'});const messages=await providerRequest(`/api/${encodeURIComponent(key.accountId)}/chats/${encodeURIComponent(chatId)}/messages?limit=30&downloadMedia=false`);return send(res,200,{messages:messages.map(messageView).sort((a,b)=>a.timestamp-b.timestamp)});}
    if(req.method==='POST'&&endpoint==='messages'&&key.scopes.includes('messages:send')){const input=await readBody(req);if(!input.chatId||!input.text)return send(res,400,{message:'chatId and text are required'});const sent=await providerRequest('/api/sendText',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:key.accountId,chatId:input.chatId,text:input.text})});return send(res,200,{message:messageView(sent||{})});}
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
    const after=afterId?db.prepare('SELECT created_at FROM app_events WHERE id=?').get(afterId)?.created_at:null;
    const rows=after
      ?db.prepare('SELECT id,payload FROM app_events WHERE account_id=? AND created_at>? ORDER BY created_at ASC LIMIT 250').all(accountId,after)
      :db.prepare('SELECT id,payload FROM app_events WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(accountId).reverse();
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
  if(req.method==='GET'&&url.pathname==='/api/app/media'){const path=url.searchParams.get('path')||'';const range=req.headers.range;if(range){const file=await providerFile(path,{range});const body=Buffer.from(await file.arrayBuffer());const headers={'content-type':file.headers.get('content-type')||'application/octet-stream','cache-control':'private, max-age=86400','accept-ranges':file.headers.get('accept-ranges')||'bytes','content-length':String(body.length)};const contentRange=file.headers.get('content-range');if(contentRange)headers['content-range']=contentRange;res.writeHead(file.status,headers);return res.end(body)}const file=await cachedMedia(path);res.writeHead(200,{'content-type':file.type,'cache-control':'private, max-age=86400','accept-ranges':'bytes','content-length':String(file.buffer.length)});return res.end(file.buffer);}
  if (req.method==='GET' && url.pathname==='/api/app/accounts') {const sessions=await providerRequest('/api/sessions');const deleting=new Set(store.deletingAccounts||[]);const visible=sessions.filter(session=>!deleting.has(session.name));const live=new Set(sessions.map(session=>session.name));const next=(store.deletingAccounts||[]).filter(id=>live.has(id));if(next.length!==store.deletingAccounts.length){store.deletingAccounts=next;await persist()}return send(res,200,{accounts:await Promise.all(visible.map(accountView))});}
  if(req.method==='GET'&&url.pathname==='/api/app/instagram-preview'){return send(res,200,await instagramPreview(url.searchParams.get('url')||''));}
  if(req.method==='GET'&&url.pathname==='/api/app/instagram-image'){
  const image=safeInstagramImage(url.searchParams.get('url')||'');
  if(!image)return send(res,400,{message:'Invalid Instagram image URL'});
  const ua='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const response=await fetch(image,{headers:{'user-agent':ua,'accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(10000),redirect:'follow'});
  if(!response.ok)return send(res,502,{message:'Instagram image unavailable'});
  const type=response.headers.get('content-type')||'image/jpeg';
  if(!type.startsWith('image/'))return send(res,502,{message:'Invalid Instagram image'});
  const body=Buffer.from(await response.arrayBuffer());
  if(body.length>5*1024*1024)return send(res,413,{message:'Instagram image is too large'});
  res.writeHead(200,{'content-type':type,'cache-control':'private, max-age=3600','content-length':String(body.length)});
  return res.end(body);
}
  if (req.method==='POST' && url.pathname==='/api/app/accounts') {
    const input=await readBody(req), id=`account-${Date.now().toString(36)}`;
    const created=await providerRequest('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:id,config:config(input.label)})});
    const label=String(input.label||'WhatsApp account').trim().slice(0,80);if(label){store.accountLabels[id]=label;await persist();}
    return send(res,201,{account:account(created || {name:id,status:'STARTING',config:config(input.label)})});
  }
  const id=decodeURIComponent(parts[3] || '');
  if (req.method==="DELETE" && parts.length===4) {await providerRequest(`/api/sessions/${encodeURIComponent(id)}`,{method:"DELETE"}).catch(()=>null);delete store.accountLabels[id];store.deletingAccounts=(store.deletingAccounts||[]).filter(item=>item!==id);store.deletedChats=(store.deletedChats||[]).filter(item=>item.accountId!==id);store.n8nConnections=(store.n8nConnections||[]).filter(item=>item.accountId!==id);store.llmConfigs=(store.llmConfigs||[]).filter(item=>item.accountId!==id);store.automationSubscriptions=(store.automationSubscriptions||[]).filter(item=>item.accountId!==id);store.keys=(store.keys||[]).filter(item=>item.accountId!==id);store.messageReactions=(store.messageReactions||[]).filter(item=>item.accountId!==id);await persist();return send(res,200,{ok:true});}
  if (req.method==='GET' && parts[4]==='qr') return send(res,200,await providerRequest(`/api/${encodeURIComponent(id)}/auth/qr`));
  if (req.method==='POST' && parts[4]==='start') return send(res,200,(await providerRequest(`/api/sessions/${encodeURIComponent(id)}/start`,{method:'POST'})) || {ok:true});
  if (req.method==='POST' && parts[4]==='restart') return send(res,200,(await providerRequest(`/api/sessions/${encodeURIComponent(id)}/restart`,{method:'POST'})) || {ok:true});
  if(req.method==='POST'&&parts[4]==='chats'&&parts[5]&&parts[6]==='read'){await providerRequest(`/api/${encodeURIComponent(id)}/chats/${encodeURIComponent(decodeURIComponent(parts[5]))}/messages/read`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});return send(res,200,{ok:true});}
  if(req.method==='DELETE'&&parts[4]==='chats'&&parts[5]){const chatId=decodeURIComponent(parts[5]);await providerRequest(`/api/${encodeURIComponent(id)}/chats/${encodeURIComponent(chatId)}`,{method:'DELETE'});store.deletedChats=(store.deletedChats||[]).filter(item=>!(item.accountId===id&&item.chatId===chatId));store.deletedChats.push({accountId:id,chatId,deletedAt:new Date().toISOString()});await persist();return send(res,200,{ok:true});}
  // Presence stays behind the dashboard proxy so the browser never receives
  // direct provider access or its API key.
  if (parts[4]==='presence') {
    const chatId=url.searchParams.get('chatId');
    if (!chatId) return send(res,400,{message:'chatId is required'});
    if (req.method==='GET') {
      await providerRequest(`/api/${encodeURIComponent(id)}/presence/${encodeURIComponent(chatId)}/subscribe`,{method:'POST'});
      return send(res,200,await providerRequest(`/api/${encodeURIComponent(id)}/presence/${encodeURIComponent(chatId)}`));
    }
    if (req.method==='POST') {
      const {presence}=await readBody(req);
      if (!['typing','recording','paused'].includes(presence)) return send(res,400,{message:'Invalid presence state'});
      await providerRequest(`/api/${encodeURIComponent(id)}/presence`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId,presence})});
      return send(res,200,{ok:true});
    }
  }
  if (req.method==='GET' && parts[4]==='chats') {
    // Keep the inbox useful for multi-account workspaces without requesting an
    // unbounded provider overview on every refresh.
    const chats=await allChatOverviews(id);
    const deleted=new Set((store.deletedChats||[]).filter(item=>item.accountId===id).map(item=>item.chatId));
    const recent=chats.filter(chat=>!deleted.has(chat.id)).sort((a,b)=>chatTimestamp(b)-chatTimestamp(a)).slice(0,30);
    return send(res,200,(await mapWithConcurrency(recent,2,chat=>enrichChatOverview(id,chat))).sort((a,b) => b.timestamp - a.timestamp));
  }
  if (req.method==='GET' && parts[4]==='contact') {const contactId=url.searchParams.get('contactId');if(!contactId)return send(res,400,{message:'contactId is required'});return send(res,200,{contact:await resolveContact(id,contactId)});}
  if (req.method==='GET' && parts[4]==='messages') {
    const chatId=url.searchParams.get('chatId'); if (!chatId) return send(res,400,{message:'chatId is required'});
    const limit=Math.min(Math.max(Number(url.searchParams.get('limit')) || 15, 1), 60);
    const offset=Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    // The first screen must be fast. Media download is intentionally opt-in,
    // because the provider may need to retrieve every attachment before replying.
    const downloadMedia=url.searchParams.get('media') === '1';
    const messages=await providerRequest(`/api/${encodeURIComponent(id)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&offset=${offset}&sortBy=timestamp&sortOrder=desc&merge=true&downloadMedia=${downloadMedia}`);
    return send(res,200,(await Promise.all(messages.map(message=>enrichMessage(id,message)))).sort((a,b) => a.timestamp - b.timestamp));
  }
  if (req.method==='GET' && parts[4]==='message-media') {
    const chatId=url.searchParams.get('chatId'),messageId=url.searchParams.get('messageId');
    if(!chatId||!messageId)return send(res,400,{message:'chatId and messageId are required'});
    return send(res,200,{message:await enrichMessage(id,await providerRequest(`/api/${encodeURIComponent(id)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?downloadMedia=true`))});
  }
  if(req.method==='POST'&&parts[4]==='messages'&&parts[5]&&parts[6]==='reaction'){
    const input=await readBody(req),messageId=providerMessageId(decodeURIComponent(parts[5]));
    if(!messageId)return send(res,400,{message:'Invalid message ID'});
    const reaction=String(input.reaction||'');if(reaction.length>16)return send(res,400,{message:'Invalid reaction'});
    await providerRequest('/api/reaction',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({session:id,messageId,reaction})});
    store.messageReactions=(store.messageReactions||[]).filter(item=>!(item.accountId===id&&item.messageId===messageId));if(reaction)store.messageReactions.push({accountId:id,messageId,reaction,reactedAt:new Date().toISOString()});await persist();
    return send(res,200,{ok:true,reaction});
  }
  if (req.method==='POST' && parts[4]==='messages') {
    const input=await readBody(req),replyTo=providerMessageId(input.replyTo); if (!input.chatId || !input.text?.trim()) return send(res,400,{message:'Recipient and message are required'});
    const sent=await providerRequest('/api/sendText',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:id,chatId:input.chatId,text:input.text.trim(),...(replyTo?{reply_to:replyTo}:{})})});
    return send(res,200,{message:messageView(sent || {})});
  }
  if(req.method==='PATCH'&&parts[4]==='label') {const input=await readBody(req),label=String(input.label||'').trim().slice(0,80);if(!label)return send(res,400,{message:'Account name is required'});store.accountLabels[id]=label;await persist();try{const session=await providerRequest(`/api/sessions/${encodeURIComponent(id)}`),next={...(session.config||{}),metadata:{...(session.config?.metadata||{}),'gakai.label':label}};await providerRequest(`/api/sessions/${encodeURIComponent(id)}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({config:next})});}catch{}return send(res,200,{ok:true,label});}
  if(parts[4]==="integration-keys"&&parts[5]==="n8n"&&req.method==="GET"){const key=store.keys.find(k=>k.accountId===id&&k.name==="n8n integration");return send(res,200,{token:key?.token||null});}
  if(parts[4]==="integration-keys"&&parts[5]==="n8n"&&req.method==="POST"){let key=store.keys.find(k=>k.accountId===id&&k.name==="n8n integration");const token=`wh_live_${randomBytes(24).toString("base64url")}`;if(key){key.token=token;key.hash=hash(token);key.lastUsedAt=null}else{key={id:randomBytes(8).toString("hex"),accountId:id,name:"n8n integration",scopes:["messages:read","messages:send"],createdAt:new Date().toISOString(),lastUsedAt:null,token,hash:hash(token)}}store.keys=store.keys.filter(item=>item===key||!(item.accountId===id&&item.name==="n8n integration"));store.keys.push(key);await persist();return send(res,200,{token});}
  if(parts[4]==="integration-keys"&&req.method==="GET")return send(res,200,{keys:store.keys.filter(k=>k.accountId===id).map(({hash,token,...key})=>key)});
  if(parts[4]==="integration-keys"&&req.method==="POST"){const input=await readBody(req);const token=`wh_live_${randomBytes(24).toString("base64url")}`;const key={id:randomBytes(8).toString("hex"),accountId:id,name:String(input.name||"Integration").slice(0,80),scopes:Array.isArray(input.scopes)?input.scopes:["messages:read","messages:send"],createdAt:new Date().toISOString(),lastUsedAt:null,hash:hash(token)};store.keys.push(key);await persist();return send(res,201,{key:{...key,hash:undefined},token});}
  if(parts[4]==="automations"&&req.method==="GET")return send(res,200,{subscriptions:store.automationSubscriptions.filter(subscription=>subscription.accountId===id).map(automationSummary)});
  if(parts[4]==="automations"&&parts[5]==="test-delivery"&&req.method==="POST"){const input=await readBody(req),url=await n8nWebhookUrl(input.url||""),secret=String(input.secret||"").trim();if(!url)return send(res,400,{message:"Use the public HTTPS n8n test webhook URL"});if(!secret||secret.length>256)return send(res,400,{message:"Enter the Header Auth secret"});const event={id:`evt_test_${randomBytes(8).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id},chat:{id:"demo@c.us",kind:"direct"},message:{id:"demo-message",timestamp:Math.floor(Date.now()/1000),fromMe:false,body:"This is a Gakai test event.",text:"This is a Gakai test event.",hasMedia:false,media:null},source:"test"};try{const response=await fetchPinned(url.href,{requireHttps:true,method:"POST",headers:{"content-type":"application/json","x-gakai-secret":secret,"x-gakai-event-id":event.id,"user-agent":"Gakai/1.0"},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});if(!response.ok)return send(res,502,{message:`Webhook returned ${response.status}`});return send(res,200,{ok:true})}catch(error){return send(res,502,{message:error.message||"Test delivery failed"})}}
  if(parts[4]==="automations"&&!parts[5]&&req.method==="POST"){const input=await readBody(req),production=await n8nWebhookUrl(input.productionUrl||input.url||""),test=await n8nWebhookUrl(input.testUrl||""),requestedSecret=String(input.secret||"").trim();if(!production)return send(res,400,{message:"Use an HTTPS n8n production webhook URL"});if(input.testUrl&&!test)return send(res,400,{message:"Use an HTTPS n8n test webhook URL"});if(requestedSecret.length>256)return send(res,400,{message:"Invalid Header Auth secret"});const subscription={id:randomBytes(8).toString("hex"),accountId:id,name:String(input.name||"n8n automation").trim().slice(0,80)||"n8n automation",url:production.href,productionUrl:production.href,testUrl:test?.href||null,testPhone:String(input.testPhone||"").replace(/[^0-9]/g,"")||null,enabled:true,events:["message.received"],secret:requestedSecret||ensureN8nKey(id),createdAt:new Date().toISOString(),lastDelivery:null};store.automationSubscriptions=store.automationSubscriptions.filter(item=>item.accountId!==id);store.automationSubscriptions.push(subscription);await persist();return send(res,201,{subscription:automationSummary(subscription),secret:subscription.secret});}
  if(parts[4]==="automations"&&parts[5]&&req.method==="PATCH"){const subscription=store.automationSubscriptions.find(item=>item.id===parts[5]&&item.accountId===id);if(!subscription)return send(res,404,{message:"Automation not found"});const input=await readBody(req);if(typeof input.enabled==="boolean")subscription.enabled=input.enabled;await persist();return send(res,200,{subscription:automationSummary(subscription)});}
  if(parts[4]==="automations"&&parts[5]&&parts[6]==="test"&&req.method==="POST"){const subscription=store.automationSubscriptions.find(item=>item.id===parts[5]&&item.accountId===id);if(!subscription)return send(res,404,{message:"Automation not found"});const input=await readBody(req),phone=String(input.phone||subscription.testPhone||"").replace(/[^0-9]/g,"");if(phone.length>30)return send(res,400,{message:"Invalid test phone number"});const target=phone?`${phone}@c.us`:"demo@c.us",event={id:`evt_test_${randomBytes(8).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id},chat:{id:target,kind:"direct",phone:phone||null},message:{id:"demo-message",timestamp:Math.floor(Date.now()/1000),fromMe:false,body:String(input.text||"This is a Gakai test event."),text:String(input.text||"This is a Gakai test event."),hasMedia:false,media:null,sender:phone?{id:target,phone}:null},source:"test"};try{const destination=String(input.destination||"production")==="test"?subscription.testUrl:subscription.productionUrl||subscription.url;if(!destination)return send(res,400,{message:"This webhook URL is not configured"});const response=await fetch(destination,{method:"POST",headers:{"content-type":"application/json","x-gakai-secret":subscription.secret,"x-gakai-event-id":event.id,"user-agent":"Gakai/1.0"},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});if(!response.ok)return send(res,502,{message:`Webhook returned ${response.status}`});return send(res,200,{ok:true,subscription:automationSummary(subscription)})}catch(error){return send(res,502,{message:error.message||"Test delivery failed",subscription:automationSummary(subscription)})}}
  if(parts[4]==="automations"&&parts[5]&&req.method==="DELETE"){store.automationSubscriptions=store.automationSubscriptions.filter(item=>!(item.id===parts[5]&&item.accountId===id));await persist();return send(res,200,{ok:true});}
  if(parts[4]==='integration-keys'&&req.method==='DELETE'){const keyId=parts[5];store.keys=store.keys.filter(k=>!(k.id===keyId&&k.accountId===id));await persist();return send(res,200,{ok:true});}
  // LLM proxy config endpoints
  if(parts[4]==='llm'&&parts[5]==='test'&&req.method==='POST'){const cfg=llmConfig(id),input=await readBody(req),prompt=String(input.prompt||'').trim();if(!cfg)return send(res,409,{message:'Save an LLM proxy before testing it'});if(!prompt||prompt.length>4000)return send(res,400,{message:'Enter a test prompt up to 4,000 characters'});try{return send(res,200,{reply:await llmChat(cfg,[{role:'system',content:cfg.systemPrompt||'You are a helpful assistant.'},{role:'user',content:prompt}])});}catch(error){return send(res,502,{message:error.message||'LLM test failed'});}}
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
        const test=await fetch(llmChatCompletionsUrl(baseUrl),{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},body:JSON.stringify(llmRequestBody({model},[{role:'user',content:'hi'}],{max_tokens:1})),signal:AbortSignal.timeout(15000)});
        const td=await test.json().catch(()=>({}));
        if(!test.ok&&test.status!==400)throw new Error(td?.error?.message||`Proxy returned ${test.status}`);
      }catch(err){return send(res,400,{message:'Could not connect to LLM proxy: '+err.message});}
    }
    const nextConfig={accountId:id,provider,baseUrl,apiKey,model,systemPrompt:assistantInstructions(String(input.systemPrompt||'').slice(0,4000)),nativeEnabled:Boolean(input.nativeEnabled),configuredAt:existing?.configuredAt||new Date().toISOString()};
    let n8nInstructionsSynced=false;
    try{n8nInstructionsSynced=await syncAgenticN8nInstructions(id,nextConfig);}catch(error){return send(res,502,{message:'LLM proxy verified, but the n8n AI workflow was not updated: '+(error.message||'Unknown error')});}
    store.llmConfigs=store.llmConfigs.filter(c=>c.accountId!==id);
    store.llmConfigs.push(nextConfig);
    await persist();
    return send(res,200,{ok:true,n8nInstructionsSynced});
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
      // Use the URL the user actually used to reach Gakai unless an explicit
      // GAKAI_PUBLIC_URL override is configured (for example behind a reverse proxy).
      const publicUrl=requestPublicUrl(req);
      const publicUrlParsed=new URL(publicUrl);
      if(publicUrlParsed.hostname==='localhost'||publicUrlParsed.hostname==='127.0.0.1'||publicUrlParsed.hostname==='::1')
        return send(res,400,{message:`Gakai resolved its callback URL as ${publicUrl}. n8n cannot call another service through its own loopback address. Open Gakai using a LAN IP, local hostname, or domain, or set GAKAI_PUBLIC_URL when using a reverse proxy.`});
      try{await n8nRequest(n8nBaseUrl,n8nApiKey,'/workflows?limit=1')}catch(err){return send(res,400,{message:err.message||'Could not connect to n8n'});}
      if(existingStandard){existingStandard.n8nUrl=n8nBaseUrl;existingStandard.n8nApiKeyEncrypted=encryptSecret(n8nApiKey);await persist();return send(res,200,{ok:true,reused:true,workflowId:existingStandard.workflowId,workflowName:existingStandard.workflowName,workflowUrl:`${n8nBaseUrl}/workflow/${existingStandard.workflowId}`});}
      let built;
      try{ built=await createN8nWorkflow({n8nBaseUrl,n8nApiKey,accountId:id,publicUrl,kind:'standard'}); }
      catch(err){ return send(res,502,{message:'Failed to configure n8n: '+(err.message||'Unknown n8n error')}); }
      const connectedAt=new Date().toISOString();
      // Remove old n8n auto-connect key for this account
      store.keys=store.keys.filter(k=>!(k.accountId===id&&k.name==='n8n auto-connect'));
      store.keys.push({id:randomBytes(8).toString('hex'),accountId:id,name:'n8n auto-connect',scopes:['messages:read','messages:send'],createdAt:connectedAt,lastUsedAt:null,token:built.integrationToken,hash:hash(built.integrationToken)});
      // Create/replace automation subscription (remove all for this account, then re-add the new one)
      store.automationSubscriptions=store.automationSubscriptions.filter(item=>item.accountId!==id);
      store.automationSubscriptions.push({id:randomBytes(8).toString('hex'),accountId:id,name:'n8n auto-connect',url:built.webhookUrl,productionUrl:built.webhookUrl,testUrl:null,testPhone:null,enabled:true,events:['message.received'],secret:built.inboundSecret,createdAt:connectedAt,lastDelivery:null});
      // Remove old connections for this account (both kinds) and start fresh with the standard workflow
      store.n8nConnections=store.n8nConnections.filter(c=>c.accountId!==id);
      store.n8nConnections.push({accountId:id,kind:'standard',n8nUrl:n8nBaseUrl,n8nApiKeyEncrypted:encryptSecret(n8nApiKey),workflowId:built.workflowId,workflowName:built.workflowName,webhookUrl:built.webhookUrl,inboundCredentialId:built.inboundCredentialId,outboundCredentialId:built.outboundCredentialId,llmCredentialId:built.llmCredentialId,inboundSecret:built.inboundSecret,integrationToken:built.integrationToken,connectedAt});
      await persist();
      return send(res,201,{ok:true,workflowId:built.workflowId,workflowName:built.workflowName,workflowUrl:`${n8nBaseUrl}/workflow/${built.workflowId}`,webhookUrl:built.webhookUrl,connectedAt,activationWarning:built.activationWarning});
    })();
    n8nConnectLocks.set(id,attempt);
    try{ return await attempt; } finally{ n8nConnectLocks.delete(id); }
  }
  if(parts[4]==='n8n'&&parts[5]==='connect'&&parts[6]==='ai'&&req.method==='POST'){
    const lockKey=`${id}:agentic`;
    if(n8nConnectLocks.has(lockKey))return send(res,409,{message:'A connection attempt is already in progress for this account'});
    const attempt=(async()=>{
      if(!llmConfig(id))return send(res,400,{message:'Connect an LLM proxy before creating an AI workflow'});
      try{const built=await createAgenticN8nWorkflow(id,req);if(!built)return send(res,409,{message:'Connect n8n first, or AI replies are already enabled'});return send(res,201,{ok:true,workflowId:built.workflowId,workflowName:built.workflowName,workflowUrl:store.n8nConnections.find(c=>c.accountId===id&&c.kind==='agentic')?.n8nUrl+'/workflow/'+built.workflowId,activationWarning:built.activationWarning});}
      catch(error){return send(res,error.status||502,{message:'Failed to create n8n AI workflow: '+(error.message||'Unknown error')});}
    })();
    n8nConnectLocks.set(lockKey,attempt);
    try{ return await attempt; } finally{ n8nConnectLocks.delete(lockKey); }
  }
  if(parts[4]==='n8n'&&parts[5]==='connect'&&req.method==='GET'){
    const connections=store.n8nConnections.filter(c=>c.accountId===id);
    if(!connections.length)return send(res,200,{connected:false});
    const workflows=connections.map(connection=>{
      const subscription=store.automationSubscriptions.find(item=>item.accountId===id&&item.name===(connection.kind==='agentic'?'n8n auto-connect (AI Agent)':'n8n auto-connect'));
      return {kind:connection.kind,workflowId:connection.workflowId,workflowName:connection.workflowName,workflowUrl:`${connection.n8nUrl}/workflow/${connection.workflowId}`,webhookUrl:connection.webhookUrl||subscription?.url||null,active:subscription?.enabled!==false,lastDelivery:subscription?.lastDelivery||null,connectedAt:connection.connectedAt};
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
  socket.accountId=String(url.searchParams.get('accountId')||'');socket.chatId=String(url.searchParams.get('chatId')||'');typingSockets.add(socket);startPresencePoll(socket.accountId,socket.chatId);
  socket.send(JSON.stringify({type:'ready'}));
  socket.on('message',raw=>{try{const input=JSON.parse(String(raw));if(input.type!=='presence'||input.accountId!==socket.accountId||input.chatId!==socket.chatId||!['typing','recording','paused'].includes(input.presence))return;providerRequest(`/api/${encodeURIComponent(socket.accountId)}/presence`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId:socket.chatId,presence:input.presence})}).catch(()=>{});broadcastTyping(socket.accountId,socket.chatId,{type:'presence',accountId:socket.accountId,chatId:socket.chatId,presence:input.presence},socket)}catch{}});
  socket.on('close',()=>{typingSockets.delete(socket);maybeStopPresencePoll(`${socket.accountId}:${socket.chatId}`)});
});
server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url,`http://${req.headers.host}`);if(url.pathname!=='/api/app/ws'||!admin(req)||!url.searchParams.get('accountId')||!url.searchParams.get('chatId')){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,client=>wss.emit('connection',client,req));});
server.listen(port,'0.0.0.0',()=>console.log(`Gakai is ready on port ${port}${configuredPublicUrl ? ` (public URL: ${configuredPublicUrl})` : ''}`));

export { server, readBody, store, sessions };
