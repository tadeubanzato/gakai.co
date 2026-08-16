import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const port = Number(process.env.PORT || 3000);
const publicHost = process.env.GAKAI_PUBLIC_HOST || 'gakai.localhost';
const publicPort = Number(process.env.GAKAI_PUBLIC_PORT || port);
const publicUrl = process.env.GAKAI_PUBLIC_URL || `http://${publicHost}${publicPort === 80 ? '' : `:${publicPort}`}`;
const providerUrl = (process.env.GAKAI_PROVIDER_URL || process.env.WAHA_INTERNAL_URL || 'http://provider:3000').replace(/\/$/, '');
const providerApiKey=process.env.GAKAI_PROVIDER_API_KEY || "";
const providerWebhookSecret=process.env.GAKAI_PROVIDER_WEBHOOK_SECRET || "";
const dataDir=process.env.HOME_DATA_DIR || join(process.cwd(),"data");
const dataFile=join(dataDir,"home.json");
const dbFile=join(dataDir,"gakai.db");
await mkdir(dataDir,{recursive:true});
const db=new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL);");
let legacy={username:null,password:null,keys:[]};try{legacy=JSON.parse(await readFile(dataFile,"utf8"))}catch{}
const savedState=db.prepare("SELECT data FROM app_state WHERE id=1").get();
let store=savedState?JSON.parse(savedState.data):legacy;
const persist=()=>{db.prepare("INSERT INTO app_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(store));};
if(!Array.isArray(store.deletingAccounts))store.deletingAccounts=[];
if(!Array.isArray(store.automationSubscriptions))store.automationSubscriptions=[];
if(!savedState&&(legacy.username||legacy.password||legacy.keys?.length||legacy.automationSubscriptions?.length||legacy.deletingAccounts?.length))persist();
const legacyAdminUsername=process.env.GAKAI_LEGACY_ADMIN_USERNAME || null;
if(!store.username&&store.password&&legacyAdminUsername){store.username=legacyAdminUsername;await persist();}
const sessions=new Map();
const hash=value=>createHash('sha256').update(value).digest('hex');
const equalHex=(left,right)=>{try{const a=Buffer.from(left||"","hex"),b=Buffer.from(right||"","hex");return a.length===b.length&&timingSafeEqual(a,b)}catch{return false}};
const passwordHash=value=>{const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(value,salt,64).toString('hex')}`};
const passwordMatches=value=>{const [salt,expected]=store.password.split(':');return timingSafeEqual(Buffer.from(expected,'hex'),scryptSync(value,salt,64))};
const cookie=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
const admin=req=>sessions.has(cookie(req).home_session);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const send = (res, status, data) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(data)); };
async function readBody(req) { let value=''; for await (const chunk of req) value += chunk; req.rawBody=value; return value ? JSON.parse(value) : {}; }
async function providerRequest(path, options={}) {
  const headers = { accept:'application/json', ...(options.headers || {}) };
  if (providerApiKey) headers['x-api-key'] = providerApiKey;
  const response = await fetch(`${providerUrl}${path}`, {...options, headers});
  const text = await response.text(); let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw Object.assign(new Error(data?.message || data || 'Provider request failed'), {status:response.status});
  return data;
}
async function providerFile(path, extraHeaders={}) {
  // The provider runtime's media links point at its own localhost. Relay only managed files.
  if (!path.startsWith('/api/files/')) throw Object.assign(new Error('Invalid media path'), {status:400});
  const headers = {...extraHeaders};
  if (providerApiKey) headers['x-api-key'] = providerApiKey;
  const response = await fetch(`${providerUrl}${path}`, {headers});
  if (!response.ok) throw Object.assign(new Error('Media is unavailable'), {status:response.status});
  return response;
}
const mediaCache=new Map();
async function cachedMedia(path){
  const cached=mediaCache.get(path);if(cached)return cached;
  const response=await providerFile(path);const value={buffer:Buffer.from(await response.arrayBuffer()),type:response.headers.get('content-type')||'application/octet-stream'};
  if(value.buffer.length<=3*1024*1024){mediaCache.set(path,value);if(mediaCache.size>24)mediaCache.delete(mediaCache.keys().next().value)}
  return value;
}
const instagramPreviewCache=new Map();
const safeInstagramPage=value=>{try{const url=new URL(value);return url.protocol==='https:'&&/(^|\.)instagram\.com$/i.test(url.hostname)?url:null}catch{return null}};
const safeInstagramImage=value=>{try{const url=new URL(value);return url.protocol==='https:'&&/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)?url:null}catch{return null}};
const htmlMeta=(html,key)=>{const match=html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`,'i'))||html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["']`,'i'));return match?.[1]?.replace(/&amp;/g,'&')||null};
async function instagramPreview(value){const url=safeInstagramPage(value);if(!url)throw Object.assign(new Error('Invalid Instagram URL'),{status:400});const cached=instagramPreviewCache.get(url.href);if(cached)return cached;const response=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; Gakai/1.0)',accept:'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(8000)});if(!response.ok)throw Object.assign(new Error('Instagram preview unavailable'),{status:502});const html=await response.text();const image=htmlMeta(html,'og:image'),result={title:htmlMeta(html,'og:title'),description:htmlMeta(html,'og:description'),image:safeInstagramImage(image)?.href||null};instagramPreviewCache.set(url.href,result);if(instagramPreviewCache.size>40)instagramPreviewCache.delete(instagramPreviewCache.keys().next().value);return result;}

const externalPreviewCache=new Map();
const privateAddress=address=>address==="::1"||address==="0.0.0.0"||address.startsWith("fe80:")||address.startsWith("fc")||address.startsWith("fd")||/^10\./.test(address)||/^127\./.test(address)||/^169\.254\./.test(address)||/^192\.168\./.test(address)||/^172\.(1[6-9]|2\d|3[01])\./.test(address);
async function safePublicUrl(value){try{const url=new URL(value);if(!/^https?:$/.test(url.protocol)||url.hostname==="localhost"||url.hostname.endsWith(".local"))return null;const direct=isIP(url.hostname);const addresses=direct?[{address:url.hostname}]:await lookup(url.hostname,{all:true,verbatim:true});return addresses.length&&addresses.every(item=>!privateAddress(item.address))?url:null}catch{return null}}
function n8nWebhookUrl(value){try{const url=new URL(value);return url.protocol==="https:"&&url.hostname!=="localhost"?url:null}catch{return null}}
async function openGraphPreview(value){const url=await safePublicUrl(value);if(!url)throw Object.assign(new Error("Invalid public URL"),{status:400});const cached=externalPreviewCache.get(url.href);if(cached)return cached;const response=await fetch(url,{redirect:"manual",headers:{"user-agent":"Mozilla/5.0 (compatible; Gakai/1.0)",accept:"text/html,application/xhtml+xml"},signal:AbortSignal.timeout(8000)});if(!response.ok||response.status>=300)throw Object.assign(new Error("Link preview unavailable"),{status:502});const html=(await response.text()).slice(0,1024*1024),image=await safePublicUrl(htmlMeta(html,"og:image"));const result={title:htmlMeta(html,"og:title"),description:htmlMeta(html,"og:description"),image:image?.href||null};externalPreviewCache.set(url.href,result);if(externalPreviewCache.size>80)externalPreviewCache.delete(externalPreviewCache.keys().next().value);return result;}
function account(s) { const rawStatus=s.status; return { id:s.name, label:s.config?.metadata?.['gakai.label'] || s.config?.metadata?.['waha-home.label'] || s.me?.pushName || s.name, status:['WORKING','CONNECTED','READY'].includes(rawStatus)?'WORKING':rawStatus, phone:s.me?.id?.split('@')[0] || null, profile:s.me?.pushName || null }; }
async function accountView(session){
  const view=account(session);if(!session.me?.id)return view;

  try{const contacts=await providerRequest(`/api/contacts/all?session=${encodeURIComponent(session.name)}`);const self=(Array.isArray(contacts)?contacts:[]).find(contact=>contact.id===session.me.id||contact.number===session.me.id.split("@")[0])||{};const photo=await providerRequest(`/api/contacts/profile-picture?contactId=${encodeURIComponent(session.me.id)}&session=${encodeURIComponent(session.name)}`);view.picture=photo?.profilePictureURL||photo?.url||null;view.mentionNames=[view.label,view.profile,self.name,self.pushName,self.shortName,view.phone].filter(Boolean)}catch{view.picture=null;view.mentionNames=[view.label,view.profile,view.phone].filter(Boolean)}
  return view;
}
function normalizedTimestamp(value){const numeric=Number(value);if(Number.isFinite(numeric)&&numeric>0)return numeric>1e12?Math.floor(numeric/1000):numeric;const parsed=Date.parse(value);return Number.isFinite(parsed)?Math.floor(parsed/1000):0;}
const config = label => label ? ({metadata:{'gakai.label':label}}) : {};
function chatOverview(chat) {
  return { id:chat.id, name:chat.name, picture:chat.picture || null, unreadCount:Number(chat.unreadCount ?? chat.unreadMessagesCount ?? chat._chat?.unreadCount ?? 0) || 0,
    timestamp:normalizedTimestamp(chat.timestamp || chat.lastMessage?.timestamp || 0),
    lastMessage:chat.lastMessage ? {body:chat.lastMessage.body || '', text:chat.lastMessage.text || '', timestamp:chat.lastMessage.timestamp || 0, hasMedia:Boolean(chat.lastMessage.hasMedia)} : null };
}
function messageView(message) {
  const participant=message.participant && typeof message.participant==='object'?message.participant:{};
  const senderId=participant.id||message.participant||message.author||message.from||null;
  const senderName=participant.name||message.participantName||message.authorName||message.pushName||message.notifyName||message._data?.notifyName||null;
  const senderPicture=participant.picture||message.participantPicture||message.authorPicture||message.profilePictureUrl||null;
  const rawPreview=message.linkPreview||message.preview||message._data?.linkPreview||(message._data?.links?.[0]?{url:message._data.links[0].link||message._data.links[0].url||message.body||message.text||"",title:message._data.title||"",description:message._data.description||message._data.text||"",image:message._data.botReelPluginThumbnailCdnUrl||message._data.thumbnailHQ||message._data.thumbnailUrl||null}:null);
  return { id:message.id, timestamp:message.timestamp || 0, fromMe:Boolean(message.fromMe), body:message.body || '', text:message.text || '',
    hasMedia:Boolean(message.hasMedia), media:message.media ? {url:message.media.url || null, mimetype:message.media.mimetype || null, filename:message.media.filename || null} : null, mediaUrl:message.mediaUrl || null, vCards:Array.isArray(message.vCards)?message.vCards:(Array.isArray(message._data?.vCards)?message._data.vCards:[]), sender:senderId?{id:senderId,name:senderName,picture:senderPicture}:null, linkPreview:rawPreview?{url:rawPreview.url||rawPreview.canonicalUrl||message.body||message.text||'',title:rawPreview.title||rawPreview.titleText||'',description:rawPreview.description||rawPreview.desc||'',image:rawPreview.thumbnail||rawPreview.thumbnailUrl||rawPreview.image||rawPreview.imageUrl||null}:null, ack:message.ack, ackName:message.ackName };
}
const contactsListCache=new Map();
async function contactsFor(session){
  const cached=contactsListCache.get(session);if(cached)return await cached;
  const task=providerRequest(`/api/contacts/all?session=${encodeURIComponent(session)}`).catch(error=>{contactsListCache.delete(session);throw error});contactsListCache.set(session,task);return await task;
}
const contactCache=new Map();
async function resolveContact(session,rawId){
  const key=`${session}:${rawId}`;if(contactCache.has(key))return contactCache.get(key);
  let contactId=String(rawId||'');
  try{
    if(contactId.endsWith('@lid')){
      const lid=await providerRequest(`/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(contactId)}`);
      const mapped=typeof lid==='string'?lid:(lid.phoneNumber||lid.phone||lid.pn||lid.id||lid.chatId||lid.data?.phoneNumber||lid.data?.id||null);
      if(mapped){contactId=String(mapped);if(!contactId.includes('@'))contactId+='@c.us'}
    }
    const contacts=await contactsFor(session);
    const contact=(Array.isArray(contacts)?contacts:[]).find(item=>item.id===contactId||item.number===contactId.replace(/@.*$/,'')||item.lid===rawId)||{};
    const picture=await providerRequest(`/api/contacts/profile-picture?contactId=${encodeURIComponent(contactId)}&session=${encodeURIComponent(session)}`).catch(()=>null);
    const value={id:contactId,name:contact.name||contact.pushName||contact.shortName||contact.verifiedName||null,picture:picture?.profilePictureURL||picture?.url||null};contactCache.set(key,value);return value;
  }catch{const value={id:contactId,name:null,picture:null};contactCache.set(key,value);return value}
}
const automationSummary=subscription=>({id:subscription.id,accountId:subscription.accountId,name:subscription.name,url:subscription.url,enabled:subscription.enabled,events:subscription.events,secret:subscription.secret,createdAt:subscription.createdAt,lastDelivery:subscription.lastDelivery||null});
async function automationFetch(subscription,event){
  const request=url=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-gakai-secret':subscription.secret,'x-gakai-event-id':event.id,'user-agent':'Gakai/1.0'},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});
  let response=await request(subscription.url);
  if(!response.ok&&event.source==='test'&&response.status===404&&subscription.url.includes('/webhook/'))response=await request(subscription.url.replace('/webhook/','/webhook-test/'));
  return response;
}
async function deliverAutomation(subscription,event){subscription.secret=ensureN8nKey(subscription.accountId);
  const started=Date.now();
  try{const response=await automationFetch(subscription,event);subscription.lastDelivery={at:new Date().toISOString(),ok:response.ok,status:response.status,durationMs:Date.now()-started};if(!response.ok)throw new Error(`Webhook returned ${response.status}`)}
  catch(error){subscription.lastDelivery={at:new Date().toISOString(),ok:false,error:error.message||"Delivery failed",durationMs:Date.now()-started};throw error}
  finally{await persist()}
}
async function dispatchAutomationEvent(payload){
  if(payload?.event!=="message"||payload?.payload?.fromMe)return;const accountId=String(payload.session||"");if(!accountId)return;const message=messageView(payload.payload||{}),chatId=payload.payload?.from||payload.payload?.chatId||null,event={id:`evt_${payload.payload?.id||randomBytes(12).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id:accountId},chat:{id:chatId,kind:String(chatId||"").endsWith("@g.us")?"group":"direct"},message,source:"whatsapp"};await Promise.allSettled(store.automationSubscriptions.filter(subscription=>subscription.accountId===accountId&&subscription.enabled&&subscription.events.includes(event.type)).map(subscription=>deliverAutomation(subscription,event)));
}

function ensureN8nKey(accountId){
  let key=store.keys.find(item=>item.accountId===accountId&&item.name==='n8n integration');
  if(key?.token)return key.token;
  const token=`wh_live_${randomBytes(24).toString('base64url')}`;
  if(key){key.token=token;key.hash=hash(token);key.lastUsedAt=null}else store.keys.push({id:randomBytes(8).toString('hex'),accountId:accountId,name:'n8n integration',scopes:['messages:read','messages:send'],createdAt:new Date().toISOString(),lastUsedAt:null,token,hash:hash(token)});
  return token;
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
  if(view.sender?.id){
    const resolved=await resolveContact(session,view.sender.id);
    view.sender={...view.sender,id:resolved.id||view.sender.id,name:resolved.name||view.sender.name||String(resolved.id||view.sender.id).replace(/@(c|s|g)\.us$/,''),picture:resolved.picture||view.sender.picture||null};
  }
  if(view.linkPreview)view.linkPreview.image=normalizedPreviewImage(view.linkPreview.image);
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
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const key=store.keys.find(k=>k.hash===hash(token));
    if(!key)return send(res,401,{message:'Invalid integration key'});key.lastUsedAt=new Date().toISOString();persist();
    const endpoint=url.pathname.slice('/api/integrations/v1/'.length);
    if(req.method==='GET'&&endpoint==='chats'&&key.scopes.includes('messages:read')){const chats=await providerRequest(`/api/${encodeURIComponent(key.accountId)}/chats/overview?limit=35`);return send(res,200,{accountId:key.accountId,chats:chats.map(chatOverview).sort((a,b)=>b.timestamp-a.timestamp)});}
    if(req.method==='GET'&&endpoint==='messages'&&key.scopes.includes('messages:read')){const chatId=url.searchParams.get('chatId');if(!chatId)return send(res,400,{message:'chatId is required'});const messages=await providerRequest(`/api/${encodeURIComponent(key.accountId)}/chats/${encodeURIComponent(chatId)}/messages?limit=30&downloadMedia=false`);return send(res,200,{messages:messages.map(messageView).sort((a,b)=>a.timestamp-b.timestamp)});}
    if(req.method==='POST'&&endpoint==='messages'&&key.scopes.includes('messages:send')){const input=await readBody(req);if(!input.chatId||!input.text)return send(res,400,{message:'chatId and text are required'});const sent=await providerRequest('/api/sendText',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:key.accountId,chatId:input.chatId,text:input.text})});return send(res,200,{message:messageView(sent||{})});}
    return send(res,403,{message:'This integration key does not have permission for that action'});

  }
  if(url.pathname==='/api/app/auth/state'&&req.method==='GET')return send(res,200,{setup:!store.password,hasUsername:Boolean(store.username),authenticated:admin(req)});
  if(req.method==='GET'&&url.pathname==='/api/app/link-preview'){return send(res,200,await openGraphPreview(url.searchParams.get('url')||''));}
  if(req.method==='GET'&&url.pathname==='/api/app/link-image'){const image=await safePublicUrl(url.searchParams.get('url')||'');if(!image)return send(res,400,{message:'Invalid public image URL'});const response=await fetch(image,{redirect:'manual',headers:{'user-agent':'Mozilla/5.0 (compatible; Gakai/1.0)'},signal:AbortSignal.timeout(10000)});if(!response.ok)return send(res,502,{message:'Preview image unavailable'});const type=response.headers.get('content-type')||'image/jpeg';if(!type.startsWith('image/'))return send(res,502,{message:'Invalid preview image'});const body=Buffer.from(await response.arrayBuffer());if(body.length>5*1024*1024)return send(res,413,{message:'Preview image is too large'});res.writeHead(200,{'content-type':type,'cache-control':'private, max-age=3600','content-length':String(body.length)});return res.end(body);}
  if(url.pathname==='/api/app/auth/setup'&&req.method==='POST'){if(store.password)return send(res,409,{message:'Administrator already configured'});const {username,password}=await readBody(req);const name=String(username||'').trim();if(name.length<3||name.length>40)return send(res,400,{message:'Use a username between 3 and 40 characters'});if(!password||password.length<10)return send(res,400,{message:'Use a password with at least 10 characters'});store.username=name;store.password=passwordHash(password);await persist();const token=randomBytes(32).toString('hex');sessions.set(token,true);res.writeHead(201,{'set-cookie':`home_session=${token}; HttpOnly; SameSite=Strict; Path=/`,'content-type':'application/json'});return res.end(JSON.stringify({ok:true}));}
  if(url.pathname==='/api/app/auth/login'&&req.method==='POST'){const {username,password}=await readBody(req);const expectedUsername=store.username;if(!store.password||(expectedUsername&&String(username||'').trim()!==expectedUsername)||!passwordMatches(password||''))return send(res,401,{message:'Incorrect username or password'});const token=randomBytes(32).toString('hex');sessions.set(token,true);res.writeHead(200,{'set-cookie':`home_session=${token}; HttpOnly; SameSite=Strict; Path=/`,'content-type':'application/json'});return res.end(JSON.stringify({ok:true}));}
  if(url.pathname==="/api/app/auth/profile"&&req.method==="GET"){if(!admin(req))return send(res,401,{message:"Sign in required"});return send(res,200,{username:store.username||null});}
  if(url.pathname==="/api/app/auth/profile"&&req.method==="PATCH"){if(!admin(req))return send(res,401,{message:"Sign in required"});const input=await readBody(req),username=String(input.username||"").trim(),currentPassword=String(input.currentPassword||"");if(!currentPassword||!passwordMatches(currentPassword))return send(res,401,{message:"Current password is incorrect"});if(username&&(username.length<3||username.length>40))return send(res,400,{message:"Use a username between 3 and 40 characters"});if(input.newPassword&&String(input.newPassword).length<10)return send(res,400,{message:"Use a password with at least 10 characters"});if(username)store.username=username;if(input.newPassword)store.password=passwordHash(String(input.newPassword));await persist();return send(res,200,{ok:true,username:store.username});}
  if(!admin(req))return send(res,401,{message:'Sign in required'});
  if(req.method==='GET'&&url.pathname==='/api/app/media'){const path=url.searchParams.get('path')||'';const range=req.headers.range;if(range){const file=await providerFile(path,{range});const body=Buffer.from(await file.arrayBuffer());const headers={'content-type':file.headers.get('content-type')||'application/octet-stream','cache-control':'private, max-age=86400','accept-ranges':file.headers.get('accept-ranges')||'bytes','content-length':String(body.length)};const contentRange=file.headers.get('content-range');if(contentRange)headers['content-range']=contentRange;res.writeHead(file.status,headers);return res.end(body)}const file=await cachedMedia(path);res.writeHead(200,{'content-type':file.type,'cache-control':'private, max-age=86400','accept-ranges':'bytes','content-length':String(file.buffer.length)});return res.end(file.buffer);}
  if (req.method==='GET' && url.pathname==='/api/app/accounts') {const sessions=await providerRequest('/api/sessions');const deleting=new Set(store.deletingAccounts||[]);const visible=sessions.filter(session=>!deleting.has(session.name));const live=new Set(sessions.map(session=>session.name));const next=(store.deletingAccounts||[]).filter(id=>live.has(id));if(next.length!==store.deletingAccounts.length){store.deletingAccounts=next;await persist()}return send(res,200,{accounts:await Promise.all(visible.map(accountView))});}
  if(req.method==='GET'&&url.pathname==='/api/app/instagram-preview'){return send(res,200,await instagramPreview(url.searchParams.get('url')||''));}
  if(req.method==='GET'&&url.pathname==='/api/app/instagram-image'){const image=safeInstagramImage(url.searchParams.get('url')||'');if(!image)return send(res,400,{message:'Invalid Instagram image URL'});const response=await fetch(image,{headers:{'user-agent':'Mozilla/5.0 (compatible; Gakai/1.0)'},signal:AbortSignal.timeout(10000)});if(!response.ok)return send(res,502,{message:'Instagram image unavailable'});const type=response.headers.get('content-type')||'image/jpeg';if(!type.startsWith('image/'))return send(res,502,{message:'Invalid Instagram image'});const body=Buffer.from(await response.arrayBuffer());if(body.length>5*1024*1024)return send(res,413,{message:'Instagram image is too large'});res.writeHead(200,{'content-type':type,'cache-control':'private, max-age=3600','content-length':String(body.length)});return res.end(body);}
  if (req.method==='GET' && url.pathname==='/api/app/accounts') {const sessions=await providerRequest('/api/sessions');return send(res,200,{accounts:await Promise.all(sessions.map(accountView))});}
  if (req.method==='POST' && url.pathname==='/api/app/accounts') {
    const input=await readBody(req), id=`account-${Date.now().toString(36)}`;
    const created=await providerRequest('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:id,config:config(input.label)})});
    return send(res,201,{account:account(created || {name:id,status:'STARTING',config:config(input.label)})});
  }
  const id=decodeURIComponent(parts[3] || '');
  if (req.method==='DELETE' && parts.length===4) {if(!store.deletingAccounts.includes(id)){store.deletingAccounts.push(id);await persist()}await providerRequest(`/api/sessions/${encodeURIComponent(id)}`,{method:'DELETE'});return send(res,200,{ok:true});}
  if (req.method==="DELETE" && parts.length===4) {await providerRequest(`/api/sessions/${encodeURIComponent(id)}`,{method:"DELETE"});return send(res,200,{ok:true});}
  if (req.method==='GET' && parts[4]==='qr') return send(res,200,await providerRequest(`/api/${encodeURIComponent(id)}/auth/qr`));
  if (req.method==='POST' && parts[4]==='start') return send(res,200,(await providerRequest(`/api/sessions/${encodeURIComponent(id)}/start`,{method:'POST'})) || {ok:true});
  if (req.method==='POST' && parts[4]==='restart') return send(res,200,(await providerRequest(`/api/sessions/${encodeURIComponent(id)}/restart`,{method:'POST'})) || {ok:true});
  if(req.method==='POST'&&parts[4]==='chats'&&parts[5]&&parts[6]==='read'){await providerRequest(`/api/${encodeURIComponent(id)}/chats/${encodeURIComponent(decodeURIComponent(parts[5]))}/messages/read`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});return send(res,200,{ok:true});}
  if(req.method==='DELETE'&&parts[4]==='chats'&&parts[5]){await providerRequest(`/api/${encodeURIComponent(id)}/chats/${encodeURIComponent(decodeURIComponent(parts[5]))}`,{method:'DELETE'});return send(res,200,{ok:true});}
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
    const chats=await providerRequest(`/api/${encodeURIComponent(id)}/chats/overview?limit=35`);
    return send(res,200,chats.map(chatOverview).sort((a,b) => b.timestamp - a.timestamp));
  }
  if (req.method==='GET' && parts[4]==='contact') {const contactId=url.searchParams.get('contactId');if(!contactId)return send(res,400,{message:'contactId is required'});return send(res,200,{contact:await resolveContact(id,contactId)});}
  if (req.method==='GET' && parts[4]==='messages') {
    const chatId=url.searchParams.get('chatId'); if (!chatId) return send(res,400,{message:'chatId is required'});
    const limit=Math.min(Math.max(Number(url.searchParams.get('limit')) || 15, 1), 60);
    const offset=Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    // The first screen must be fast. Media download is intentionally opt-in,
    // because the provider may need to retrieve every attachment before replying.
    const downloadMedia=url.searchParams.get('media') === '1';
    const messages=await providerRequest(`/api/${encodeURIComponent(id)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&offset=${offset}&downloadMedia=${downloadMedia}`);
    return send(res,200,(await Promise.all(messages.map(message=>enrichMessage(id,message)))).sort((a,b) => a.timestamp - b.timestamp));
  }
  if (req.method==='GET' && parts[4]==='message-media') {
    const chatId=url.searchParams.get('chatId'),messageId=url.searchParams.get('messageId');
    if(!chatId||!messageId)return send(res,400,{message:'chatId and messageId are required'});
    return send(res,200,{message:await enrichMessage(id,await providerRequest(`/api/${encodeURIComponent(id)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?downloadMedia=true`))});
  }
  if (req.method==='POST' && parts[4]==='messages') {
    const input=await readBody(req); if (!input.chatId || !input.text?.trim()) return send(res,400,{message:'Recipient and message are required'});
    const sent=await providerRequest('/api/sendText',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:id,chatId:input.chatId,text:input.text.trim()})});
    return send(res,200,{message:messageView(sent || {})});
  }
  if(req.method==='PATCH'&&parts[4]==='label') {const input=await readBody(req);const session=await providerRequest(`/api/sessions/${encodeURIComponent(id)}`);const next={...(session.config||{}),metadata:{...(session.config?.metadata||{}),'gakai.label':String(input.label||'WhatsApp account').slice(0,80)}};await providerRequest(`/api/sessions/${encodeURIComponent(id)}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({config:next})});return send(res,200,{ok:true});}
  if(parts[4]==="integration-keys"&&parts[5]==="n8n"&&req.method==="GET"){const key=store.keys.find(k=>k.accountId===id&&k.name==="n8n integration");return send(res,200,{token:key?.token||null});}
  if(parts[4]==="integration-keys"&&parts[5]==="n8n"&&req.method==="POST"){let key=store.keys.find(k=>k.accountId===id&&k.name==="n8n integration");const token=`wh_live_${randomBytes(24).toString("base64url")}`;if(key){key.token=token;key.hash=hash(token);key.lastUsedAt=null}else{key={id:randomBytes(8).toString("hex"),accountId:id,name:"n8n integration",scopes:["messages:read","messages:send"],createdAt:new Date().toISOString(),lastUsedAt:null,token,hash:hash(token)}}store.keys=store.keys.filter(item=>item===key||!(item.accountId===id&&item.name==="n8n integration"));store.keys.push(key);await persist();return send(res,200,{token});}
  if(parts[4]==="integration-keys"&&req.method==="GET")return send(res,200,{keys:store.keys.filter(k=>k.accountId===id).map(({hash,token,...key})=>key)});
  if(parts[4]==="integration-keys"&&req.method==="POST"){const input=await readBody(req);const token=`wh_live_${randomBytes(24).toString("base64url")}`;const key={id:randomBytes(8).toString("hex"),accountId:id,name:String(input.name||"Integration").slice(0,80),scopes:Array.isArray(input.scopes)?input.scopes:["messages:read","messages:send"],createdAt:new Date().toISOString(),lastUsedAt:null,hash:hash(token)};store.keys.push(key);await persist();return send(res,201,{key:{...key,hash:undefined},token});}
  if(parts[4]==="automations"&&req.method==="GET")return send(res,200,{subscriptions:store.automationSubscriptions.filter(subscription=>subscription.accountId===id).map(automationSummary)});
  if(parts[4]==="automations"&&req.method==="GET")return send(res,200,{subscriptions:store.automationSubscriptions.filter(subscription=>subscription.accountId===id).map(automationSummary)});
  if(parts[4]==="automations"&&parts[5]==="test-delivery"&&req.method==="POST"){const input=await readBody(req),url=await safePublicUrl(input.url||""),secret=String(input.secret||"").trim();if(!url||url.protocol!=="https:")return send(res,400,{message:"Use the public HTTPS n8n test webhook URL"});if(!secret||secret.length>256)return send(res,400,{message:"Enter the Header Auth secret"});const event={id:`evt_test_${randomBytes(8).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id},chat:{id:"demo@c.us",kind:"direct"},message:{id:"demo-message",timestamp:Math.floor(Date.now()/1000),fromMe:false,body:"This is a Gakai test event.",text:"This is a Gakai test event.",hasMedia:false,media:null},source:"test"};try{const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-gakai-secret":secret,"x-gakai-event-id":event.id,"user-agent":"Gakai/1.0"},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});if(!response.ok)return send(res,502,{message:`Webhook returned ${response.status}`});return send(res,200,{ok:true})}catch(error){return send(res,502,{message:error.message||"Test delivery failed"})}}
  if(parts[4]==="automations"&&!parts[5]&&req.method==="POST"){const input=await readBody(req);const url=n8nWebhookUrl(input.url||""),requestedSecret=String(input.secret||"").trim();if(!url)return send(res,400,{message:"Use an HTTPS n8n production webhook URL"});if(requestedSecret.length>256)return send(res,400,{message:"Invalid Header Auth secret"});const subscription={id:randomBytes(8).toString("hex"),accountId:id,name:String(input.name||"n8n automation").trim().slice(0,80)||"n8n automation",url:url.href,enabled:true,events:["message.received"],secret:requestedSecret||ensureN8nKey(id),createdAt:new Date().toISOString(),lastDelivery:null};store.automationSubscriptions=store.automationSubscriptions.filter(item=>item.accountId!==id);store.automationSubscriptions.push(subscription);await persist();return send(res,201,{subscription:automationSummary(subscription),secret:subscription.secret});}
  if(parts[4]==="automations"&&parts[5]&&req.method==="PATCH"){const subscription=store.automationSubscriptions.find(item=>item.id===parts[5]&&item.accountId===id);if(!subscription)return send(res,404,{message:"Automation not found"});const input=await readBody(req);if(typeof input.enabled==="boolean")subscription.enabled=input.enabled;await persist();return send(res,200,{subscription:automationSummary(subscription)});}
  if(parts[4]==="automations"&&parts[5]&&parts[6]==="test"&&req.method==="POST"){const subscription=store.automationSubscriptions.find(item=>item.id===parts[5]&&item.accountId===id);if(!subscription)return send(res,404,{message:"Automation not found"});const event={id:`evt_test_${randomBytes(8).toString("hex")}`,type:"message.received",occurredAt:new Date().toISOString(),account:{id},chat:{id:"demo@c.us",kind:"direct"},message:{id:"demo-message",timestamp:Math.floor(Date.now()/1000),fromMe:false,body:"This is a Gakai test event.",text:"This is a Gakai test event.",hasMedia:false,media:null},source:"test"};try{await deliverAutomation(subscription,event);return send(res,200,{ok:true,subscription:automationSummary(subscription)})}catch(error){return send(res,502,{message:error.message,subscription:automationSummary(subscription)})}}
  if(parts[4]==="automations"&&parts[5]&&req.method==="DELETE"){store.automationSubscriptions=store.automationSubscriptions.filter(item=>!(item.id===parts[5]&&item.accountId===id));await persist();return send(res,200,{ok:true});}
  if(parts[4]==='integration-keys'&&req.method==='DELETE'){const keyId=parts[5];store.keys=store.keys.filter(k=>!(k.id===keyId&&k.accountId===id));await persist();return send(res,200,{ok:true});}
  return send(res,404,{message:'Not found'});
}
http.createServer(async (req,res)=>{ const url=new URL(req.url,`http://${req.headers.host}`); try {
  if (url.pathname === '/healthz' || url.pathname === '/readyz' || url.pathname.startsWith('/api/')) return await api(req,res,url);
  const requested=(url.pathname==='/'||url.pathname.startsWith('/accounts/'))?'/index.html':url.pathname, file=normalize(join(publicDir,requested));
  if (!file.startsWith(publicDir)) return send(res,403,{message:'Forbidden'});
  const content=await readFile(file); res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-cache'}); res.end(content);
} catch(error) { console.error(error); send(res,error.status||502,{message:error.message||'Service unavailable'}); }}).listen(port,'0.0.0.0',()=>console.log(`Gakai is ready at ${publicUrl}`));
