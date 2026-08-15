const root=document.querySelector('#app');
const s={accounts:[],account:null,chats:[],chat:null,messages:[],view:'inbox',adding:false,qr:''};
const esc=(v='')=>String(v).replace(/[&<>'"]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[x]));
const api=async(p,o={})=>{const r=await fetch(p,{headers:{'content-type':'application/json'},...o}),d=await r.json();if(!r.ok)throw Error(d.message||'Request failed');return d};
const current=()=>s.account?.id;
const status=x=>({WORKING:'Connected',SCAN_QR_CODE:'Ready to scan',STARTING:'Connecting',STOPPED:'Offline',FAILED:'Needs attention'})[x]||x;
const avatar=c=>c?.picture?`<img class="avatar" src="${esc(c.picture)}" referrerpolicy="no-referrer" alt="">`:`<span class="avatar avatar-letter">${esc((c?.name||c?.label||'?')[0].toUpperCase())}</span>`;
const media=m=>{const url=m.media?.url||m.mediaUrl;if(!url)return '';try{const source=new URL(url),path=source.pathname+source.search;if(!source.pathname.startsWith('/api/files/'))return '';const src=`/api/app/media?path=${encodeURIComponent(path)}`,type=m.media?.mimetype||'',name=m.media?.filename||'Attachment';if(type.startsWith('video/'))return `<video class="media" src="${src}" controls preload="metadata" playsinline></video>`;if(type.startsWith('audio/'))return `<audio class="media-audio" src="${src}" controls></audio>`;if(type.startsWith('image/'))return `<img class="media" src="${src}" alt="Shared image">`;return `<a class="file-card" href="${src}" download><span class="file-icon">↧</span><span><b>${esc(name)}</b><small>${esc(type||'Document')}</small></span></a>`}catch{return ''}};
const notice=x=>{const e=document.createElement('div');e.className='toast';e.textContent=x;document.body.append(e);setTimeout(()=>e.remove(),3200)};

function pairing(){const a=s.account;return `<main class="pairing"><section class="pair-card"><span class="eyebrow">GAKAI</span><h1>${a?'Reconnect this account':'Connect your WhatsApp'}</h1><p>${a?'Your account needs a fresh WhatsApp link.':'Scan once and your account will stay connected after restarts.'}</p>${a?.status==='SCAN_QR_CODE'?`<img class="qr" src="${s.qr}" alt="WhatsApp pairing QR code">`:a?.status==='STARTING'?'<div class="qr loading">Preparing your secure connection…</div>':`<label>Account label <input id="account-name" placeholder="Personal WhatsApp"></label>`}<ol><li>Open WhatsApp on your phone</li><li>Choose <b>Linked devices</b></li><li>Tap <b>Link a device</b> and scan</li></ol><div class="pair-status"><i></i>${a?.status==='SCAN_QR_CODE'?'Waiting for scan…':a?.status==='FAILED'?'A fresh connection is needed.':'No API keys or technical setup required.'}</div>${!a?'<button class="primary wide" id="create">Continue to QR code</button>':''}${a?.status==='FAILED'?'<button class="primary wide" id="retry">Try again</button>':''}</section></main>`}
function sidebar(){return `<aside class="sidebar"><div class="logo"><b>G</b> Gakai</div><div class="account-switch">${s.accounts.map(a=>`<button data-account="${esc(a.id)}" class="account ${a.id===current()?'selected':''}"><i class="${a.status==='WORKING'?'good':''}"></i><span>${esc(a.label)}<small>${status(a.status)}</small></span></button>`).join('')}</div></aside>`}
function inbox(){if(s.account?.status!=='WORKING')return `<header><h2>Inbox</h2></header><main class="empty"><h1>${esc(s.account?.label||'Account')} needs attention</h1><p>Reconnect this account to continue.</p><button id="reconnect" class="primary">Reconnect account</button></main>`;return `<header><div><h2>Inbox</h2><small>${esc(s.account.label)} · ${status(s.account.status)}</small></div><button id="add" class="primary">+ Connect account</button></header><div class="inbox"><section class="chats ${s.chat?'mobile-hide':''}"><input id="search" placeholder="Search conversations">${s.chats.map(c=>`<button class="chat ${s.chat?.id===c.id?'active':''}" data-chat="${esc(c.id)}">${avatar(c)}<span><b>${esc(c.name||c.id)}</b><small>${esc(c.lastMessage?.body||c.lastMessage?.text||'Photo or message')}</small></span></button>`).join('')||'<p class="hint">No conversations found.</p>'}</section><section class="conversation ${!s.chat?'mobile-hide':''}">${s.chat?`<div class="conversation-head"><button id="back" class="back">‹</button>${avatar(s.chat)}<b>${esc(s.chat.name||s.chat.id)}</b></div><div class="messages">${s.messages.map(m=>`<article class="message ${m.fromMe?'mine':''}">${media(m)}${esc(m.body||m.text||'')}<time>${new Date((m.timestamp||0)*1000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</time></article>`).join('')}</div><form id="send"><textarea id="text" placeholder="Type a message" rows="1"></textarea><button class="primary">Send</button></form>`:'<div class="blank">Select a conversation</div>'}</section></div>`}
function accounts(){return `<header><h2>Connected accounts</h2><button id="add" class="primary">+ Connect account</button></header><main class="account-page">${s.accounts.map(a=>`<article class="account-card">${avatar(a)}<div><b>${esc(a.label)}</b><p>${esc(a.phone||'Waiting for profile')} · <em class="${a.status==='WORKING'?'ok':''}">${status(a.status)}</em></p></div><button data-open="${esc(a.id)}" class="secondary">Open inbox</button>${a.status==='WORKING'?'':`<button data-repair="${esc(a.id)}" class="primary">Reconnect</button>`}</article>`).join('')}</main>`}
function render(){if(!s.accounts.length||s.view==='pairing'){root.innerHTML=pairing();document.querySelector('#create')?.addEventListener('click',create);document.querySelector('#retry')?.addEventListener('click',()=>restart(current()));return}root.innerHTML=`<div class="app">${sidebar()}<main class="main">${s.view==='accounts'?accounts():inbox()}</main></div>`;document.querySelectorAll('[data-view]').forEach(e=>e.onclick=()=>{s.view=e.dataset.view;render()});document.querySelectorAll('[data-account]').forEach(e=>e.onclick=()=>choose(e.dataset.account));document.querySelector('#add')?.addEventListener('click',()=>{s.adding=true;s.account=null;s.qr='';s.view='pairing';render()});document.querySelector('#reconnect')?.addEventListener('click',()=>{s.view='pairing';render();restart(current())});document.querySelectorAll('[data-repair]').forEach(e=>e.onclick=()=>{s.account=s.accounts.find(a=>a.id===e.dataset.repair);s.view='pairing';render();restart(current())});document.querySelectorAll('[data-open]').forEach(e=>e.onclick=()=>choose(e.dataset.open));document.querySelectorAll('[data-chat]').forEach(e=>e.onclick=()=>openChat(e.dataset.chat));document.querySelector('#back')?.addEventListener('click',()=>{s.chat=null;render()});document.querySelector('#search')?.addEventListener('input',e=>document.querySelectorAll('[data-chat]').forEach(x=>x.hidden=!x.textContent.toLowerCase().includes(e.target.value.toLowerCase())));document.querySelector('#send')?.addEventListener('submit',send)}
let started=false;
async function refresh(){try{const before=JSON.stringify({accounts:s.accounts.map(a=>[a.id,a.status,a.label]),active:current(),view:s.view,qr:s.qr});const d=await api('/api/app/accounts');s.accounts=d.accounts;if(!s.adding)s.account=s.account&&d.accounts.find(a=>a.id===s.account.id)||d.accounts.find(a=>a.status!=='WORKING')||d.accounts[0]||null;let qrChanged=false;if(s.account?.status==='SCAN_QR_CODE')qrChanged=await loadQr();if(s.account?.status==='WORKING'&&s.view==='pairing'&&!s.adding){s.view='inbox';await loadChats()}const after=JSON.stringify({accounts:s.accounts.map(a=>[a.id,a.status,a.label]),active:current(),view:s.view,qr:s.qr});if(!started||before!==after||qrChanged)render();started=true}catch(e){console.warn(e)}}
async function create(){try{const d=await api('/api/app/accounts',{method:'POST',body:JSON.stringify({label:document.querySelector('#account-name').value})});s.adding=false;s.account=d.account;s.accounts.push(d.account);render();setTimeout(refresh,800)}catch(e){notice(e.message)}}
async function restart(id){try{await api(`/api/app/accounts/${encodeURIComponent(id)}/restart`,{method:'POST'});setTimeout(refresh,700)}catch(e){try{await api(`/api/app/accounts/${encodeURIComponent(id)}/start`,{method:'POST'});setTimeout(refresh,700)}catch(x){notice(x.message)}}}
async function loadQr(){try{let d=await api(`/api/app/accounts/${encodeURIComponent(current())}/qr`);d=typeof d==='string'?d:(d.value||d.qr||d.data||'');const next=d.startsWith('data:')?d:`data:image/png;base64,${d}`;const changed=next!==s.qr;s.qr=next;return changed}catch(e){console.warn(e);return false}}
async function choose(id){s.adding=false;s.account=s.accounts.find(a=>a.id===id);s.chat=null;s.view=s.account.status==='WORKING'?'inbox':'pairing';if(s.view==='inbox')await loadChats();render()}
async function loadChats(){try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/chats`);s.chats=Array.isArray(d)?d:d.chats||[]}catch(e){notice(e.message)}}
async function openChat(id){s.chat=s.chats.find(c=>c.id===id);try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(id)}`);s.messages=Array.isArray(d)?d:d.messages||[]}catch(e){notice(e.message)}render()}
async function send(e){e.preventDefault();const text=document.querySelector('#text').value.trim();if(!text)return;try{await api(`/api/app/accounts/${encodeURIComponent(current())}/messages`,{method:'POST',body:JSON.stringify({chatId:s.chat.id,text})});await openChat(s.chat.id)}catch(e){notice(e.message)}}
const previousRender=render,previousOpenChat=openChat;
function bottom(){requestAnimationFrame(()=>{const e=document.querySelector('.messages');if(e)e.scrollTop=e.scrollHeight})}
render=()=>{previousRender();document.querySelector('#text')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.currentTarget.form.requestSubmit()}});if(s.chat)bottom()};
openChat=async id=>{s.chat=s.chats.find(c=>c.id===id);s.messages=[];render();try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(id)}&limit=15`);if(s.chat?.id!==id)return;s.messages=(Array.isArray(d)?d:d.messages||[]).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));render();loadOlder(id)}catch(error){notice(error.message)}};
async function loadOlder(id){try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(id)}&limit=45&offset=15`);if(s.chat?.id!==id)return;const all=[...s.messages,...(Array.isArray(d)?d:d.messages||[])];s.messages=[...new Map(all.map(m=>[m.id,m])).values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));render()}catch(error){console.warn(error)}}
send=async e=>{e.preventDefault();const text=document.querySelector('#text').value.trim();if(!text)return;const pending={id:`pending-${Date.now()}`,body:text,fromMe:true,timestamp:Math.floor(Date.now()/1000),ackName:'PENDING'};s.messages.push(pending);render();try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages`,{method:'POST',body:JSON.stringify({chatId:s.chat.id,text})});const i=s.messages.findIndex(m=>m.id===pending.id);if(i>=0)s.messages[i]={...pending,...d.message};render()}catch(error){s.messages=s.messages.filter(m=>m.id!==pending.id);render();notice(error.message)}};
let chatRequest=0;
const progressiveOpenChat=openChat;
openChat=async id=>{const request=++chatRequest;s.chat=s.chats.find(c=>c.id===id);s.messages=[];render();for(let attempt=0;attempt<3;attempt++){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(id)}&limit=15`,{signal:controller.signal});clearTimeout(timeout);if(request!==chatRequest||s.chat?.id!==id)return;s.messages=(Array.isArray(d)?d:d.messages||[]).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));render();hydrateMedia(id,request);loadOlderSafe(id,request);return}catch(error){clearTimeout(timeout);if(attempt<2)await new Promise(resolve=>setTimeout(resolve,350*(attempt+1)))}}if(request===chatRequest){s.messages=[{id:'load-error',body:'Messages could not be loaded. Select this chat again to retry.',fromMe:false,timestamp:Math.floor(Date.now()/1000)}];render();notice('Could not load messages after three attempts.')}};
async function loadOlderSafe(id,request){try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(id)}&limit=45&offset=15`);if(request!==chatRequest||s.chat?.id!==id)return;const all=[...s.messages,...(Array.isArray(d)?d:d.messages||[])];s.messages=[...new Map(all.map(m=>[m.id,m])).values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));render()}catch(error){console.warn('Older history deferred',error)}}
async function hydrateMedia(chatId,request){const targets=s.messages.filter(m=>m.hasMedia&&!m.media?.url).slice(0,6);await Promise.all(targets.map(async message=>{try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/message-media?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(message.id)}`);if(request!==chatRequest||s.chat?.id!==chatId)return;Object.assign(message,d.message)}catch(error){console.warn('Media preview unavailable',error)}}));if(request===chatRequest&&s.chat?.id===chatId)render()}
function touchChat(chatId,text){const chat=s.chats.find(c=>c.id===chatId);if(!chat)return;chat.timestamp=Math.floor(Date.now()/1000);chat.lastMessage={...(chat.lastMessage||{}),body:text,text,timestamp:chat.timestamp};s.chats.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));s.chat=chat}
const previousSend=send;
send=async e=>{e.preventDefault();const text=document.querySelector('#text').value.trim();if(!text)return;touchChat(s.chat.id,text);const pending={id:`pending-${Date.now()}`,body:text,fromMe:true,timestamp:Math.floor(Date.now()/1000),ackName:'PENDING'};s.messages.push(pending);render();try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages`,{method:'POST',body:JSON.stringify({chatId:s.chat.id,text})});const i=s.messages.findIndex(m=>m.id===pending.id);if(i>=0)s.messages[i]={...pending,...d.message};render()}catch(error){s.messages=s.messages.filter(m=>m.id!==pending.id);render();notice(error.message)}};
const storedChoose=choose,storedOpen=openChat,storedRefresh=refresh;
choose=async id=>{sessionStorage.setItem('gakai.account',id);sessionStorage.setItem('gakai.view','inbox');await storedChoose(id)};
openChat=async id=>{sessionStorage.setItem(`gakai.chat.${current()}`,id);await storedOpen(id)};
let restoredWorkspace=false;
refresh=async()=>{await storedRefresh();if(restoredWorkspace||!s.accounts.length||s.adding)return;restoredWorkspace=true;const accountId=sessionStorage.getItem('gakai.account');const account=s.accounts.find(a=>a.id===accountId)||s.account;if(!account||account.status!=='WORKING')return;await storedChoose(account.id);const chatId=sessionStorage.getItem(`gakai.chat.${account.id}`);if(chatId&&s.chats.some(c=>c.id===chatId))await storedOpen(chatId)};
function authScreen(setup){root.innerHTML=`<main class="pairing"><section class="pair-card"><span class="eyebrow">GAKAI</span><h1>${setup?'Create your administrator login':'Welcome back'}</h1><p>${setup?'This protects connected accounts and integration keys.':'Sign in to manage your WhatsApp workspace.'}</p><form id="auth"><label>Password<input id="password" type="password" minlength="10" required autocomplete="current-password"></label><button class="primary wide">${setup?'Create secure login':'Sign in'}</button></form></section></main>`;document.querySelector('#auth').onsubmit=async e=>{e.preventDefault();try{await api(`/api/app/auth/${setup?'setup':'login'}`,{method:'POST',body:JSON.stringify({password:document.querySelector('#password').value})});if(setup)sessionStorage.setItem('gakai.first-pairing','1');location.reload()}catch(error){notice(error.message)}}}
async function settings(account){let keys=[];try{keys=(await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys`)).keys}catch(error){notice(error.message)}const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;background:#0009;z-index:9;display:grid;place-items:center;padding:18px';overlay.innerHTML=`<section class="pair-card" style="max-height:90vh;overflow:auto;text-align:left"><button id="close" class="secondary" style="float:right">Close</button><span class="eyebrow">ACCOUNT SETTINGS</span><h1>${esc(account.label)}</h1><p>${esc(account.phone||'WhatsApp profile')} · ${esc(status(account.status))}</p><label>Personal account name<input id="label" value="${esc(account.label)}"></label><button id="save-label" class="primary">Save name</button><hr style="border-color:#293840;margin:24px 0"><h3>Integrations</h3><p>Create a key for an agent or external app. It is shown once and is restricted to this account.</p><label>Integration name<input id="key-name" placeholder="Claude agent"></label><button id="create-key" class="primary">Create integration key</button><div id="new-key"></div><div style="margin-top:18px">${keys.map(k=>`<p><b>${esc(k.name)}</b><br><small>${esc((k.scopes||[]).join(', '))} · ${k.lastUsedAt?'Last used '+esc(k.lastUsedAt):'Never used'}</small> <button class="secondary revoke" data-key="${esc(k.id)}">Revoke</button></p>`).join('')||'<small>No integration keys yet.</small>'}</div></section>`;document.body.append(overlay);overlay.querySelector('#close').onclick=()=>overlay.remove();overlay.querySelector('#save-label').onclick=async()=>{try{await api(`/api/app/accounts/${encodeURIComponent(account.id)}/label`,{method:'PATCH',body:JSON.stringify({label:overlay.querySelector('#label').value})});overlay.remove();await refresh()}catch(error){notice(error.message)}};overlay.querySelector('#create-key').onclick=async()=>{try{const d=await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys`,{method:'POST',body:JSON.stringify({name:overlay.querySelector('#key-name').value,scopes:['messages:read','messages:send']})});overlay.querySelector('#new-key').innerHTML=`<p><b>Copy this key now — it will not be shown again.</b><br><code style="word-break:break-all">${esc(d.token)}</code></p><p><small>Use it as: Authorization: Bearer your-key<br>Endpoints: /api/integrations/v1/chats, /messages</small></p>`}catch(error){notice(error.message)}};overlay.querySelectorAll('.revoke').forEach(button=>button.onclick=async()=>{await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys/${button.dataset.key}`,{method:'DELETE'});overlay.remove();settings(account)})}
const settingsRender=render;render=()=>{settingsRender();document.querySelectorAll('.account').forEach(row=>{const id=row.dataset.account;if(!id)return;const cog=document.createElement('span');cog.className='account-cog';cog.textContent='⚙';cog.setAttribute('role','button');cog.setAttribute('tabindex','0');cog.setAttribute('aria-label','Account settings');cog.onclick=e=>{e.preventDefault();e.stopPropagation();settings(s.accounts.find(a=>a.id===id))};cog.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();settings(s.accounts.find(a=>a.id===id))}};row.append(cog)})};
async function boot(){const state=await (await fetch('/api/app/auth/state')).json();if(!state.authenticated)return authScreen(state.setup,state.setup||state.hasUsername);await refresh();if(!s.accounts.length)await create();setInterval(refresh,10000)}
boot();

// Resource-safe chat loading: never fan out background provider requests. WEBJS
// runs Chromium, so automatic history/media hydration can make the host feel
// unresponsive on a small server. Older history and media are intentionally
// deferred until an explicit UI action is added.
openChat=async id=>{const request=++chatRequest;s.chat=s.chats.find(c=>c.id===id);s.messages=[];render();const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);try{const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(id)}&limit=10`,{signal:controller.signal});clearTimeout(timeout);if(request!==chatRequest||s.chat?.id!==id)return;s.messages=(Array.isArray(d)?d:d.messages||[]).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));render()}catch(error){clearTimeout(timeout);if(request===chatRequest){s.messages=[{id:'load-error',body:'Messages could not be loaded. Select this chat again to retry.',fromMe:false,timestamp:Math.floor(Date.now()/1000)}];render();notice('Could not load messages.')} }};
// Keep the conversation list stable across DOM rebuilds and page older history
// in only when the user reaches the top of the message pane.
let preserveMessagePosition=true;
let historyState={chatId:null,offset:0,loading:false,exhausted:false};
const renderedWithScrollState=render;
render=()=>{
  const chatsTop=document.querySelector('.chats')?.scrollTop;
  const messagesTop=document.querySelector('.messages')?.scrollTop;
  renderedWithScrollState();
  requestAnimationFrame(()=>{
    const chats=document.querySelector('.chats');
    const messages=document.querySelector('.messages');
    if(chats&&chatsTop!==undefined)chats.scrollTop=chatsTop;
    if(messages&&preserveMessagePosition&&messagesTop!==undefined)messages.scrollTop=messagesTop;
    messages?.addEventListener('scroll',onMessageScroll,{passive:true});
  });
};
async function onMessageScroll(event){
  const pane=event.currentTarget;
  if(pane.scrollTop>80||historyState.loading||historyState.exhausted||!s.chat)return;
  const chatId=s.chat.id;
  historyState.loading=true;
  const heightBefore=pane.scrollHeight,topBefore=pane.scrollTop;
  try{
    const d=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(chatId)}&limit=30&offset=${historyState.offset}`);
    if(s.chat?.id!==chatId)return;
    const older=Array.isArray(d)?d:d.messages||[];
    historyState.offset+=older.length;
    historyState.exhausted=older.length<30;
    if(!older.length)return;
    s.messages=[...new Map([...older,...s.messages].map(m=>[m.id,m])).values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
    preserveMessagePosition=false;
    render();
    requestAnimationFrame(()=>{const next=document.querySelector('.messages');if(next)next.scrollTop=topBefore+(next.scrollHeight-heightBefore)});
  }catch(error){console.warn('Older history could not be loaded',error)}finally{historyState.loading=false;requestAnimationFrame(()=>{preserveMessagePosition=true})}
}
const openChatWithHistory=openChat;
openChat=async id=>{
  preserveMessagePosition=false;
  historyState={chatId:id,offset:0,loading:false,exhausted:false};
  try{await openChatWithHistory(id);historyState.offset=s.messages.length;historyState.exhausted=s.messages.length<10}
  finally{requestAnimationFrame(()=>{preserveMessagePosition=true})}
};
const sendWithScrollPosition=send;
send=async event=>{
  preserveMessagePosition=false;
  try{return await sendWithScrollPosition(event)}finally{requestAnimationFrame(()=>{preserveMessagePosition=true})}
};


// Group messages need an author label; this runs after the existing renderer so
// it does not alter the inbox layout or its loading/scroll behaviour.
const renderWithGroupSenders=render;
render=()=>{
  renderWithGroupSenders();
  requestAnimationFrame(()=>{
    document.querySelectorAll('.message').forEach((bubble,index)=>{
      const message=s.messages[index];
      if(!message||bubble.querySelector(".message-sender"))return;
      const sender=message.fromMe?{name:s.account?.label||"You",picture:s.account?.picture||null}:message.sender||{};
      const label=String(sender.name||sender.id||'Unknown sender').replace(/@(c|s|g)\.us$/,'');
      const row=document.createElement('div');row.className='message-sender';
      if(sender.picture){const image=document.createElement('img');image.className='sender-avatar';image.src=sender.picture;image.referrerPolicy='no-referrer';image.alt='';row.append(image)}
      else{const fallback=document.createElement('span');fallback.className='sender-avatar sender-letter';fallback.textContent=(label[0]||'?').toUpperCase();row.append(fallback)}
      const name=document.createElement('b');name.textContent=label;row.append(name);bubble.prepend(row);
    });
  });
};

// The final low-resource chat loader replaces earlier wrappers, so persist the
// selected chat here as well. This is what refresh restoration reads.
const openChatWithWorkspaceRestore=openChat;
openChat=async id=>{
  if(current())sessionStorage.setItem(`gakai.chat.${current()}`,id);
  return openChatWithWorkspaceRestore(id);
};

// Fetch attachment details only for messages the user is currently viewing.
// The provider returns the initial history quickly without the binary/media URL data.
async function loadVisiblePreviews(chatId){
  const messages=s.messages.filter(message=>message.hasMedia&&!message.media?.url&&!message.mediaUrl).slice(0,10);
  for(const message of messages){
    if(s.chat?.id!==chatId)return;
    try{
      const data=await api(`/api/app/accounts/${encodeURIComponent(current())}/message-media?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(message.id)}`);
      if(s.chat?.id!==chatId)return;
      Object.assign(message,data.message||{});
      render();
    }catch(error){console.warn('Attachment preview unavailable',error)}
  }
}
function addLinkCards(){
  requestAnimationFrame(()=>document.querySelectorAll('.message').forEach((bubble,index)=>{
    const preview=s.messages[index]?.linkPreview;
    if(!preview||bubble.querySelector('.link-preview'))return;
    let url;try{url=new URL(preview.url)}catch{return}
    if(!/^https?:$/.test(url.protocol))return;
    const card=document.createElement('a');card.className='link-preview';card.href=url.href;card.target='_blank';card.rel='noopener noreferrer';
    if(preview.image){const image=document.createElement('img');image.src=preview.image;image.referrerPolicy='no-referrer';image.alt='';card.append(image)}
    const detail=document.createElement('span');const title=document.createElement('b');title.textContent=preview.title||url.hostname;detail.append(title);
    if(preview.description){const description=document.createElement('small');description.textContent=preview.description;detail.append(description)}
    const domain=document.createElement('em');domain.textContent=url.hostname;detail.append(domain);card.append(detail);bubble.append(card);
  }));
}
const renderWithPreviews=render;
render=()=>{renderWithPreviews();addLinkCards()};
const openChatWithPreviews=openChat;
openChat=async id=>{await openChatWithPreviews(id);if(s.chat?.id===id)loadVisiblePreviews(id)};

// Resolve group senders and @mentions from WhatsApp LIDs into readable contact
// names (or phone numbers where no saved/display name is available).
async function resolveVisibleGroupIdentities(chatId){
  if(!String(s.chat?.id||'').endsWith('@g.us'))return;
  const identities=new Map();
  for(const message of s.messages){
    if(message.sender?.id)identities.set(message.sender.id,message.sender);
    for(const value of String(message.body||message.text||'').matchAll(/@(\d{5,})/g))identities.set(`${value[1]}@lid`,{id:`${value[1]}@lid`});
  }
  await Promise.all([...identities.values()].slice(0,20).map(async sender=>{
    try{
      const data=await api(`/api/app/accounts/${encodeURIComponent(current())}/contact?contactId=${encodeURIComponent(sender.id)}`);
      const contact=data.contact||{};if(s.chat?.id!==chatId)return;
      sender.lookupId=sender.id;if(contact.id)sender.id=contact.id;if(contact.name)sender.name=contact.name;if(contact.picture)sender.picture=contact.picture;
    }catch(error){console.warn('Group identity lookup unavailable',error)}
  }));
  if(s.chat?.id!==chatId)return;
  const labels=new Map();
  for(const person of identities.values()){
    const label=person.name||String(person.id||'').replace(/@(c|s|g)\.us$/,'');
    if(person.lookupId)labels.set(String(person.lookupId).replace('@lid',''),label);
    labels.set(String(person.id||'').replace(/@(c|s|g)\.us$/,''),label);
  }
  for(const message of s.messages){
    if(message.sender?.lookupId){const person=identities.get(message.sender.lookupId);if(person)Object.assign(message.sender,person)}
    const original=message._identityOriginalBody??(message.body||message.text||'');message._identityOriginalBody=original;
    message.body=String(original).replace(/@(\d{5,})/g,(match,value)=>labels.has(value)?`@${labels.get(value)}`:match);
  }
  render();
}
const openChatWithIdentityResolution=openChat;
openChat=async id=>{await openChatWithIdentityResolution(id);if(s.chat?.id===id)resolveVisibleGroupIdentities(id)};

// Keep a per-account, per-chat reading position across a full browser refresh.
function messageScrollKey(){return s.account&&s.chat?`gakai.scroll.${s.account.id}.${s.chat.id}`:null}
function saveMessageScroll(pane){
  const key=messageScrollKey();if(!key)return;
  sessionStorage.setItem(key,JSON.stringify({top:pane.scrollTop,atBottom:pane.scrollTop+pane.clientHeight>=pane.scrollHeight-4}));
}
const renderWithScrollPersistence=render;
render=()=>{
  renderWithScrollPersistence();
  requestAnimationFrame(()=>{
    const pane=document.querySelector('.messages'),key=messageScrollKey();
    if(!pane||!key)return;
    if(!pane.dataset.scrollPersistence){pane.dataset.scrollPersistence='1';pane.addEventListener('scroll',()=>saveMessageScroll(pane),{passive:true})}
    let saved;try{saved=JSON.parse(sessionStorage.getItem(key)||'null')}catch{}
    if(saved){pane.scrollTop=saved.atBottom?pane.scrollHeight:saved.top}
  });
};

// Workspace controls: collapsible account rail, resilient QR pairing, and
// focused account settings actions.
let sidebarCollapsed=sessionStorage.getItem('gakai.sidebar')==='collapsed';
sidebar=()=>`<aside class="sidebar ${sidebarCollapsed?'collapsed':''}"><div class="logo"><b>G</b><span>Gakai</span><button id="sidebar-toggle" class="icon-button" aria-label="${sidebarCollapsed?'Expand':'Collapse'} sidebar" title="${sidebarCollapsed?'Expand sidebar':'Collapse sidebar'}">${sidebarCollapsed?'›':'‹'}</button></div><div class="account-switch">${s.accounts.map(account=>`<button data-account="${esc(account.id)}" title="${esc(account.label)}" class="account ${account.id===current()?'selected':''}"><i class="${account.status==='WORKING'?'good':''}"></i>${avatar(account)}<span><b>${esc(account.label)}</b><small>${status(account.status)}</small></span></button>`).join('')}</div></aside>`;
pairing=()=>{const account=s.account;return `<main class="pairing"><section class="pair-card"><button id="cancel-pair" class="modal-close" aria-label="Close">×</button><span class="eyebrow">GAKAI</span><h1>${account?'Reconnect this account':'Connect your WhatsApp'}</h1><p>${account?'Scan this new QR code to relink WhatsApp.':'Give this account a name, then scan the QR code from WhatsApp.'}</p>${account?.status==='SCAN_QR_CODE'&&s.qr?`<img class="qr" src="${s.qr}" alt="WhatsApp pairing QR code">`:account?'<div class="qr loading">Preparing a fresh QR code…</div>':`<label>Account label <input id="account-name" placeholder="Personal WhatsApp" autofocus></label>`}<ol><li>Open WhatsApp on your phone</li><li>Choose <b>Linked devices</b></li><li>Tap <b>Link a device</b> and scan</li></ol><div class="pair-status"><i></i>${account?.status==='SCAN_QR_CODE'?'Waiting for scan…':account?'Starting secure connection…':'No API keys or technical setup required.'}</div>${!account?'<button class="primary wide" id="create">Continue to QR code</button>':''}<button class="secondary wide" id="cancel-pair-bottom">Cancel</button></section></main>`};
async function pollForQr(){for(let attempt=0;attempt<15&&s.view==='pairing';attempt++){await new Promise(resolve=>setTimeout(resolve,700));await refresh();if(s.account?.status==='SCAN_QR_CODE'&&s.qr)return}}
create=async()=>{const input=document.querySelector('#account-name');try{const data=await api('/api/app/accounts',{method:'POST',body:JSON.stringify({label:input?.value||''})});s.adding=false;s.account=data.account;s.accounts=[...s.accounts.filter(account=>account.id!==data.account.id),data.account];s.view='pairing';s.qr='';render();pollForQr()}catch(error){notice(error.message)}};
function leavePairing(){s.adding=false;s.qr='';const account=s.accounts.find(item=>item.status==='WORKING')||s.accounts[0]||null;s.account=account;s.chat=null;s.view=account?.status==='WORKING'?'inbox':'pairing';if(s.view==='inbox')loadChats();render()}
let closeSettingsOverlay=null;
settings=async account=>{let keys=[];try{keys=(await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys`)).keys||[]}catch(error){notice(error.message)}const overlay=document.createElement('div');overlay.className='settings-overlay';overlay.innerHTML=`<section class="pair-card settings-card"><button class="modal-close" id="settings-close" aria-label="Close">×</button><span class="eyebrow">ACCOUNT SETTINGS</span><h1>${esc(account.label)}</h1><p>${esc(account.phone||'WhatsApp profile')} · ${esc(status(account.status))}</p><label>Personal account name<input id="label" value="${esc(account.label)}"></label><button id="save-label" class="primary">Save name</button><hr><h3>Connection</h3><p>Generate a fresh QR code to relink this WhatsApp account.</p><button id="relink" class="secondary">↻ Generate new QR code</button><hr><h3>Integrations</h3><label>Integration name<input id="key-name" placeholder="Claude agent"></label><button id="create-key" class="primary">Create integration key</button><div id="new-key"></div><div class="key-list">${keys.map(key=>`<p><b>${esc(key.name)}</b><br><small>${esc((key.scopes||[]).join(', '))} · ${key.lastUsedAt?'Last used '+esc(key.lastUsedAt):'Never used'}</small> <button class="secondary revoke" data-key="${esc(key.id)}">Revoke</button></p>`).join('')||'<small>No integration keys yet.</small>'}</div><hr><button id="delete-account" class="danger">Delete account</button></section>`;document.body.append(overlay);const close=()=>{overlay.remove();if(closeSettingsOverlay===close)closeSettingsOverlay=null};closeSettingsOverlay=close;overlay.querySelector('#settings-close').onclick=close;overlay.onclick=event=>{if(event.target===overlay)close()};overlay.querySelector('#save-label').onclick=async()=>{try{await api(`/api/app/accounts/${encodeURIComponent(account.id)}/label`,{method:'PATCH',body:JSON.stringify({label:overlay.querySelector('#label').value})});close();await refresh()}catch(error){notice(error.message)}};overlay.querySelector('#relink').onclick=async()=>{close();s.adding=false;s.account=account;s.view='pairing';s.qr='';render();await restart(account.id);pollForQr()};overlay.querySelector('#create-key').onclick=async()=>{try{const data=await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys`,{method:'POST',body:JSON.stringify({name:overlay.querySelector('#key-name').value,scopes:['messages:read','messages:send']})});overlay.querySelector('#new-key').innerHTML=`<div class="new-key"><code>${esc(data.token)}</code><button id="copy-key" class="icon-button" aria-label="Copy API key" title="Copy API key">⧉</button></div><small>Copy this key now — it will not be shown again.</small>`;overlay.querySelector('#copy-key').onclick=async()=>{try{await navigator.clipboard.writeText(data.token);notice('API key copied')}catch{notice('Copy failed; select the key manually')}}}catch(error){notice(error.message)}};overlay.querySelectorAll('.revoke').forEach(button=>button.onclick=async()=>{await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys/${button.dataset.key}`,{method:'DELETE'});close();settings(account)});overlay.querySelector('#delete-account').onclick=async()=>{if(!confirm(`Delete ${account.label}? This removes the account from Gakai.`))return;try{await api(`/api/app/accounts/${encodeURIComponent(account.id)}`,{method:'DELETE'});close();s.accounts=s.accounts.filter(item=>item.id!==account.id);s.account=s.accounts[0]||null;s.chat=null;s.view='inbox';render();await refresh()}catch(error){notice(error.message)}}};
const renderWithWorkspaceControls=render;
render=()=>{renderWithWorkspaceControls();const app=document.querySelector('.app');app?.classList.toggle('sidebar-collapsed',sidebarCollapsed);document.querySelector('#sidebar-toggle')?.addEventListener('click',()=>{sidebarCollapsed=!sidebarCollapsed;sessionStorage.setItem('gakai.sidebar',sidebarCollapsed?'collapsed':'expanded');render()});document.querySelector('#cancel-pair')?.addEventListener('click',leavePairing);document.querySelector('#cancel-pair-bottom')?.addEventListener('click',leavePairing)};
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(closeSettingsOverlay){closeSettingsOverlay();return}if(s.view==='pairing'&&s.accounts.length)leavePairing()});

function highlightOwnMentions(){
  const names=[...(s.account?.mentionNames||[]),s.account?.label,s.account?.profile,s.account?.phone].filter(Boolean).map(value=>String(value).replace(/[@+]/g," ").trim()).filter(Boolean).sort((a,b)=>b.length-a.length);
  if(!names.length)return;
  const pattern=new RegExp(`@(${names.map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})(?=\\s|$|[,.!?])`,"gi");
  document.querySelectorAll('.message:not(.mine)').forEach(bubble=>{
    const walker=document.createTreeWalker(bubble,NodeFilter.SHOW_TEXT,{acceptNode(node){return node.parentElement?.closest('.message-sender,time,.link-preview')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}});
    const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    nodes.forEach(node=>{if(!pattern.test(node.data))return;pattern.lastIndex=0;const fragment=document.createDocumentFragment();let last=0;node.data.replace(pattern,(match,_name,offset)=>{fragment.append(document.createTextNode(node.data.slice(last,offset)));const tag=document.createElement('span');tag.className='own-mention';tag.textContent=match;fragment.append(tag);last=offset+match.length;return match});fragment.append(document.createTextNode(node.data.slice(last)));node.replaceWith(fragment)});
  });
}
const renderWithOwnMentions=render;
render=()=>{renderWithOwnMentions();requestAnimationFrame(highlightOwnMentions)};

// In the compact rail, an account avatar is an expand affordance first.
document.addEventListener('click',event=>{
  const account=event.target.closest('.sidebar.collapsed [data-account]');
  if(!account)return;
  event.preventDefault();event.stopImmediatePropagation();
  sidebarCollapsed=false;sessionStorage.setItem('gakai.sidebar','expanded');render();
},true);

// Presence is scoped to the open chat. The provider maintains the subscription; this
// lightweight poll avoids exposing a public webhook endpoint for the dashboard.
let activePresence=null;
let presencePoll=null;
let typingIdleTimer=null;
let typingChatId=null;
const presenceStates=new Set(['online','offline','typing','recording','paused']);
const presenceLabel=payload=>{
  const entries=Array.isArray(payload?.presences)?payload.presences:[];
  const states=entries.map(item=>item?.lastKnownPresence).filter(state=>presenceStates.has(state));
  if(states.includes('typing'))return 'Typing…';
  if(states.includes('recording'))return 'Recording audio…';
  if(states.includes('online'))return 'Online';
  return '';
};
async function loadPresence(chatId=s.chat?.id){
  if(!chatId||chatId!==s.chat?.id||!current())return;
  try{
    const data=await api(`/api/app/accounts/${encodeURIComponent(current())}/presence?chatId=${encodeURIComponent(chatId)}`);
    if(chatId!==s.chat?.id)return;
    const next=presenceLabel(data);
    if(next!==activePresence){activePresence=next;render()}
  }catch(error){console.debug('Presence unavailable',error)}
}
function startPresencePolling(chatId=s.chat?.id){
  clearInterval(presencePoll);presencePoll=null;
  if(!chatId)return;
  loadPresence(chatId);
  presencePoll=setInterval(()=>{if(!document.hidden)loadPresence(chatId)},5000);
}
async function setOwnPresence(presence,chatId=s.chat?.id){
  if(!chatId||!current())return;
  try{await api(`/api/app/accounts/${encodeURIComponent(current())}/presence?chatId=${encodeURIComponent(chatId)}`,{method:'POST',body:JSON.stringify({presence})})}catch(error){console.debug('Could not update typing state',error)}
}
function clearOwnTyping(){
  clearTimeout(typingIdleTimer);typingIdleTimer=null;
  if(typingChatId){setOwnPresence('paused',typingChatId);typingChatId=null}
}
function handleComposerInput(){
  const chatId=s.chat?.id;if(!chatId)return;
  if(typingChatId!==chatId){clearOwnTyping();typingChatId=chatId;setOwnPresence('typing',chatId)}
  clearTimeout(typingIdleTimer);
  typingIdleTimer=setTimeout(clearOwnTyping,2500);
}
const renderWithPresence=render;
render=()=>{
  renderWithPresence();
  const header=root.querySelector('.conversation-head');
  if(header&&s.chat){
    const title=header.querySelector('b');
    if(title&&!title.parentElement.classList.contains('chat-title')){
      const box=document.createElement('div');box.className='chat-title';
      title.replaceWith(box);box.append(title);
      const indicator=document.createElement('span');indicator.className=`presence-status${activePresence?' is-live':''}`;indicator.textContent=activePresence||'';box.append(indicator);
    }
  }
  const composer=root.querySelector('#text');
  composer?.addEventListener('input',handleComposerInput);
  composer?.addEventListener('blur',clearOwnTyping);
};
const openChatWithPresence=openChat;
openChat=async id=>{
  if(s.chat?.id&&s.chat.id!==id)clearOwnTyping();
  activePresence=null;
  await openChatWithPresence(id);
  if(s.chat?.id===id)startPresencePolling(id);
};
const sendWithPresence=send;
send=async event=>{clearOwnTyping();return sendWithPresence(event)};
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearOwnTyping();else if(s.chat)loadPresence()});

// Older history must only load after an intentional reader gesture. DOM rebuilds
// also emit scroll events, which previously created an unbounded request loop.
let historyUserGestureUntil=0;
document.addEventListener('wheel',event=>{if(event.target.closest?.('.messages'))historyUserGestureUntil=Date.now()+1500},{passive:true,capture:true});
document.addEventListener('touchstart',event=>{if(event.target.closest?.('.messages'))historyUserGestureUntil=Date.now()+1500},{passive:true,capture:true});
document.addEventListener('pointerdown',event=>{if(event.target.closest?.('.messages'))historyUserGestureUntil=Date.now()+1500},{passive:true,capture:true});
onMessageScroll=async event=>{
  const pane=event.currentTarget;
  if(Date.now()>historyUserGestureUntil||pane.scrollTop>80||historyState.loading||historyState.exhausted||!s.chat)return;
  const chatId=s.chat.id;historyState.loading=true;const heightBefore=pane.scrollHeight,topBefore=pane.scrollTop;
  try{const data=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(chatId)}&limit=30&offset=${historyState.offset}`);if(s.chat?.id!==chatId)return;const older=Array.isArray(data)?data:data.messages||[];historyState.offset+=older.length;historyState.exhausted=older.length<30;if(!older.length)return;s.messages=[...new Map([...older,...s.messages].map(message=>[message.id,message])).values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));preserveMessagePosition=false;render();requestAnimationFrame(()=>{const next=document.querySelector('.messages');if(next)next.scrollTop=topBefore+(next.scrollHeight-heightBefore)})}catch(error){console.warn('Older history could not be loaded',error)}finally{historyState.loading=false;requestAnimationFrame(()=>{preserveMessagePosition=true})}
};

// The compact rail uses the Gakai mark itself as the expand control—no chevron.
sidebar=()=>`<aside class="sidebar ${sidebarCollapsed?'collapsed':''}"><div class="logo" title="${sidebarCollapsed?'Expand sidebar':'Gakai'}"><b>G</b><span>Gakai</span></div><div class="account-switch">${s.accounts.map(account=>`<button data-account="${esc(account.id)}" title="${esc(account.label)}" class="account ${account.id===current()?'selected':''}"><i class="${account.status==='WORKING'?'good':''}"></i>${avatar(account)}<span><b>${esc(account.label)}</b><small>${status(account.status)}</small></span></button>`).join('')}</div></aside>`;
document.addEventListener('click',event=>{if(!event.target.closest('.sidebar.collapsed .logo'))return;event.preventDefault();sidebarCollapsed=false;sessionStorage.setItem('gakai.sidebar','expanded');render()},true);

// Show a collapse control only while expanded; the compact mark remains clean.
sidebar=()=>`<aside class="sidebar ${sidebarCollapsed?'collapsed':''}"><div class="logo" title="${sidebarCollapsed?'Expand sidebar':'Gakai'}"><b>G</b><span>Gakai</span>${sidebarCollapsed?'':'<button id="sidebar-toggle" class="icon-button" aria-label="Collapse sidebar" title="Collapse sidebar">‹</button>'}</div><div class="account-switch">${s.accounts.map(account=>`<button data-account="${esc(account.id)}" title="${esc(account.label)}" class="account ${account.id===current()?'selected':''}"><i class="${account.status==='WORKING'?'good':''}"></i>${avatar(account)}<span><b>${esc(account.label)}</b><small>${status(account.status)}</small></span></button>`).join('')}</div></aside>`;

// Sender data is now fully enriched by the server; avoid duplicate client-side
// LID/contact requests when a group opens.
resolveVisibleGroupIdentities=async()=>{};

// Never paginate from a scroll event: browser layout/restoration can fire those
// without user intent. A real upward wheel gesture at the top loads one page.
onMessageScroll=()=>{};
let manualHistoryLoading=false;
async function loadOlderFromWheel(pane){
  if(manualHistoryLoading||historyState.exhausted||!s.chat||pane.scrollTop>80)return;
  const chatId=s.chat.id;manualHistoryLoading=true;const heightBefore=pane.scrollHeight,topBefore=pane.scrollTop;
  try{const data=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(chatId)}&limit=30&offset=${historyState.offset}`);if(s.chat?.id!==chatId)return;const older=Array.isArray(data)?data:data.messages||[];historyState.offset+=older.length;historyState.exhausted=older.length<30;if(!older.length)return;s.messages=[...new Map([...older,...s.messages].map(message=>[message.id,message])).values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));preserveMessagePosition=false;render();requestAnimationFrame(()=>{const next=document.querySelector('.messages');if(next)next.scrollTop=topBefore+(next.scrollHeight-heightBefore)})}catch(error){console.warn('Older history could not be loaded',error)}finally{manualHistoryLoading=false;requestAnimationFrame(()=>{preserveMessagePosition=true})}
}
document.addEventListener('wheel',event=>{const pane=event.target.closest?.('.messages');if(pane&&event.deltaY<0)loadOlderFromWheel(pane)},{passive:true,capture:true});

// Hydrate the currently visible attachments concurrently, then redraw once.
loadVisiblePreviews=async chatId=>{
  const targets=s.messages.filter(message=>message.hasMedia&&!message.media?.url&&!message.mediaUrl).slice(0,8);let next=0;
  await Promise.all(Array.from({length:Math.min(4,targets.length)},async()=>{while(next<targets.length){const message=targets[next++];try{const data=await api(`/api/app/accounts/${encodeURIComponent(current())}/message-media?chatId=${encodeURIComponent(chatId)}&messageId=${encodeURIComponent(message.id)}`);if(s.chat?.id===chatId)Object.assign(message,data.message||{})}catch(error){console.warn('Attachment preview unavailable',error)}}}));
  if(s.chat?.id===chatId&&targets.length)render();
};

// Pairing has its own account-specific polling so the normal inbox refresh can
// never replace a just-created STARTING session with an existing account.
let pairingAccountId=null;
pollForQr=async()=>{
  const accountId=pairingAccountId;
  while(s.view==='pairing'&&pairingAccountId===accountId){
    await new Promise(resolve=>setTimeout(resolve,1000));
    try{
      const data=await api('/api/app/accounts');
      const account=(data.accounts||[]).find(item=>item.id===accountId);
      if(!account)continue;
      s.accounts=data.accounts;s.account=account;
      if(account.status==='WORKING'){
        s.adding=false;pairingAccountId=null;s.qr='';s.view='inbox';
        sessionStorage.setItem('gakai.account',account.id);
        render();
        loadChats().then(()=>{if(s.view==='inbox'&&s.account?.id===account.id)render()});return;
      }
      if(account.status==='SCAN_QR_CODE')await loadQr();
      render();
    }catch(error){console.warn('Pairing status check failed',error)}
  }
};
create=async()=>{const input=document.querySelector('#account-name');try{const data=await api('/api/app/accounts',{method:'POST',body:JSON.stringify({label:input?.value||''})});pairingAccountId=data.account.id;s.adding=true;s.account=data.account;s.accounts=[...s.accounts.filter(account=>account.id!==data.account.id),data.account];s.view='pairing';s.qr='';render();await api(`/api/app/accounts/${encodeURIComponent(pairingAccountId)}/start`,{method:'POST'}).catch(()=>{});pollForQr()}catch(error){notice(error.message)}};

// Return to the workspace immediately after deletion is confirmed; the API work
// continues in the background and a refresh reconciles the account list.
const settingsWithImmediateDelete=settings;
settings=async account=>{
  await settingsWithImmediateDelete(account);
  const button=document.querySelector('#delete-account');
  if(!button)return;
  button.onclick=async()=>{
    if(!confirm(`Delete ${account.label}? This removes the account from Gakai.`))return;
    closeSettingsOverlay?.();
    sessionStorage.setItem('gakai.pending-delete',account.id);
    s.accounts=s.accounts.filter(item=>item.id!==account.id);
    s.account=s.accounts.find(item=>item.status==='WORKING')||s.accounts[0]||null;
    s.chat=null;s.view='inbox';render();
    try{await api(`/api/app/accounts/${encodeURIComponent(account.id)}`,{method:'DELETE'});await refresh()}
    catch(error){notice(error.message);await refresh()}
  };
};

// Preview thumbnail values may be raw base64 (rather than a URL). Normalize
// them for the browser and remove the URL duplicated by the preview card.
const addLinkCardsWithPreviewCleanup=addLinkCards;
addLinkCards=()=>{
  addLinkCardsWithPreviewCleanup();
  requestAnimationFrame(()=>document.querySelectorAll('.message').forEach((bubble,index)=>{
    const preview=s.messages[index]?.linkPreview;if(!preview)return;
    const image=bubble.querySelector('.link-preview img');
    if(image&&preview.image&&!/^https?:|^data:image\//i.test(preview.image)&&preview.image.length>100)image.src=`data:image/jpeg;base64,${preview.image.replace(/\s/g,'')}`;
    let previewUrl;try{previewUrl=new URL(preview.url)}catch{return}
    const walker=document.createTreeWalker(bubble,NodeFilter.SHOW_TEXT,{acceptNode(node){return node.parentElement?.closest('time,.link-preview')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT}});
    const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    nodes.forEach(node=>{node.nodeValue=node.nodeValue.replace(/https?:\/\/[^\s]+/gi,value=>{try{return new URL(value).hostname===previewUrl.hostname?'':value}catch{return value}})});
  }));
};

// A deleted final account must never leave stale workspace state behind.
const refreshWithEmptyAccountRecovery=refresh;
refresh=async()=>{
  await refreshWithEmptyAccountRecovery();
  if(s.accounts.length)return;
  pairingAccountId=null;s.adding=false;s.account=null;s.chat=null;s.messages=[];s.qr='';s.view='pairing';
  sessionStorage.removeItem('gakai.account');
  Object.keys(sessionStorage).filter(key=>key.startsWith('gakai.chat.')).forEach(key=>sessionStorage.removeItem(key));
  render();
};
window.addEventListener('unhandledrejection',event=>{
  console.error('Gakai startup error',event.reason);
  if(root.childElementCount)return;
  s.accounts=[];s.account=null;s.view='pairing';render();
});

// New accounts get their label from the linked WhatsApp profile automatically.
pairing=()=>{
  const account=s.account;
  return `<main class="pairing"><section class="pair-card"><button id="cancel-pair" class="modal-close" aria-label="Close">×</button><span class="eyebrow">GAKAI</span><h1>${account?'Reconnect this account':'Connect your WhatsApp'}</h1><p>${account?'Scan this new QR code to relink WhatsApp.':'Scan the QR code to link WhatsApp. Your profile name and phone number will be added automatically.'}</p>${account?.status==='SCAN_QR_CODE'&&s.qr?`<img class="qr" src="${s.qr}" alt="WhatsApp pairing QR code">`:account?'<div class="qr loading">Preparing a fresh QR code…</div>':'<div class="qr loading">Ready to create a secure WhatsApp link.</div>'}<ol><li>Open WhatsApp on your phone</li><li>Choose <b>Linked devices</b></li><li>Tap <b>Link a device</b> and scan</li></ol><div class="pair-status"><i></i>${account?.status==='SCAN_QR_CODE'?'Waiting for scan…':account?'Starting secure connection…':'No account name required.'}</div>${!account?'<button class="primary wide" id="create">Continue to QR code</button>':''}<button class="secondary wide" id="cancel-pair-bottom">Cancel</button></section></main>`;
};
create=async()=>{
  try{
    const data=await api('/api/app/accounts',{method:'POST',body:JSON.stringify({})});
    pairingAccountId=data.account.id;s.adding=true;s.account=data.account;
    s.accounts=[...s.accounts.filter(account=>account.id!==data.account.id),data.account];
    s.view='pairing';s.qr='';render();
    await api(`/api/app/accounts/${encodeURIComponent(pairingAccountId)}/start`,{method:'POST'}).catch(()=>{});
    pollForQr();
  }catch(error){notice(error.message)}
};

// Show chat-list progress while a newly linked account is syncing its inbox.
s.chatsLoading=false;
const loadChatsWithLoadingIndicator=loadChats;
loadChats=async()=>{
  s.chatsLoading=true;render();
  try{await loadChatsWithLoadingIndicator()}
  finally{s.chatsLoading=false;render()}
};
const renderWithChatLoadingIndicator=render;
render=()=>{
  renderWithChatLoadingIndicator();
  const column=root.querySelector('.chats');
  if(!column||!s.chatsLoading)return;
  const loading=document.createElement('div');
  loading.className='chat-syncing';
  loading.innerHTML='<span class="chat-spinner" aria-hidden="true"></span><span>WhatsApp is syncing conversations…</span>';
  column.append(loading);
};

// First-run registration asks for an administrator username and password.
authScreen=(setup,showUsername=true)=>{
  root.innerHTML=`<main class="pairing"><section class="pair-card"><span class="eyebrow">GAKAI</span><h1>${setup?'Create your workspace':'Welcome back'}</h1><p>${setup?'Create an administrator account, then link WhatsApp with a QR code.':'Sign in to manage your WhatsApp workspace.'}</p><form id="auth"><label class="username-field" ${showUsername?'':'hidden'}>Username<input id="username" minlength="3" maxlength="40" ${showUsername?'required':''} autocomplete="username"></label><label>Password<input id="password" type="password" minlength="10" required autocomplete="${setup?'new-password':'current-password'}"></label><button class="primary wide">${setup?'Create workspace':'Sign in'}</button></form></section></main>`;
  document.querySelector('#auth').onsubmit=async event=>{event.preventDefault();try{await api(`/api/app/auth/${setup?'setup':'login'}`,{method:'POST',body:JSON.stringify({username:document.querySelector('#username')?.value||'',password:document.querySelector('#password').value})});if(setup)sessionStorage.setItem('gakai.first-pairing','1');location.reload()}catch(error){notice(error.message)}};
};

// Keep a session being deleted out of the UI even if the browser refreshes
// before Gakai provider runtime finishes its asynchronous teardown.
const refreshWithDeletionGuard=refresh;
refresh=async()=>{
  await refreshWithDeletionGuard();
  const deleting=sessionStorage.getItem('gakai.pending-delete');
  if(!deleting)return;
  if(!s.accounts.some(account=>account.id===deleting)){
    sessionStorage.removeItem('gakai.pending-delete');
    return;
  }
  s.accounts=s.accounts.filter(account=>account.id!==deleting);
  s.account=s.accounts.find(account=>account.status==='WORKING')||s.accounts[0]||null;
  s.chat=null;s.messages=[];s.view=s.account?'inbox':'pairing';render();
};

// Serialize account refreshes so an older response cannot restore a deleted
// account after a newer deletion state has already rendered.
const refreshWithoutRace=refresh;
let accountRefreshQueue=Promise.resolve();
refresh=()=>{
  const task=accountRefreshQueue.then(()=>refreshWithoutRace());
  accountRefreshQueue=task.catch(error=>console.warn('Account refresh failed',error));
  return task;
};

// Gakai provider's first post-link overview can take time. Never issue it twice in
// parallel; a single shared request prevents duplicate 60–90 second syncs.
const loadChatsWithoutDuplicates=loadChats;
let chatListRequest=null;
loadChats=()=>{
  if(chatListRequest)return chatListRequest;
  chatListRequest=loadChatsWithoutDuplicates().finally(()=>{chatListRequest=null});
  return chatListRequest;
};

// Never leave a broken-image glyph in a preview card when the remote publisher
// declines its thumbnail request; the title and description remain available.
const addLinkCardsWithoutBrokenImages=addLinkCards;
addLinkCards=()=>{
  addLinkCardsWithoutBrokenImages();
  requestAnimationFrame(()=>document.querySelectorAll('.link-preview img').forEach(image=>{image.onerror=()=>image.remove()}));
};

// Unread counts are visible on the conversation list and clear immediately
// when the user opens that chat, then reconcile with the provider on refresh.
const renderWithUnreadPills=render;
render=()=>{
  renderWithUnreadPills();
  root.querySelectorAll('[data-chat]').forEach(button=>{
    const chat=s.chats.find(item=>item.id===button.dataset.chat);
    const unread=Number(chat?.unreadCount)||0;
    if(!unread)return;
    const pill=document.createElement('span');pill.className='unread-pill';pill.textContent=unread>99?'99+':String(unread);
    pill.setAttribute('aria-label',`${unread} unread messages`);button.append(pill);
  });
};
const openChatWithUnreadReset=openChat;
openChat=async id=>{
  const chat=s.chats.find(item=>item.id===id);
  if(chat?.unreadCount){chat.unreadCount=0;render()}
  await openChatWithUnreadReset(id);
  loadChats().catch(error=>console.warn('Unread count refresh failed',error));
};

// Inbox order is always newest conversation first, regardless of the timestamp
// representation returned by the underlying WhatsApp engine.
const loadChatsWithNewestFirst=loadChats;
const chatOrderTimestamp=value=>{
  const numeric=Number(value);
  if(Number.isFinite(numeric)&&numeric>0)return numeric>1e12?Math.floor(numeric/1000):numeric;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?Math.floor(parsed/1000):0;
};
loadChats=async()=>{
  await loadChatsWithNewestFirst();
  s.chats.sort((left,right)=>chatOrderTimestamp(right.timestamp||right.lastMessage?.timestamp)-chatOrderTimestamp(left.timestamp||left.lastMessage?.timestamp));
  render();
};

// Permanent chat deletion: Gakai provider runtime removes the chat and its stored history.
const renderWithChatDelete=render;
render=()=>{
  renderWithChatDelete();
  const header=root.querySelector('.conversation-head');
  if(!header||!s.chat)return;
  const button=document.createElement('button');
  button.className='delete-chat';button.type='button';button.textContent='Delete conversation';
  button.title='Delete conversation';button.setAttribute('aria-label','Delete conversation permanently');
  button.onclick=async()=>{
    const chat=s.chat;
    if(!chat||!confirm(`Permanently delete this conversation and its message history? This cannot be undone.`))return;
    button.disabled=true;
    try{
      await api(`/api/app/accounts/${encodeURIComponent(current())}/chats/${encodeURIComponent(chat.id)}`,{method:'DELETE'});
      s.chats=s.chats.filter(item=>item.id!==chat.id);s.chat=null;s.messages=[];render();
      notice('Conversation deleted');
    }catch(error){button.disabled=false;notice(error.message||'Could not delete conversation')}
  };
  header.append(button);
};

// Connecting an additional account starts QR pairing immediately; the old
// placeholder screen is never shown for an explicit Connect account action.
document.addEventListener('click',event=>{
  const button=event.target.closest?.('#add');
  if(!button)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(s.adding)return;
  s.adding=true;s.account=null;s.chat=null;s.messages=[];s.qr='';s.view='pairing';
  create();
},true);

// Cancelling a newly created pairing session removes that provisional provider
// account. Relinking an existing account remains a non-destructive cancel.
async function cancelNewPairing(){
  const accountId=pairingAccountId;
  if(!s.adding||!accountId){leavePairing();return}
  pairingAccountId=null;s.adding=false;s.qr='';
  s.accounts=s.accounts.filter(account=>account.id!==accountId);
  s.account=s.accounts.find(account=>account.status==='WORKING')||s.accounts[0]||null;
  s.chat=null;s.messages=[];s.view=s.account?'inbox':'pairing';render();
  try{await api(`/api/app/accounts/${encodeURIComponent(accountId)}`,{method:'DELETE'})}
  catch(error){console.warn('Provisional account cleanup failed',error);notice('Could not remove the cancelled account')}
  await refresh();
}
document.addEventListener('click',event=>{
  if(!event.target.closest?.('#cancel-pair,#cancel-pair-bottom'))return;
  if(!s.adding||!pairingAccountId)return;
  event.preventDefault();event.stopImmediatePropagation();cancelNewPairing();
},true);
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||!s.adding||!pairingAccountId)return;
  event.preventDefault();event.stopImmediatePropagation();cancelNewPairing();
},true);

// Public Instagram links do not always carry a thumbnail in WhatsApp. Fetch a
// cached Open Graph fallback when available, without requiring Meta credentials.
const instagramPreviewRequests=new Set();
const addLinkCardsWithInstagramFallback=addLinkCards;
addLinkCards=()=>{
  addLinkCardsWithInstagramFallback();
  requestAnimationFrame(()=>document.querySelectorAll('.message').forEach((bubble,index)=>{
    const preview=s.messages[index]?.linkPreview;
    if(!preview||preview.image||instagramPreviewRequests.has(preview.url))return;
    let page;try{page=new URL(preview.url)}catch{return}
    if(!/(^|\.)instagram\.com$/i.test(page.hostname))return;
    instagramPreviewRequests.add(preview.url);
    api(`/api/app/instagram-preview?url=${encodeURIComponent(preview.url)}`).then(data=>{
      if(data.image)preview.image=`/api/app/instagram-image?url=${encodeURIComponent(data.image)}`;
      if(!preview.title&&data.title)preview.title=data.title;
      if(!preview.description&&data.description)preview.description=data.description;
      render();
    }).catch(()=>{}).finally(()=>instagramPreviewRequests.delete(preview.url));
  }));
};

// Generic Open Graph fallback for public links without WhatsApp thumbnail data.
const genericPreviewRequests=new Set();
const addLinkCardsWithOpenGraphFallback=addLinkCards;
addLinkCards=()=>{
  addLinkCardsWithOpenGraphFallback();
  requestAnimationFrame(()=>document.querySelectorAll('.message').forEach((bubble,index)=>{
    const preview=s.messages[index]?.linkPreview;
    if(!preview||preview.image||genericPreviewRequests.has(preview.url))return;
    let link;try{link=new URL(preview.url)}catch{return}
    if(!/^https?:$/.test(link.protocol))return;
    genericPreviewRequests.add(preview.url);
    api(`/api/app/link-preview?url=${encodeURIComponent(preview.url)}`).then(data=>{
      if(data.image)preview.image=`/api/app/link-image?url=${encodeURIComponent(data.image)}`;
      if(!preview.title&&data.title)preview.title=data.title;
      if(!preview.description&&data.description)preview.description=data.description;
      render();
    }).catch(()=>{}).finally(()=>genericPreviewRequests.delete(preview.url));
  }));
};

// Replace browser-native controls with a compact, chat-native audio player.
// The underlying <audio> element is retained for the browser's dependable
// streaming, buffering, accessibility, and media-session support.
const formatAudioTime=value=>{
  const seconds=Math.max(0,Math.floor(Number(value)||0));
  return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
};
function enhanceAudioPlayers(){
  root.querySelectorAll('audio.media-audio:not([data-audio-player])').forEach(audio=>{
    audio.dataset.audioPlayer='true';audio.removeAttribute('controls');
    const player=document.createElement('div');player.className='audio-player';
    player.innerHTML='<button type="button" class="audio-play" aria-label="Play audio">▶</button><div class="audio-main"><input class="audio-progress" aria-label="Audio progress" type="range" min="0" max="0" value="0" step="0.1"><div class="audio-meta"><span class="audio-time">0:00</span><span class="audio-duration">0:00</span></div></div><button type="button" class="audio-speed" aria-label="Playback speed">1×</button><a class="audio-download" aria-label="Download audio" title="Download audio" download>⇩</a>';
    audio.replaceWith(player);player.prepend(audio);
    const play=player.querySelector('.audio-play'),progress=player.querySelector('.audio-progress'),elapsed=player.querySelector('.audio-time'),duration=player.querySelector('.audio-duration'),speed=player.querySelector('.audio-speed'),download=player.querySelector('.audio-download');
    download.href=audio.currentSrc||audio.src;
    const sync=()=>{progress.value=String(Math.min(audio.currentTime||0,Number(progress.max)||0));elapsed.textContent=formatAudioTime(audio.currentTime)};
    const metadata=()=>{const length=Number.isFinite(audio.duration)?audio.duration:0;progress.max=String(length);duration.textContent=formatAudioTime(length);sync()};
    play.onclick=()=>audio.paused?audio.play().catch(()=>{}):audio.pause();
    progress.oninput=()=>{audio.currentTime=Number(progress.value);sync()};
    speed.onclick=()=>{const speeds=[1,1.5,2];const next=speeds[(speeds.indexOf(audio.playbackRate)+1)%speeds.length];audio.playbackRate=next;speed.textContent=`${next}×`};
    audio.addEventListener('loadedmetadata',metadata);audio.addEventListener('durationchange',metadata);audio.addEventListener('timeupdate',sync);
    audio.addEventListener('play',()=>{root.querySelectorAll('audio.media-audio').forEach(other=>{if(other!==audio)other.pause()});play.textContent='❚❚';play.setAttribute('aria-label','Pause audio');player.classList.add('playing')});
    audio.addEventListener('pause',()=>{play.textContent='▶';play.setAttribute('aria-label','Play audio');player.classList.remove('playing')});
    audio.addEventListener('ended',()=>{audio.currentTime=0;sync()});
    if(audio.readyState>=1)metadata();
  });
}
const renderWithAudioPlayers=render;
render=()=>{renderWithAudioPlayers();enhanceAudioPlayers()};

const formatVideoTime=value=>{
  const seconds=Math.max(0,Math.floor(Number(value)||0));
  return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
};
function enhanceVideoPlayers(){
  root.querySelectorAll('video.media:not([data-video-player])').forEach(video=>{
    video.dataset.videoPlayer='true';video.removeAttribute('controls');video.preload='metadata';
    const player=document.createElement('div');player.className='video-player';
    player.innerHTML='<div class="video-stage"><button type="button" class="video-play" aria-label="Play video">▶</button><span class="video-loading" aria-label="Loading video"></span></div><div class="video-controls"><button type="button" class="video-toggle" aria-label="Play video">▶</button><input class="video-progress" aria-label="Video progress" type="range" min="0" max="0" value="0" step="0.1"><span class="video-time">0:00 / 0:00</span><button type="button" class="video-mute" aria-label="Mute video">🔊</button><button type="button" class="video-fullscreen" aria-label="Fullscreen video">⛶</button><a class="video-download" aria-label="Download video" title="Download video" download>⇩</a></div>';
    video.replaceWith(player);player.querySelector('.video-stage').prepend(video);
    const stage=player.querySelector('.video-stage'),play=player.querySelector('.video-play'),toggle=player.querySelector('.video-toggle'),progress=player.querySelector('.video-progress'),time=player.querySelector('.video-time'),mute=player.querySelector('.video-mute'),fullscreen=player.querySelector('.video-fullscreen'),download=player.querySelector('.video-download'),loading=player.querySelector('.video-loading');
    download.href=video.currentSrc||video.src;
    const sync=()=>{progress.value=String(Math.min(video.currentTime||0,Number(progress.max)||0));time.textContent=`${formatVideoTime(video.currentTime)} / ${formatVideoTime(video.duration)}`};
    const metadata=()=>{progress.max=String(Number.isFinite(video.duration)?video.duration:0);sync();player.classList.add('ready')};
    const setPlaying=playing=>{play.textContent=playing?'❚❚':'▶';toggle.textContent=playing?'❚❚':'▶';const label=playing?'Pause video':'Play video';play.setAttribute('aria-label',label);toggle.setAttribute('aria-label',label);player.classList.toggle('playing',playing)};
    const togglePlayback=()=>video.paused?video.play().catch(()=>{}):video.pause();
    play.onclick=togglePlayback;toggle.onclick=togglePlayback;stage.onclick=event=>{if(event.target===stage||event.target===video)togglePlayback()};
    progress.oninput=()=>{video.currentTime=Number(progress.value);sync()};
    mute.onclick=()=>{video.muted=!video.muted;mute.textContent=video.muted?'🔇':'🔊';mute.setAttribute('aria-label',video.muted?'Unmute video':'Mute video')};
    fullscreen.onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await player.requestFullscreen()}catch{video.controls=true}};
    video.addEventListener('loadedmetadata',metadata);video.addEventListener('durationchange',metadata);video.addEventListener('timeupdate',sync);
    video.addEventListener('waiting',()=>loading.classList.add('show'));video.addEventListener('canplay',()=>loading.classList.remove('show'));
    video.addEventListener('play',()=>{root.querySelectorAll('video.media').forEach(other=>{if(other!==video)other.pause()});setPlaying(true)});video.addEventListener('pause',()=>setPlaying(false));video.addEventListener('ended',()=>{video.currentTime=0;sync()});
    if(video.readyState>=1)metadata();
  });
}
const renderWithVideoPlayers=render;
render=()=>{renderWithVideoPlayers();enhanceVideoPlayers()};

// Chat viewport controller -------------------------------------------------
// Earlier UI layers rebuild the message pane and each made its own best-effort
// scroll adjustment. That meant a "go to bottom" frame could race a history
// restoration frame. Keep the final decision here, after every legacy render
// hook has completed, and restore by a message anchor instead of scrollHeight.
let viewportRenderVersion=0;
let viewportIntent=null;
let historyUi={loading:false,error:false};
let lastHistoryGesture=0;
const messageKey=(message,index)=>String(message?.id||`message-${index}`);
function markMessageNodes(){root.querySelectorAll('.messages .message').forEach((node,index)=>node.dataset.messageKey=messageKey(s.messages[index],index))}
function viewportAnchor(pane){
  if(!pane)return null;
  const paneTop=pane.getBoundingClientRect().top;
  const message=[...pane.querySelectorAll('.message')].find(node=>node.getBoundingClientRect().bottom>paneTop+1);
  return message?{key:message.dataset.messageKey,offset:message.offsetTop-pane.scrollTop}:{top:pane.scrollTop};
}
function applyViewportIntent(intent,version){
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(version!==viewportRenderVersion)return;
    const pane=root.querySelector('.messages');if(!pane||!intent)return;
    if(intent.kind==='bottom'){pane.scrollTop=pane.scrollHeight;return}
    const anchor=intent.anchor;
    if(anchor?.key){const node=[...pane.querySelectorAll('.message')].find(item=>item.dataset.messageKey===anchor.key);if(node){pane.scrollTop=node.offsetTop-anchor.offset;return}}
    if(Number.isFinite(anchor?.top))pane.scrollTop=anchor.top;
  }));
}
function addHistoryLoadingIndicator(){
  const pane=root.querySelector('.messages');if(!pane||!historyUi.loading)return;
  const indicator=document.createElement('div');indicator.className='history-loading';indicator.setAttribute('role','status');indicator.innerHTML='<span class="chat-spinner" aria-hidden="true"></span><span>Loading earlier messages…</span>';
  pane.append(indicator);
}
const renderWithStableViewport=render;
render=()=>{
  const fallback=viewportIntent||{kind:'anchor',anchor:viewportAnchor(root.querySelector('.messages'))};
  viewportIntent=null;
  renderWithStableViewport();
  markMessageNodes();addHistoryLoadingIndicator();
  const version=++viewportRenderVersion;
  applyViewportIntent(fallback,version);
};

// Disable the previous wheel-only loader. It competes with scroll restoration
// and is replaced by a normal, gesture-gated scroll listener below.
onMessageScroll=()=>{};
loadOlderFromWheel=()=>{};
async function loadOlderSmooth(pane){
  if(historyUi.loading||historyState.exhausted||!s.chat||pane.scrollTop>64)return;
  const chatId=s.chat.id,anchor=viewportAnchor(pane);
  historyUi={loading:true,error:false};historyState.loading=true;viewportIntent={kind:'anchor',anchor};render();
  try{
    const data=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(chatId)}&limit=30&offset=${historyState.offset}`);
    if(s.chat?.id!==chatId)return;
    const older=Array.isArray(data)?data:data.messages||[];
    historyState.offset+=older.length;historyState.exhausted=older.length<30;
    if(older.length)s.messages=[...new Map([...older,...s.messages].map(message=>[message.id,message])).values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
    historyUi={loading:false,error:false};historyState.loading=false;viewportIntent={kind:'anchor',anchor};render();
  }catch(error){
    console.warn('Older history could not be loaded',error);
    historyUi={loading:false,error:true};historyState.loading=false;viewportIntent={kind:'anchor',anchor};render();notice('Could not load earlier messages');
  }
}
function rememberHistoryGesture(event){
  if(event.target.closest?.('.messages'))lastHistoryGesture=Date.now();
}
document.addEventListener('wheel',rememberHistoryGesture,{passive:true,capture:true});
document.addEventListener('touchstart',rememberHistoryGesture,{passive:true,capture:true});
document.addEventListener('pointerdown',rememberHistoryGesture,{passive:true,capture:true});
document.addEventListener('keydown',event=>{if(['ArrowUp','PageUp','Home'].includes(event.key))rememberHistoryGesture(event)},{capture:true});
function bindSmoothHistoryScroll(){
  const pane=root.querySelector('.messages');
  if(!pane||pane.dataset.smoothHistoryBound)return;
  pane.dataset.smoothHistoryBound='true';
  pane.addEventListener('scroll',()=>{if(Date.now()-lastHistoryGesture<1600&&pane.scrollTop<=64)loadOlderSmooth(pane)},{passive:true});
}
const renderWithSmoothHistoryBinding=render;
render=()=>{renderWithSmoothHistoryBinding();bindSmoothHistoryScroll()};

function settleAtLatest(chatId){
  const move=()=>{if(s.chat?.id!==chatId)return;viewportIntent={kind:'bottom'};render()};
  move();setTimeout(move,180);
}
const openChatWithLatestViewport=openChat;
openChat=async id=>{
  historyUi={loading:false,error:false};viewportIntent={kind:'bottom'};
  await openChatWithLatestViewport(id);
  if(s.chat?.id===id)settleAtLatest(id);
};

// Keep the reader's place while attachments in a newly prepended page finish
// loading. The lock ends on the next intentional scroll, so it never fights a
// reader who has resumed browsing the conversation.
let historyLayoutLock=null;
function restoreHistoryLayoutAnchor(){
  const lock=historyLayoutLock;
  if(!lock||Date.now()>lock.expires||s.chat?.id!==lock.chatId){historyLayoutLock=null;return}
  requestAnimationFrame(()=>{
    const pane=root.querySelector('.messages');if(!pane)return;
    const node=[...pane.querySelectorAll('.message')].find(item=>item.dataset.messageKey===lock.anchor?.key);
    if(node)pane.scrollTop=node.offsetTop-lock.anchor.offset;
  });
}
const addHistoryLoadingIndicatorWithLock=addHistoryLoadingIndicator;
addHistoryLoadingIndicator=()=>{
  addHistoryLoadingIndicatorWithLock();
  root.querySelector('.messages')?.classList.toggle('history-loading-active',historyUi.loading);
};
loadOlderSmooth=async pane=>{
  if(historyUi.loading||historyState.exhausted||!s.chat||pane.scrollTop>64)return;
  const chatId=s.chat.id,anchor=viewportAnchor(pane);
  historyLayoutLock={chatId,anchor,expires:Date.now()+10000};
  historyUi={loading:true,error:false};historyState.loading=true;
  // This is deliberately DOM-only: rebuilding the full message pane here was
  // the source of the visible jump while the request was still in flight.
  const loader=document.createElement('div');loader.className='history-loading';loader.setAttribute('role','status');loader.innerHTML='<span class="chat-spinner" aria-hidden="true"></span><span>Loading earlier messages…</span>';
  pane.classList.add('history-loading-active');pane.append(loader);
  try{
    const data=await api(`/api/app/accounts/${encodeURIComponent(current())}/messages?chatId=${encodeURIComponent(chatId)}&limit=30&offset=${historyState.offset}`);
    if(s.chat?.id!==chatId)return;
    const older=Array.isArray(data)?data:data.messages||[];
    historyState.offset+=older.length;historyState.exhausted=older.length<30;
    if(older.length)s.messages=[...new Map([...older,...s.messages].map(message=>[message.id,message])).values()].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
    historyUi={loading:false,error:false};historyState.loading=false;viewportIntent={kind:'anchor',anchor};render();restoreHistoryLayoutAnchor();
  }catch(error){
    console.warn('Older history could not be loaded',error);
    historyUi={loading:false,error:true};historyState.loading=false;pane.classList.remove('history-loading-active');loader.remove();restoreHistoryLayoutAnchor();notice('Could not load earlier messages');
  }
};
document.addEventListener('wheel',event=>{
  const pane=event.target.closest?.('.messages');
  if(!pane)return;
  if(historyUi.loading){event.preventDefault();return}
  historyLayoutLock=null;
},{capture:true,passive:false});
document.addEventListener('touchmove',event=>{
  const pane=event.target.closest?.('.messages');
  if(pane&&historyUi.loading)event.preventDefault();
},{capture:true,passive:false});
document.addEventListener('load',event=>{if(event.target.matches?.('.messages img,.messages video'))restoreHistoryLayoutAnchor()},{capture:true});
document.addEventListener('loadedmetadata',event=>{if(event.target.matches?.('.messages audio,.messages video'))restoreHistoryLayoutAnchor()},{capture:true});

// Contact shares arrive from the provider as RFC vCard data. Render a useful card and
// keep the raw interchange body out of the conversation UI.
function unescapeVcard(value=''){return String(value).replace(/\\n/gi,'\n').replace(/\\,/g,',').replace(/\\;/g,';').replace(/\\\\/g,'\\')}
function parseVcard(raw){
  const text=typeof raw==='string'?raw:(raw?.vcard||raw?.vCard||raw?.card||'');
  if(!/BEGIN:VCARD/i.test(text))return null;
  const fields={phones:[],emails:[]};
  text.replace(/\r?\n[ \t]/g,'').split(/\r?\n/).forEach(line=>{
    const separator=line.indexOf(':');if(separator<0)return;
    const key=line.slice(0,separator).split(';')[0].toUpperCase(),value=unescapeVcard(line.slice(separator+1));
    if(key==='FN')fields.name=value;
    else if(key==='N'&&!fields.name)fields.name=value.split(';').filter(Boolean).reverse().join(' ');
    else if(key==='TEL')fields.phones.push(value);
    else if(key==='EMAIL')fields.emails.push(value);
    else if(key==='ORG')fields.organization=value.replace(/;$/,'');
  });
  return fields.name?fields:null;
}
function contactCardsFor(message){
  const cards=[...(message.vCards||[]),message.body,message.text].map(parseVcard).filter(Boolean);
  return [...new Map(cards.map(card=>[`${card.name}:${card.phones.join('|')}:${card.emails.join('|')}`,card])).values()];
}
function enhanceContactCards(){
  root.querySelectorAll('.messages .message').forEach((bubble,index)=>{
    if(bubble.querySelector('.contact-card'))return;
    const cards=contactCardsFor(s.messages[index]||{});if(!cards.length)return;
    [...bubble.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE&&/BEGIN:VCARD/i.test(node.nodeValue)).forEach(node=>node.remove());
    const time=bubble.querySelector('time');
    cards.forEach(card=>{
      const cardNode=document.createElement('section');cardNode.className='contact-card';
      const phones=card.phones.slice(0,2).map(phone=>`<a href="tel:${esc(phone.replace(/[^+\d]/g,''))}">${esc(phone)}</a>`).join('');
      const emails=card.emails.slice(0,2).map(email=>`<a href="mailto:${esc(email)}">${esc(email)}</a>`).join('');
      cardNode.innerHTML=`<span class="contact-avatar">${esc(card.name[0]?.toUpperCase()||'?')}</span><span class="contact-details"><b>${esc(card.name)}</b>${card.organization?`<small>${esc(card.organization)}</small>`:''}${phones||emails?`<span class="contact-links">${phones}${emails}</span>`:''}</span>`;
      bubble.insertBefore(cardNode,time);
    });
  });
}
const renderWithContactCards=render;
render=()=>{renderWithContactCards();enhanceContactCards()};

// Make unread conversations unmistakable in the inbox list.
const renderWithUnreadState=render;
render=()=>{
  renderWithUnreadState();
  root.querySelectorAll("[data-chat]").forEach(button=>{
    const chat=s.chats.find(item=>item.id===button.dataset.chat);
    const unread=Number(chat?.unreadCount)||0;
    button.classList.toggle("has-unread",unread>0);
    const name=button.querySelector("span > b")?.textContent||"Conversation";
    button.setAttribute("aria-label",unread?`${name}, ${unread} unread messages`:`${name}, no unread messages`);
  });
};

// Refresh inbox metadata without rebuilding the active conversation when nothing changed.
const refreshWithInboxUnreadPolling=refresh;
const unreadChatFingerprint=chats=>JSON.stringify(chats.map(chat=>[chat.id,chat.timestamp,chat.lastMessage?.timestamp,chat.lastMessage?.body,chat.lastMessage?.text,chat.unreadCount]));
async function refreshInboxUnreadState(){
  if(!s.account||s.account.status!=="WORKING"||s.view!=="inbox"||s.adding)return;
  try{
    const response=await api(`/api/app/accounts/${encodeURIComponent(current())}/chats`);
    const chats=(Array.isArray(response)?response:response.chats||[]).sort((left,right)=>chatOrderTimestamp(right.timestamp||right.lastMessage?.timestamp)-chatOrderTimestamp(left.timestamp||left.lastMessage?.timestamp));
    if(unreadChatFingerprint(chats)===unreadChatFingerprint(s.chats))return;
    s.chats=chats;
    if(s.chat)s.chat=s.chats.find(chat=>chat.id===s.chat.id)||null;
    render();
  }catch(error){console.warn("Inbox refresh deferred",error)}
}
refresh=async()=>{
  await refreshWithInboxUnreadPolling();
  await refreshInboxUnreadState();
};

// Mark a conversation as read only after the user intentionally opens it.
const openChatWithGakaiReadReceipt=openChat;
openChat=async id=>{
  const chat=s.chats.find(item=>item.id===id);
  if(chat?.unreadCount){
    chat.unreadCount=0;render();
    try{await api("/api/app/accounts/"+encodeURIComponent(current())+"/chats/"+encodeURIComponent(id)+"/read",{method:"POST"})}
    catch(error){console.warn("Could not mark conversation as read",error)}
  }
  return openChatWithGakaiReadReceipt(id);
};

// Account cog opens this dedicated, reload-safe details page.
async function openAccountDetails(account){if(!account)return;s.detailsAccount=account;s.view="details";root.innerHTML=`<div class="profile-page"><header class="profile-header"><button id="details-back" class="secondary">‹ Inbox</button><div class="profile-heading">${avatar(account)}<span><span class="eyebrow">ACCOUNT DETAILS</span><h2>${esc(account.label)}</h2><small>${esc(account.phone||"WhatsApp account")}</small></span></div></header><main class="profile-grid"><section class="profile-card profile-overview"><h3>Account settings</h3><p>Update how this WhatsApp account appears in Gakai.</p><form id="details-label"><label>Account name<input id="details-label-value" maxlength="80" value="${esc(account.label)}"></label><button class="primary">Save account name</button></form></section><section class="profile-card"><h3>API access</h3><p>Create a dedicated API key for n8n or another trusted integration. The key is shown once.</p><button id="details-key" class="primary">Create API key</button><div id="details-key-output"></div></section><section class="profile-card profile-security"><span class="eyebrow">WORKSPACE SECURITY</span><h3>Sign-in details</h3><p>Change your username or password. Your current password is required to save.</p><form id="details-security"><label>Username<input id="details-username" minlength="3" maxlength="40" autocomplete="username"></label><label>Current password<input id="details-current" type="password" required autocomplete="current-password"></label><label>New password <small>Leave blank to keep it.</small><input id="details-new" type="password" minlength="10" autocomplete="new-password"></label><button class="primary">Save sign-in details</button></form></section></main></div>`;const profile=await api("/api/app/auth/profile").catch(()=>({username:""}));root.querySelector("#details-username").value=profile.username||"";root.querySelector("#details-back").onclick=()=>{history.pushState({},"","/");s.view="inbox";s.detailsAccount=null;render()};root.querySelector("#details-label").onsubmit=async event=>{event.preventDefault();try{await api(`/api/app/accounts/${encodeURIComponent(account.id)}/label`,{method:"PATCH",body:JSON.stringify({label:root.querySelector("#details-label-value").value})});notice("Account name saved");await refresh()}catch(error){notice(error.message)}};root.querySelector("#details-key").onclick=async()=>{try{const data=await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys`,{method:"POST",body:JSON.stringify({name:"Account API key",scopes:["messages:read","messages:send"]})});root.querySelector("#details-key-output").innerHTML=`<div class="profile-secret"><b>Copy this key now.</b><code>${esc(data.token)}</code></div>`}catch(error){notice(error.message)}};root.querySelector("#details-security").onsubmit=async event=>{event.preventDefault();try{const data=await api("/api/app/auth/profile",{method:"PATCH",body:JSON.stringify({username:root.querySelector("#details-username").value,currentPassword:root.querySelector("#details-current").value,newPassword:root.querySelector("#details-new").value})});root.querySelector("#details-current").value="";root.querySelector("#details-new").value="";notice(`Saved sign-in details for ${data.username}`)}catch(error){notice(error.message)}}}
settings=async account=>{history.pushState({},"",`/accounts/${encodeURIComponent(account.id)}/details`);await openAccountDetails(account)};
const refreshForDetails=refresh;refresh=async()=>{await refreshForDetails();const match=location.pathname.match(/^\/accounts\/([^/]+)\/details$/);if(match){const account=s.accounts.find(item=>item.id===decodeURIComponent(match[1]));if(account&&s.view!=="details")await openAccountDetails(account)}};
window.addEventListener("popstate",()=>{if(location.pathname==="/"){s.view="inbox";s.detailsAccount=null;render()}});

// A compact integration chooser keeps account automation setup discoverable.
const openAccountDetailsBase=openAccountDetails;
openAccountDetails=async account=>{if(!account)return;s.detailsAccount=account;s.view="details";root.innerHTML=`<div class="profile-page"><header class="profile-header"><button id="details-back" class="secondary">‹ Inbox</button><div class="profile-heading">${avatar(account)}<span><span class="eyebrow">ACCOUNT DETAILS</span><h2>${esc(account.label)}</h2><small>${esc(account.phone||"WhatsApp account")}</small></span></div></header><main class="profile-grid integration-layout"><section class="profile-card"><span class="eyebrow">DETAILS</span><h3>Account name</h3><p>Choose the name shown throughout your workspace.</p><form id="details-label"><label>Account name<input id="details-label-value" maxlength="80" value="${esc(account.label)}"></label><button class="primary">Save changes</button></form></section><section class="profile-card integration-intro"><span class="eyebrow">INTEGRATIONS</span><h3>Connect this account</h3><p>Give trusted services their own account-scoped API key. Use n8n for workflow automation, Claude for AI-assisted workflows, or Codex for agentic development.</p><small>Keys are unique to this WhatsApp account and are shown once.</small></section><section class="profile-card integration-picker"><span class="eyebrow">CHOOSE A SERVICE</span><h3>What would you like to connect?</h3><div class="service-choices"><button type="button" class="service-choice" data-service="n8n"><span class="service-mark n8n-mark">n8n</span><span><b>n8n</b><small>Workflow automation</small></span><i>✓</i></button><button type="button" class="service-choice" data-service="claude"><span class="service-mark claude-mark">AI</span><span><b>Claude</b><small>AI-assisted workflows</small></span><i>✓</i></button><button type="button" class="service-choice" data-service="codex"><span class="service-mark codex-mark">⌘</span><span><b>Codex</b><small>Agentic development</small></span><i>✓</i></button><button type="button" class="service-choice" data-service="api"><span class="service-mark api-mark"><button type="button" class="service-choice" data-service="codex"><span class="service-mark codex-mark">⌘</span><span><b>Codex</b><small>Agentic development</small></span><i>✓</i></button></div>lt;/<button type="button" class="service-choice" data-service="codex"><span class="service-mark codex-mark">⌘</span><span><b>Codex</b><small>Agentic development</small></span><i>✓</i></button></div>gt;</span><span><b>Standalone API</b><small>Custom agents and services</small></span><i>✓</i></button></div><div id="service-config" class="service-config"><p>Select a service to create its dedicated API key.</p></div></section><section class="profile-card profile-security"><span class="eyebrow">WORKSPACE SECURITY</span><h3>Sign-in details</h3><p>Change the administrator username or password. Confirm your current password to save.</p><form id="details-security"><label>Username<input id="details-username" minlength="3" maxlength="40" autocomplete="username"></label><label>Current password<input id="details-current" type="password" required autocomplete="current-password"></label><label>New password <small>Leave blank to keep it.</small><input id="details-new" type="password" minlength="10" autocomplete="new-password"></label><button class="primary">Save sign-in details</button></form></section></main></div>`;const profile=await api("/api/app/auth/profile").catch(()=>({username:""}));root.querySelector("#details-username").value=profile.username||"";root.querySelector("#details-back").onclick=()=>{history.pushState({},"","/");s.view="inbox";s.detailsAccount=null;render()};root.querySelector("#details-label").onsubmit=async event=>{event.preventDefault();try{await api(`/api/app/accounts/${encodeURIComponent(account.id)}/label`,{method:"PATCH",body:JSON.stringify({label:root.querySelector("#details-label-value").value})});notice("Account name saved");await refresh()}catch(error){notice(error.message)}};const showService=service=>{root.querySelectorAll(".service-choice").forEach(button=>button.classList.toggle("selected",button.dataset.service===service));const config=root.querySelector("#service-config");const labels={n8n:"n8n",claude:"Claude",codex:"Codex",api:"Standalone API"};config.innerHTML="";const title=document.createElement("h3");title.textContent=`Connect ${labels[service]}`;const text=document.createElement("p");text.textContent=`Create a dedicated ${labels[service]} API key for this WhatsApp account. You can revoke it any time.`;const action=document.createElement("button");action.className="primary";action.type="button";action.textContent=`Create ${labels[service]} API key`;const output=document.createElement("div");action.onclick=async()=>{try{const data=await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys`,{method:"POST",body:JSON.stringify({name:`${labels[service]} integration`,scopes:["messages:read","messages:send"]})});output.className="profile-secret";output.innerHTML=`<b>Copy this key now.</b><code>${esc(data.token)}</code>`}catch(error){notice(error.message)}};config.append(title,text,action,output)};root.querySelectorAll(".service-choice").forEach(button=>button.onclick=()=>showService(button.dataset.service));root.querySelector("#details-security").onsubmit=async event=>{event.preventDefault();try{const data=await api("/api/app/auth/profile",{method:"PATCH",body:JSON.stringify({username:root.querySelector("#details-username").value,currentPassword:root.querySelector("#details-current").value,newPassword:root.querySelector("#details-new").value})});root.querySelector("#details-current").value="";root.querySelector("#details-new").value="";notice(`Saved sign-in details for ${data.username}`)}catch(error){notice(error.message)}}};

// Services are independent integrations: users can create one or many account-scoped keys.
const openAccountDetailsWithMultiService=openAccountDetails;
openAccountDetails=async account=>{await openAccountDetailsWithMultiService(account);const selected=new Set();const config=root.querySelector("#service-config");const labels={n8n:"n8n",claude:"Claude",codex:"Codex",api:"Standalone API"};const removePanel=service=>config.querySelector(`[data-service-panel="${service}"]`)?.remove();const addPanel=service=>{const panel=document.createElement("section");panel.className="service-key-panel";panel.dataset.servicePanel=service;const title=document.createElement("h3");title.textContent=`${labels[service]} API key`;const text=document.createElement("p");text.textContent=`Create a dedicated key for ${labels[service]}. This connection can run alongside every other selected service.`;const action=document.createElement("button");action.type="button";action.className="primary";action.textContent=`Create ${labels[service]} API key`;const output=document.createElement("div");action.onclick=async()=>{try{const data=await api(`/api/app/accounts/${encodeURIComponent(account.id)}/integration-keys`,{method:"POST",body:JSON.stringify({name:`${labels[service]} integration`,scopes:["messages:read","messages:send"]})});output.className="profile-secret";output.innerHTML=`<b>Copy this key now.</b><code>${esc(data.token)}</code>`}catch(error){notice(error.message)}};panel.append(title,text,action,output);config.append(panel)};root.querySelectorAll(".service-choice").forEach(button=>{button.onclick=()=>{const service=button.dataset.service;if(selected.has(service)){selected.delete(service);button.classList.remove("selected");removePanel(service);return}selected.add(service);button.classList.add("selected");addPanel(service)}})};
