import React,{useCallback,useEffect,useMemo,useRef,useState}from"react";
import{runExclusive,api}from"./app-helpers.mjs";
import{Avatar}from"./ui-helpers.jsx";
import{createRoot}from"react-dom/client";
import{ChatPanel}from"./chat.jsx";

const slug=x=>String(x||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
const status=x=>({WORKING:"Connected",SCAN_QR_CODE:"Ready to scan",STARTING:"Starting WhatsApp",STOPPED:"Offline",FAILED:"Needs attention"})[x]||x||"Connecting";
const detailsSlug=()=>{const match=window.location.pathname.match(/^\/details\/([^/]+)\/?$/);return match?decodeURIComponent(match[1]):null};
const maskSecret=(length,last4)=>last4?`${"•".repeat(Math.max(0,Number(length||0)-String(last4).length))}${last4}`:"Saved — leave blank to keep";

function Login({setup,done,fail}){
  const[error,setError]=useState("");
  const go=async e=>{
    e.preventDefault();setError("");
    try{await api("/api/app/auth/"+(setup?"setup":"login"),{method:"POST",body:JSON.stringify({username:e.currentTarget.username.value,password:e.currentTarget.password.value,remember:e.currentTarget.remember?.checked||false})});done();return}
    catch(x){setError(x.message||"Sign in failed");fail(x.message)}
  };
  return <main className="pairing"><section className="pair-card"><span className="eyebrow">GAKAI WORKSPACE</span><h1>{setup?"Create your administrator account":"Welcome back"}</h1><p>{setup?"This administrator account protects your Gakai workspace. Use it to connect, manage, and switch between multiple WhatsApp accounts.":"Sign in to manage your connected WhatsApp accounts."}</p><form onSubmit={go}>{error?<p className="form-error" role="alert">{error}</p>:null}<label>{setup?"Administrator username":"Username"}<input name="username" minLength="3" required autoComplete="username"/></label><label>{setup?"Administrator password":"Password"}<input name="password" type="password" minLength="10" required autoComplete={setup?"new-password":"current-password"}/></label><label className="check-row"><input name="remember" type="checkbox"/> Keep me logged in</label><button type="submit" className="primary wide">{setup?"Create administrator account":"Sign in"}</button></form></section></main>
}

function qrImage(value){const raw=typeof value==="string"?value:(value?.image||value?.qr||value?.value||value?.data||value?.code||value?.qrCode||value?.base64||value?.imageData||"");if(!raw)return null;if(/^data:image\//i.test(raw)||/^https?:\/\//i.test(raw))return raw;return "data:image/png;base64,"+raw}

function Pairing({account,onLinked,onCancel}){
  const[image,setImage]=useState(null),[message,setMessage]=useState("Preparing a secure QR code…");
  useEffect(()=>{
    let live=true,timer;
    const poll=async()=>{
      try{const a=await api("/api/app/accounts"),current=(a.accounts||[]).find(x=>x.id===account.id);if(!live)return;if(current?.status==="WORKING"){onLinked(current);return}setMessage(current?status(current.status):"Starting WhatsApp");const code=await api("/api/app/accounts/"+encodeURIComponent(account.id)+"/qr");if(!live)return;const src=qrImage(code);if(src){setImage(src);setMessage("Scan this code with WhatsApp on your phone")}else setMessage("Waiting for WhatsApp to generate a QR code…")}catch(x){if(live){setImage(null);setMessage(x.message||"Could not load QR code")}}finally{if(live)timer=setTimeout(poll,3000)}
    };
    api("/api/app/accounts/"+encodeURIComponent(account.id)+"/start",{method:"POST"}).catch(()=>{}).finally(poll);
    return()=>{live=false;clearTimeout(timer)}
  },[account.id,onLinked]);
  return <main className="pairing"><section className="pair-card"><span className="eyebrow">CONNECT WHATSAPP</span><h1>Link {account.label}</h1><p>Open WhatsApp on your phone, then scan this code to link <b>{account.label}</b>.</p>{image?<img className="qr" src={image} alt="WhatsApp pairing QR code"/>:<div className="qr loading" role="status">{message}</div>}<ol><li>Open WhatsApp on your phone</li><li>Choose <b>Linked devices</b></li><li>Tap <b>Link a device</b> and scan this code</li></ol><p className="pair-status"><i/>{message}</p><button className="pairing-cancel" onClick={onCancel}>Cancel</button></section></main>
}

function Settings({account,onClose,onDeleted,onNotice,onRenamed}){
  const[llm,setLlm]=useState(null),[n8n,setN8n]=useState(null),[profile,setProfile]=useState(null),[service,setService]=useState(null),[busy,setBusy]=useState(false),[testModal,setTestModal]=useState(null),[testResult,setTestResult]=useState(null);
  const base="/api/app/accounts/"+encodeURIComponent(account.id);
  const[n8nWorkflowId,setN8nWorkflowId]=useState("");
  const refresh=useCallback(()=>Promise.all([api(base+"/llm"),api(base+"/n8n/connect"),api("/api/app/auth/profile")]).then(x=>{setLlm(x[0]);setN8n(x[1]);setProfile(x[2])}).catch(x=>onNotice(x.message)),[base,onNotice]);
  useEffect(()=>{refresh()},[refresh]);
  
  // Escape key to close
  useEffect(()=>{
    const onKey=(e)=>{if(e.key!=="Escape")return;if(testModal)setTestModal(null);else onClose()};
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[onClose,testModal]);

  const saveLlm=async e=>{e.preventDefault();const f=e.currentTarget;const enteredKey=f.apiKey.value.trim(),next={configured:true,baseUrl:f.baseUrl.value.trim().replace(/\/+$/,"") ,model:f.model.value.trim(),systemPrompt:f.systemPrompt.value,nativeEnabled:llm?.nativeEnabled||false,apiKeyLast4:enteredKey?enteredKey.slice(-4):llm?.apiKeyLast4||""};setBusy(true);try{const result=await api(base+"/llm",{method:"POST",body:JSON.stringify({baseUrl:next.baseUrl,apiKey:enteredKey||"__keep__",model:next.model,systemPrompt:next.systemPrompt,n8nWorkflowId})});setLlm(next);await refresh();onNotice(result.n8nAgentExampleAdded?"LLM Proxy saved. Gakai added an AI Agent example to the selected n8n workflow—connect it where you need it.":"LLM Proxy saved and verified.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  // Immediate "Enable native AI replies" toggle — matches setN8nAgentEnabled's
  // immediacy so both mutually-exclusive reply paths behave the same way.
  const setNativeEnabled=async enabled=>{
    setBusy(true);
    try{
      const result=await api(base+"/llm/native",{method:"PATCH",body:JSON.stringify({nativeEnabled:enabled})});
      await refresh();
      onNotice(enabled&&result?.n8nWorkflowsDeactivated?"Native AI replies are on. Gakai will reply directly through the proxy; both n8n reply workflows are inactive.":enabled?"Native AI replies enabled.":"Native AI replies disabled.");
    }catch(x){onNotice(x.message)}finally{setBusy(false)}
  };
  const connectN8n=async e=>{e.preventDefault();const f=e.currentTarget;const n8nUrl=f.n8nUrl.value.trim().replace(/\/+$/,"");const enteredKey=f.n8nApiKey.value.trim();setBusy(true);try{const result=await api(base+"/n8n/connect",{method:"POST",body:JSON.stringify({n8nUrl,n8nApiKey:enteredKey||"__keep__"})});setN8n(current=>({...current,connected:true,n8nUrl,n8nApiKeyLength:enteredKey.length||current?.n8nApiKeyLength||0,n8nApiKeyLast4:enteredKey?enteredKey.slice(-4):current?.n8nApiKeyLast4||"",workflows:result.workflowId?[...(current?.workflows||[]).filter(workflow=>workflow.kind!=="standard"),{kind:"standard",workflowId:result.workflowId,workflowName:result.workflowName,workflowUrl:result.workflowUrl}]:current?.workflows||[]}));await refresh();onNotice(result.reused?"n8n connection verified.":"n8n workflow created and connected.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  const saveName=async e=>{e.preventDefault();const label=e.currentTarget.label.value.trim();if(!label)return;setBusy(true);try{await api(base+"/label",{method:"PATCH",body:JSON.stringify({label})});onRenamed?.(account.id,label);onNotice("Account name saved.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  const saveProfile=async e=>{e.preventDefault();const f=e.currentTarget;setBusy(true);try{const result=await api("/api/app/auth/profile",{method:"PATCH",body:JSON.stringify({username:f.username.value,currentPassword:f.currentPassword.value,newPassword:f.newPassword.value})});setProfile(current=>({...current,username:result.username}));f.currentPassword.value="";f.newPassword.value="";onNotice("Sign-in details saved.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  const del=async()=>{if(!confirm(`Delete ${account.label} from Gakai? Its linked WhatsApp session will be removed. You can add and scan it again later.`))return;setBusy(true);try{await api(base,{method:"DELETE"});onDeleted()}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  // "Enable n8n AI Agent replies": one action for both first-time setup
  // (creates the n8n workflow) and re-enabling an existing one — the server
  // route is idempotent either way and also turns native replies off,
  // since only one reply path can be live at a time.
  const setN8nAgentEnabled=async enabled=>{
    setBusy(true);
    try{
      let result=null;
      if(enabled){
        result=await api(base+"/n8n/connect/ai",{method:"POST"});
      }else if(agentWorkflow?.subscriptionId){
        result=await api(base+"/automations/"+encodeURIComponent(agentWorkflow.subscriptionId),{method:"PATCH",body:JSON.stringify({enabled:false})});
      }
      await refresh();
      onNotice(enabled?(result?.standardWorkflowUnpublished?"AI Agent replies are on. The standard workflow is now inactive.":result?.standardWorkflowMissing?"AI Agent replies are on. The old standard workflow no longer exists in n8n.":"AI Agent replies are on and the workflow is active."):result?.n8nWorkflowsDeactivated?"AI Agent replies are off. Both n8n workflows are inactive.":"AI Agent replies are off.");
    }catch(x){onNotice(x.message)}finally{setBusy(false)}
  };
  // Shared by both the n8n and LLM Proxy "Send test message" buttons — same
  // modal (phone number + message), routed to whichever endpoint the open
  // modal's kind calls for. For n8n, the phone number is both the simulated
  // sender and where the workflow's reply gets delivered. For the direct LLM
  // proxy there's no simulated inbound message — the phone number, if given,
  // is just where the proxy's reply gets delivered; left blank, it's a
  // connectivity check only (proxy called, reply shown, nothing sent).
  const sendTestMessage=async e=>{
    e.preventDefault();
    const f=e.currentTarget,phone=f.phone.value.trim(),text=f.text.value.trim();
    if(!text)return;
    setBusy(true);setTestResult(null);
    try{
      if(testModal.kind==="n8n"){
        const result=await api(base+"/automations/"+encodeURIComponent(testModal.subscriptionId)+"/test",{method:"POST",body:JSON.stringify({phone,text})});
        setTestResult({ok:true,text:result.reply?`Reply from n8n: "${result.reply}"${phone?" — sent to "+phone:""}`:"Delivered to n8n, but the workflow sent back no reply — check your n8n execution log."});
        await refresh();
      }else{
        const result=await api(base+"/llm/test",{method:"POST",body:JSON.stringify({prompt:text,phone})});
        setTestResult({ok:true,text:result.delivered?`Reply from LLM Proxy: "${result.reply}" — sent to ${phone}`:`LLM Proxy replied: "${result.reply}" (enter a phone number above to actually deliver it to WhatsApp)`});
      }
    }catch(x){
      setTestResult({ok:false,text:x.message});
    }finally{
      setBusy(false);
    }
  };
  const deleteIntegration=async kind=>{const label=kind==="n8n"?"n8n automation":"LLM Proxy";if(!confirm(`Delete the ${label} integration for ${account.label}?`))return;setBusy(true);try{await api(base+(kind==="n8n"?"/n8n/connect":"/llm"),{method:"DELETE"});await refresh();onNotice(`${label} integration deleted.`)}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  const toggleAutomation=async(subscriptionId,enabled,label)=>{if(!subscriptionId)return;setBusy(true);try{const result=await api(base+"/automations/"+encodeURIComponent(subscriptionId),{method:"PATCH",body:JSON.stringify({enabled})});await refresh();onNotice(enabled&&result.aiWorkflowUnpublished?"n8n replies are on. The AI Agent workflow is now inactive.":enabled&&result.aiWorkflowMissing?"n8n replies are on. The old AI Agent workflow no longer exists in n8n.":enabled&&result.standardWorkflowRecreated?"n8n replies are on. A new standard workflow was created and activated.":enabled?"n8n replies are on and the workflow is active.":result.n8nWorkflowsDeactivated?"n8n replies are off. Both n8n workflows are inactive.":"n8n replies are off.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};

  const services={
    n8n:{title:"n8n Automation",subtitle:"Automation",ready:!!n8n?.connected},
    llm:{title:"LLM Proxy",subtitle:"AI replies",ready:!!llm?.configured},
  };
  const agentWorkflow=n8n?.workflows?.find(workflow=>workflow.kind==="agentic");
  const standardWorkflow=n8n?.workflows?.find(workflow=>workflow.kind==="standard");
  useEffect(()=>{if(agentWorkflow?.workflowId)setN8nWorkflowId(agentWorkflow.workflowId)},[agentWorkflow?.workflowId]);
  const detail=service==="n8n"?<><h3>n8n Automation</h3><p>Create Gakai’s standard automation template in your n8n instance. It contains no AI node.</p>{standardWorkflow?<div className="workflow-links"><a href={standardWorkflow.workflowUrl} target="_blank" rel="noreferrer"><span>{`n8n workflow (${standardWorkflow.workflowId})`}</span><b>{standardWorkflow.workflowName||"Gakai"}</b><em>Open in n8n ↗</em></a></div>:null}{standardWorkflow?.subscriptionId?<label className="checkbox-field"><input type="checkbox" checked={!!standardWorkflow.active} disabled={busy} onChange={e=>toggleAutomation(standardWorkflow.subscriptionId,e.currentTarget.checked,"n8n replies")}/><span><b>Enable n8n replies</b><small>Route direct messages, and group messages where you're tagged, through this n8n automation. Turns off native AI replies and n8n AI Agent replies.</small></span></label>:null}{standardWorkflow?.subscriptionId?<button type="button" className="secondary n8n-test-action" onClick={()=>{setTestModal({kind:"n8n",subscriptionId:standardWorkflow.subscriptionId});setTestResult(null)}}>Send test message</button>:null}<form key={`n8n-${n8n?.n8nUrl||"new"}`} className="integration-form integration-form-stacked" onSubmit={connectN8n}><label>n8n URL<input name="n8nUrl" type="url" defaultValue={n8n?.n8nUrl||""} placeholder="https://yourname.app.n8n.cloud" required/></label><label>n8n API key<input name="n8nApiKey" type="password" placeholder="Paste a replacement n8n API key" required={!n8n?.connected}/>{n8n?.connected&&<small className="saved-key-mask">Saved key: ••••…••{n8n.n8nApiKeyLast4}</small>}</label><button className="primary integration-submit" disabled={busy}>{busy?"Verifying authorization…":"Save and verify authorization"}</button></form></>:service==="llm"?<><h3>LLM Proxy</h3><p>Connect LiteLLM or OmniRoute for AI-powered replies.</p>{agentWorkflow?<div className="workflow-links"><a href={agentWorkflow.workflowUrl} target="_blank" rel="noreferrer"><span>{`AI Agent workflow (${agentWorkflow.workflowId})`}</span><b>{agentWorkflow.workflowName||"Gakai AI Agent"}</b><em>Open in n8n ↗</em></a></div>:null}{llm?.configured?<button type="button" className="secondary llm-test-action" onClick={()=>{const useAgent=!!agentWorkflow?.active&&!!agentWorkflow?.subscriptionId;setTestModal(useAgent?{kind:"n8n",subscriptionId:agentWorkflow.subscriptionId}:{kind:"llm"});setTestResult(null)}}>Send test message{agentWorkflow?.active?" (via n8n AI Agent)":""}</button>:null}<form key={`llm-${llm?.baseUrl||"new"}-${llm?.model||""}`} className="integration-form integration-form-stacked" onSubmit={saveLlm}><label>Proxy URL<input name="baseUrl" type="url" defaultValue={llm?.baseUrl||""} placeholder="https://proxy.example/v1" required/></label><label>Proxy API key<input name="apiKey" type="password" placeholder="Paste a replacement proxy API key" required={!llm?.configured}/>{llm?.configured&&<small className="saved-key-mask">Saved key: ••••…••{llm.apiKeyLast4}</small>}</label><label>Model<input name="model" defaultValue={llm?.model||""} placeholder="oc/nemotron-3-ultra-free" required/></label><label>Assistant instructions<textarea name="systemPrompt" rows="6" defaultValue={llm?.systemPrompt||""}/></label>{llm?.configured&&n8n?.connected?<label className="checkbox-field"><input type="checkbox" checked={!!agentWorkflow?.active} disabled={busy} onChange={e=>setN8nAgentEnabled(e.currentTarget.checked)}/><span><b>Enable n8n AI Agent replies</b><small>Creates or updates the n8n AI Agent workflow and replies through it — direct messages, and group messages where you're tagged. Turns off native AI replies and standard n8n replies.</small></span></label>:llm?.configured?<p className="hint-inline"><small>Connect n8n in the n8n Automation panel to enable AI Agent replies through n8n.</small></p>:null}{llm?.configured?<label className="checkbox-field"><input type="checkbox" checked={!!llm?.nativeEnabled} disabled={busy} onChange={e=>setNativeEnabled(e.currentTarget.checked)}/><span><b>Enable native AI replies (no n8n)</b><small>Gakai sends the incoming message to this proxy and returns its response straight through WhatsApp. It turns off and deactivates both n8n reply workflows.</small></span></label>:null}<button className="primary integration-submit" disabled={busy}>{busy?"Verifying proxy…":"Save and verify proxy"}</button></form></>:<><h3>Select services</h3><p>Choose a service to configure it for <b>{account.label}</b>.</p></>;

  return <div className="details" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header className="details-head">
      <div className="details-identity">
        <Avatar item={account}/>
        <div><span className="eyebrow">ACCOUNT DETAILS</span><h2 id="settings-title">{account.label}</h2><small>Phone: {account.phone||"Not connected"} · {status(account.status)}</small></div>
      </div>
      <button className="secondary" onClick={onClose} aria-label="Back to inbox">‹ Inbox</button>
    </header>
    <main className="details-main">
      <div className="details-top">
        <section className="details-card"><h3>Account name</h3><p>Name this WhatsApp account for your workspace.</p><form onSubmit={saveName}><input name="label" defaultValue={account.label} maxLength="80" required/><button className="primary" disabled={busy}>Save</button></form></section>
        <section className="details-card"><h3>Integrations</h3><p>Connect automation, AI, or custom services with separate account-scoped settings.</p><small>Keys and configuration stay isolated to this WhatsApp account.</small></section>
      </div>
      <section className="details-card services"><div className="services-list"><h3>Services</h3>{Object.entries(services).map(([key,item])=><button key={key} data-service={key} type="button" className={(service===key?"on ":"")+(item.ready?"has-integration":"")} onClick={()=>{setService(key);setTestModal(null);setTestResult(null)}}>{item.title}<small>{item.subtitle}</small>{item.ready?<span className="integration-check" aria-label="Connected">✓</span>:null}</button>)}</div><div className="service-detail">{detail}{service==="n8n"&&n8n?.connected?<button type="button" className="integration-delete danger" disabled={busy} onClick={()=>deleteIntegration("n8n")}>Delete integration</button>:null}{service==="llm"&&llm?.configured?<button type="button" className="integration-delete danger" disabled={busy} onClick={()=>deleteIntegration("llm")}>Delete integration</button>:null}</div></section>
      <section className="details-card security"><h3>Administrator profile</h3><p>Update your workspace username or password.</p><form onSubmit={saveProfile}><input name="username" defaultValue={profile?.username||""} placeholder="Username" minLength="3"/><input name="currentPassword" type="password" placeholder="Current password" required/><input name="newPassword" type="password" placeholder="New password (optional)" minLength="10"/><button className="primary" disabled={busy}>Save sign-in details</button></form></section>
      <div className="details-delete"><div><h3>Delete account</h3><p>Remove this WhatsApp account from Gakai. You can add and scan it again later.</p></div><button type="button" className="danger" disabled={busy} onClick={del}>{busy?"Deleting…":"Delete account"}</button></div>
    </main>
    {testModal&&<div className="modal-overlay" role="presentation" onClick={()=>setTestModal(null)}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="test-message-title" onClick={e=>e.stopPropagation()}>
        <h3 id="test-message-title">Send test message</h3>
        <p>{testModal.kind==="n8n"?"Send a simulated WhatsApp message to your n8n automation.":"Send a test prompt to your LLM proxy. Add a phone number to also deliver the reply to WhatsApp."}</p>
        <form className="integration-form" onSubmit={sendTestMessage}>
          <label>Phone number<input name="phone" type="tel" placeholder="Optional — e.g. 15551234567"/></label>
          <label>Message<textarea name="text" rows="3" placeholder="This is a Gakai test event." required/></label>
          <div className="modal-actions"><button type="button" className="secondary" onClick={()=>setTestModal(null)}>Cancel</button><button className="primary" disabled={busy}>{busy?"Sending…":"Send"}</button></div>
        </form>
        {testResult&&<p className={testResult.ok?"llm-test-reply":"modal-error"}>{testResult.text}</p>}
      </div>
    </div>}
  </div>
}

function App(){
  const[auth,setAuth]=useState(),[accounts,setAccounts]=useState([]),[accountsReady,setAccountsReady]=useState(false),[account,setAccount]=useState(),[chats,setChats]=useState([]),[chatsLoading,setChatsLoading]=useState(false),[chat,setChat]=useState(),[q,setQ]=useState(""),[add,setAdd]=useState(false),[pair,setPair]=useState(),[pairCreated,setPairCreated]=useState(false),[settings,setSettings]=useState(false),[note,setNote]=useState("");
  const settingsRef=useRef(null);
  const chatListRef=useRef(null);
  const suppressAutoSelectRef=useRef(false);
  const autoPairStartedRef=useRef(false);
  const accountsRequestRef=useRef(0);
  const chatsRequestRef=useRef(0);
  // Session-only (in-memory, gone on reload) stale-while-revalidate cache of
  // each account's last-known chat list. Switching accounts always kicked
  // off a fresh fetch AND blanked the list to show a loading spinner in the
  // meantime — even when re-visiting an account seen moments ago this tab
  // session. Painting the cached snapshot instantly while load() refreshes
  // it in the background removes that flash without weakening freshness:
  // load()'s own version guard and the account's live SSE stream still
  // decide what's authoritative, exactly as before this cache existed.
  const chatsCacheRef=useRef(new Map());

  const fail=useCallback(x=>{setNote(x);setTimeout(()=>setNote(""),4500)},[]);

  const refresh=useCallback(async()=>{
    // Several call sites (mount, pairing, account delete, SSE-driven polling)
    // can each kick off a /accounts fetch. Only the most recently started one
    // is allowed to apply its result — an older, slower response landing
    // after a newer one must never overwrite it.
    const version=++accountsRequestRef.current;
    try{
      const d=await api("/api/app/accounts"),a=d.accounts||[];
      if(accountsRequestRef.current!==version)return;
      const requestedDetails=detailsSlug(),requestedAccount=requestedDetails?a.find(item=>slug(item.label)===requestedDetails||slug(item.id)===requestedDetails):null;setAccounts(a);if(requestedAccount){setAccount(requestedAccount);if(requestedAccount.status!=="WORKING"){history.replaceState({},"","/");setSettings(false);setPairCreated(false);setPair(requestedAccount)}else setSettings(true)}else setAccount(old=>a.find(x=>x.id===old?.id)||a.find(x=>x.status==="WORKING")||a[0])
    }catch(x){if(accountsRequestRef.current===version)fail(x.message)}finally{if(accountsRequestRef.current===version)setAccountsReady(true)}
  },[fail]);

  const load=useCallback(async id=>{
    // load() is called from account switches, the SSE change handler, a
    // background poll timer, and after sending a message — any of which can
    // overlap across different accounts while the reader switches accounts.
    // Without this version guard, a slower request for the previously
    // selected account can resolve after a newer one and stomp the current
    // account's chat list with the old account's conversations.
    const version=++chatsRequestRef.current;
    // Only show the loading state for a true cold start (nothing cached for
    // this account yet, e.g. first visit this tab session) — a revisit
    // already has something to paint, so this refresh happens quietly.
    if(!chatsCacheRef.current.has(id))setChatsLoading(true);
    try{
      const d=await api("/api/app/accounts/"+encodeURIComponent(id)+"/chats");
      if(chatsRequestRef.current!==version)return;
      const next=(Array.isArray(d)?d:d.chats||[]).sort((left,right)=>Number(right.timestamp||right.lastMessage?.timestamp||0)-Number(left.timestamp||left.lastMessage?.timestamp||0));
      chatsCacheRef.current.set(id,next);
      setChats(next);
      // A working inbox should open on a useful conversation, not a blank
      // "Select a conversation" placeholder. Keep the reader's existing chat
      // selected during refreshes, otherwise open the newest one.
      setChat(current=>current?next.find(item=>item.id===current.id):suppressAutoSelectRef.current?undefined:next[0]);
    }catch(x){if(chatsRequestRef.current===version)fail(x.message)}finally{if(chatsRequestRef.current===version)setChatsLoading(false)}
  },[fail]);

  const handleAccountRenamed=useCallback((id,label)=>{
    setAccounts(current=>current.map(item=>item.id===id?{...item,label}:item));
    setAccount(current=>current?.id===id?{...current,label}:current);
  },[]);

  // SSE carries normalized Gakai events. Keep a low-frequency fallback for
  // provider changes that do not emit a webhook (for example, a QR lifecycle).
  // `load` and `chats.length` are read through refs rather than as effect
  // dependencies: chats.length changes on every load() this same effect
  // triggers, so depending on it directly tore down and reopened the
  // EventSource connection (and re-registered the SSE query on the server)
  // on every chat-count change while the inbox was actively syncing.
  const loadRef=useRef(load);
  useEffect(()=>{loadRef.current=load},[load]);
  const chatsLengthRef=useRef(chats.length);
  useEffect(()=>{chatsLengthRef.current=chats.length},[chats.length]);
  useEffect(()=>{
    if(!account || account.status!=="WORKING") return;
    const stream=new EventSource("/api/app/events?accountId="+encodeURIComponent(account.id));
    const update=event=>{
      try{const change=JSON.parse(event.data);if(change.account?.id===account.id)loadRef.current(account.id)}catch{}
    };
    stream.addEventListener("gakai",update);
    let timer;
    const schedule=()=>{timer=window.setTimeout(()=>{loadRef.current(account.id);schedule()},chatsLengthRef.current?60000:10000)};
    schedule();
    return()=>{stream.removeEventListener("gakai",update);stream.close();window.clearTimeout(timer)};
  },[account?.id, account?.status]);

  // The sidebar's unread dot must reflect every connected account, not just
  // whichever one is currently open — so it needs its own SSE subscription
  // per account (the endpoint already scopes broadcasts by accountId, so
  // this is cheap: one more listener, not one more poll loop). Keyed off a
  // derived id+status string rather than the `accounts` array itself, since
  // this effect must not tear down and reopen every stream just because an
  // unread flag it's meant to observe changed.
  //
  // An event on account X's own stream already means "X just got a real
  // message" — the server only emits these for genuine inbound content (see
  // dispatchAutomationEvent) — so there's no need to re-ask the provider for
  // anything to know X now has something unread. Flip its flag locally.
  // Re-fetching *every* account's full chat overview on *any* one event (the
  // previous approach) doesn't just waste provider calls: an account's chat
  // list re-rendering far more often than necessary is exactly the kind of
  // extra activity that can make the underlying WhatsApp session mark
  // things as seen on its own, and can also starve the picture-fetch
  // enrichment that the same overview call feeds — both observed live (a
  // message reading itself within seconds; avatars that had been resolving
  // fine going blank).
  const refreshRef=useRef(refresh);
  useEffect(()=>{refreshRef.current=refresh},[refresh]);
  const workingAccountsKey=accounts.filter(item=>item.status==="WORKING").map(item=>item.id).join(",");
  useEffect(()=>{
    const ids=workingAccountsKey?workingAccountsKey.split(","):[];
    if(!ids.length)return undefined;
    const streams=ids.map(id=>{
      // after=now: this stream already has the true current unread state
      // from the regular /accounts fetch — without opting out, every fresh
      // connection replays recent history (for reconnect catch-up), and
      // this handler has no way to tell that apart from something genuinely
      // new, so it pinned the dot on immediately regardless of real state.
      const stream=new EventSource("/api/app/events?accountId="+encodeURIComponent(id)+"&after=now");
      const update=()=>setAccounts(current=>current.map(item=>item.id===id?{...item,hasUnread:true}:item));
      stream.addEventListener("gakai",update);
      stream._gakaiUpdate=update;
      return stream;
    });
    // A rare, low-frequency fallback: a read that happens entirely outside
    // Gakai (another linked device) never emits a webhook, so this alone
    // still needs an eventual-consistency check — deliberately infrequent
    // now that turning the dot on (above) and off (see handleChatClick)
    // no longer depend on it for the normal case.
    const timer=window.setInterval(()=>refreshRef.current(),5*60*1000);
    return()=>{streams.forEach(stream=>{stream.removeEventListener("gakai",stream._gakaiUpdate);stream.close()});window.clearInterval(timer)};
  },[workingAccountsKey]);

  useEffect(()=>{api("/api/app/auth/state").then(setAuth).catch(x=>fail(x.message))},[fail]);
  useEffect(()=>{if(auth?.authenticated)refresh()},[auth,refresh]);
  useEffect(()=>{suppressAutoSelectRef.current=false;setChat();setChats(chatsCacheRef.current.get(account?.id)||[]);if(account?.status==="WORKING")load(account.id)},[account?.id,account?.status,load]);

  const logout=async()=>{await api("/api/app/auth/logout",{method:"POST"}).catch(()=>{});window.location.assign("/")};
  
  const visible=useMemo(()=>chats.filter(x=>(String(x.name||x.id)+" "+String(x.lastMessage?.body||x.lastMessage?.text||"")).toLowerCase().includes(q.toLowerCase())),[chats,q]);

  // Keep unread state server-authoritative. The badge clears only after the
  // provider has accepted the read receipt; no arbitrary client timer.
  const markingReadRef=useRef(new Set());
  const handleChatClick=useCallback((chatItem)=>{
    suppressAutoSelectRef.current=false;
    setChat(chatItem);
    if(chatItem.unreadCount && account){
      // A rapid double-click (or clicking away and back before the first
      // POST resolves) must not fire two concurrent mark-as-read requests.
      runExclusive(markingReadRef.current,chatItem.id,async()=>{
        try{
          await api("/api/app/accounts/"+encodeURIComponent(account.id)+"/chats/"+encodeURIComponent(chatItem.id)+"/read",{method:"POST"});
          setChats(current=>{
            const next=current.map(c=>c.id===chatItem.id?{...c,unreadCount:0}:c);
            chatsCacheRef.current.set(account.id,next);
            // The sidebar's unread dot should clear the moment the reader
            // actually reads the last unread conversation, not on some
            // later poll — computed straight from the list already in
            // hand (no extra provider round trip needed to know this).
            const stillUnread=next.some(c=>c.unreadCount>0);
            setAccounts(list=>list.map(a=>a.id===account.id?{...a,hasUnread:stillUnread}:a));
            return next;
          });
          load(account.id);
        }catch(x){fail(x.message||"Could not mark this conversation as read");}
      });
    }
  },[account,fail,load]);

  const pairingLockRef=useRef(new Set());
  const beginPairing=()=>runExclusive(pairingLockRef.current,"pairing",async()=>{
    // Shared by the auto-pair effect below and the manual "+ Connect
    // account" button — without this guard, clicking the button while the
    // auto-pair effect's own call is still in flight could create two
    // account placeholders before refresh() catches up.
    try{
      // A connection must exist before the provider can generate its QR code.
      // Start that work immediately from the user action—there is no redundant
      // second "continue" screen between the dashboard and the scanner.
      const d=await api("/api/app/accounts",{method:"POST",body:JSON.stringify({label:"WhatsApp account"})});
      setAdd(false);setPairCreated(true);setPair(d.account);setAccount(d.account);refresh();
    }catch(x){fail(x.message)}
  });

  // A new workspace has no reason to stop at a second "Connect WhatsApp"
  // screen. Create the first account as soon as setup is complete and let the
  // pairing view show the QR code directly.
  useEffect(()=>{
    if(!accountsReady||accounts.length||pair||autoPairStartedRef.current)return;
    autoPairStartedRef.current=true;
    beginPairing();
  },[accountsReady,accounts.length,pair]);

  const cancelPairing=useCallback(async()=>{
    const pending=pair, createdHere=pairCreated;
    setPair();setPairCreated(false);
    if(!pending||!createdHere)return;
    try{
      // Re-read the status so a successful scan is never deleted if it raced
      // with the user's cancel click. Only the unlinked session is discarded.
      const response=await api("/api/app/accounts");
      const current=(response.accounts||[]).find(item=>item.id===pending.id);
      if(current&&current.status!=="WORKING")await api("/api/app/accounts/"+encodeURIComponent(pending.id),{method:"DELETE"});
      await refresh();
    }catch(x){fail(x.message||"Could not cancel this WhatsApp connection");await refresh();}
  },[fail,pair,pairCreated,refresh]);

  // Re-fetch chats after sending (handled via onSent from ChatPanel)
  const handleSent=useCallback((message, chatItem)=>{
    if(chatItem && account){
      load(account.id);
    }
  },[account?.id, load]);
  const handleChatDeleted=useCallback(chatId=>{
    suppressAutoSelectRef.current=true;
    setChats(current=>{
      const next=current.filter(item=>item.id!==chatId);
      // No load() follows this one (unlike handleChatClick's read-marking),
      // so without this the cache would resurrect the deleted chat the next
      // time this account is switched back to, until something else
      // happened to refresh it.
      if(account)chatsCacheRef.current.set(account.id,next);
      return next;
    });
    setChat(current=>current?.id===chatId?undefined:current);
  },[account]);

  if(!auth)return <main className="pairing">Loading Gakai…</main>;
  if(!auth.authenticated)return <Login setup={!!auth.setup} done={()=>location.reload()} fail={fail}/>;
  if(!accountsReady)return <main className="pairing">Loading your workspace…</main>;
  if(pair)return <Pairing account={pair} onCancel={cancelPairing} onLinked={x=>{setPair();setPairCreated(false);setAccount(x);refresh()}}/>;
  if((add||!accounts.length)&&!pair)return <main className="pairing"><section className="pair-card"><span className="eyebrow">CONNECT WHATSAPP</span><h1>Preparing your QR code…</h1><p>Gakai is creating a secure WhatsApp connection. The QR code will appear here automatically.</p><div className="qr loading" role="status">Starting WhatsApp…</div>{accounts.length?<button className="nav wide" onClick={()=>setAdd(false)}>Cancel</button>:null}</section></main>;
  const closeSettings=()=>{history.pushState({},"","/");setSettings(false)};
  const accountDeleted=async()=>{history.replaceState({},"","/");setSettings(false);setChat();await refresh()};
  if(settings&&account)return <><Settings account={account} onClose={closeSettings} onDeleted={accountDeleted} onNotice={fail} onRenamed={handleAccountRenamed}/>{note?<div className="toast" role="status">{note}</div>:null}</>;

  return (
    <>
      <div className="app">
        <aside className="sidebar">
          <div className="logo"><b>G</b>Gakai</div>
          <div className="account-switch">
            {accounts.map(x=><div className="account-row" key={x.id}>
              <button className={"account "+(x.id===account?.id?"selected":"")} onClick={()=>setAccount(x)}>
                <i className={x.hasUnread?"good":""}/>
                <Avatar item={x}/>
                <span><b>{x.label}</b><small>{status(x.status)}</small></span>
              </button>
              <button type="button" className="account-cog" title="Account details" aria-label={"Open settings for "+x.label} onClick={()=>{history.pushState({},'','/details/'+slug(x.label));setAccount(x);setSettings(true)}}>⚙</button>
            </div>)}
            {/* Mobile account switcher dropdown */}
            {accounts.length>1 && <select className="mobile-account-switcher" value={account?.id||""} onChange={e=>{const id=e.target.value; if(id) setAccount(accounts.find(a=>a.id===id))}} aria-label="Switch WhatsApp account">
              {accounts.map(a=><option key={a.id} value={a.id}>{a.label} {a.status==="WORKING"?"✓":""}</option>)}
            </select>}
          </div>
          <button type="button" className="logout" onClick={logout}>Log off</button>
        </aside>
        <main className="main">
          <header>
            <div><h2>Inbox</h2><small>{account?.label} · {status(account?.status)}</small></div>
            <button className="primary" onClick={beginPairing}>+ Connect account</button>
          </header>
          {account?.status!=="WORKING"?<div className="empty"><div><h1>Account needs attention</h1><p>Reconnect this account to continue.</p><button className="primary" onClick={()=>{setPairCreated(false);setPair(account)}}>Reconnect with QR code</button></div></div>:<div className="inbox">
            <section className={"chats "+(chat?"mobile-hide":"")} ref={chatListRef}>
              <input placeholder="Search conversations" value={q} onChange={e=>setQ(e.target.value)} aria-label="Search conversations"/>
              {visible.map(x=><button key={x.id} className={"chat "+(x.id===chat?.id?"active":"")+(x.unreadCount?" has-unread":"")} onClick={()=>handleChatClick(x)}><Avatar item={x}/><span><b>{x.name||x.id}</b><small>{x.lastMessage?.body||x.lastMessage?.text||x.lastMessage?.system?.label||"Photo or message"}</small></span>{x.unreadCount?<span className="unread-pill">{x.unreadCount}</span>:null}</button>)}
              {chatsLoading&&!chats.length?<p className="hint loading-hint" role="status"><span className="spinner" aria-hidden="true"/>Loading conversations from WhatsApp…</p>:!visible.length?<p className="hint">No conversations yet. Gakai is waiting for WhatsApp to finish syncing.</p>:null}
            </section>
            <section className={"conversation "+(!chat?"mobile-hide":"")}>{chat?<ChatPanel accountId={account.id} accountLabel={account.label} accountPicture={account.picture} chat={chat} onBack={()=>setChat()} onSent={handleSent} onDeleted={handleChatDeleted}/>:<div className="blank">Select a conversation</div>}</section>
          </div>}
        </main>
      </div>
      {settings&&account?<Settings account={account} onClose={closeSettings} onDeleted={accountDeleted} onNotice={fail} onRenamed={handleAccountRenamed}/>:null}
      {note?<div className="toast" role="status">{note}</div>:null}
    </>
  )
}
createRoot(document.querySelector("#app")).render(<App/>);
