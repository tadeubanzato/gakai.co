import React,{useCallback,useEffect,useMemo,useRef,useState}from"react";
import{runExclusive,api,compareChats}from"./app-helpers.mjs";
import{createEventHub}from"./event-hub.mjs";
// One live connection for the whole tab, shared by every view that wants events.
const eventHub=createEventHub();
import{Avatar,IconLogout,Menu,MenuItem,status}from"./ui-helpers.jsx";
import{createRoot}from"react-dom/client";
import{ChatPanel}from"./chat.jsx";
import{ConfirmHost,confirmDialog}from"./confirm.jsx";
import{AiProviderFields}from"./ai-responses.jsx";
import{WorkspaceSettings}from"./workspace-settings.jsx";
import{VoiceProfilesPanel}from"./voice-profiles.jsx";
import{parseRoute,profilePath,accountSlug,findAccountBySlug}from"./routes.mjs";

const maskSecret=(length,last4)=>last4?`${"•".repeat(Math.max(0,Number(length||0)-String(last4).length))}${last4}`:"Saved — leave blank to keep";

function Login({setup,done,fail}){
  const[error,setError]=useState("");
  const go=async e=>{
    e.preventDefault();setError("");
    try{await api("/api/app/auth/"+(setup?"setup":"login"),{method:"POST",body:JSON.stringify({username:e.currentTarget.username.value,password:e.currentTarget.password.value,remember:e.currentTarget.remember?.checked||false})});done();return}
    catch(x){setError(x.message||"Sign in failed");fail(x.message)}
  };
  return <main className="pairing"><section className="pair-card"><span className="eyebrow">GAKAI WORKSPACE</span><h1>{setup?"Create your administrator account":"Welcome back"}</h1><p>{setup?"This administrator account protects your Gakai workspace. Use it to connect, manage, and switch between multiple WhatsApp accounts.":"Sign in to manage your connected WhatsApp accounts."}</p><form onSubmit={go}>{error?<p className="form-error" role="alert">{error}</p>:null}<label>{setup?"Administrator username":"Username or email"}<input name="username" minLength="3" required autoComplete="username"/></label><label>{setup?"Administrator password":"Password"}<input name="password" type="password" minLength="10" required autoComplete={setup?"new-password":"current-password"}/></label><label className="check-row"><input name="remember" type="checkbox"/> Keep me logged in</label><button type="submit" className="primary wide">{setup?"Create administrator account":"Sign in"}</button></form></section></main>
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

function Settings({account,tab,onTab,onAllSettings,onReconnect,onClose,onDeleted,onNotice,onRenamed}){
  const[llm,setLlm]=useState(null),[n8n,setN8n]=useState(null),[voices,setVoices]=useState({voices:[],limit:5,templates:[]}),[busy,setBusy]=useState(false),[testModal,setTestModal]=useState(null),[testResult,setTestResult]=useState(null);
  const base="/api/app/accounts/"+encodeURIComponent(account.id);
  const llmFormRef=useRef(null);
  const[n8nWorkflowId,setN8nWorkflowId]=useState("");
  const refresh=useCallback(()=>Promise.all([api(base+"/llm"),api(base+"/n8n/connect"),api(base+"/voices")]).then(x=>{setLlm(x[0]);setN8n(x[1]);setVoices(x[2])}).catch(x=>onNotice(x.message)),[base,onNotice]);
  useEffect(()=>{refresh()},[refresh]);
  
  // Escape key to close
  useEffect(()=>{
    const onKey=(e)=>{if(e.key!=="Escape")return;if(testModal)setTestModal(null);else onClose()};
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[onClose,testModal]);

  const saveLlm=async e=>{e.preventDefault();const f=e.currentTarget;const enteredKey=f.apiKey.value.trim(),next={configured:true,provider:f.provider.value,baseUrl:f.baseUrl.value.trim().replace(/\/+$/,"") ,model:f.model.value.trim(),systemPrompt:f.systemPrompt.value,nativeEnabled:llm?.nativeEnabled||false,apiKeyLast4:enteredKey?enteredKey.slice(-4):llm?.apiKeyLast4||""};setBusy(true);try{const result=await api(base+"/llm",{method:"POST",body:JSON.stringify({provider:next.provider,baseUrl:next.baseUrl,apiKey:enteredKey||"__keep__",model:next.model,systemPrompt:next.systemPrompt,n8nWorkflowId})});setLlm(next);await refresh();onNotice(result.n8nAgentExampleAdded?"AI Responses saved. Gakai added an AI Agent example to the selected n8n workflow—connect it where you need it.":"AI Responses saved.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  // Immediate "Enable native AI replies" toggle — matches setN8nAgentEnabled's
  // immediacy so both mutually-exclusive reply paths behave the same way.
  const setNativeEnabled=async enabled=>{
    setBusy(true);
    try{
      const result=await api(base+"/llm/native",{method:"PATCH",body:JSON.stringify({nativeEnabled:enabled})});
      await refresh();
      onNotice(enabled&&result?.n8nWorkflowsDeactivated?"Native AI replies are on. Gakai will reply directly through your AI provider; both n8n reply workflows are inactive.":enabled?"Native AI replies enabled.":"Native AI replies disabled.");
    }catch(x){onNotice(x.message)}finally{setBusy(false)}
  };
  const connectN8n=async e=>{e.preventDefault();const f=e.currentTarget;const n8nUrl=f.n8nUrl.value.trim().replace(/\/+$/,"");const enteredKey=f.n8nApiKey.value.trim();setBusy(true);try{const result=await api(base+"/n8n/connect",{method:"POST",body:JSON.stringify({n8nUrl,n8nApiKey:enteredKey||"__keep__"})});setN8n(current=>({...current,connected:true,n8nUrl,n8nApiKeyLength:enteredKey.length||current?.n8nApiKeyLength||0,n8nApiKeyLast4:enteredKey?enteredKey.slice(-4):current?.n8nApiKeyLast4||"",workflows:result.workflowId?[...(current?.workflows||[]).filter(workflow=>workflow.kind!=="standard"),{kind:"standard",workflowId:result.workflowId,workflowName:result.workflowName,workflowUrl:result.workflowUrl}]:current?.workflows||[]}));await refresh();onNotice(result.reused?"n8n connection verified.":"n8n workflow created and connected.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  const saveName=async e=>{e.preventDefault();const label=e.currentTarget.label.value.trim();if(!label)return;setBusy(true);try{await api(base+"/label",{method:"PATCH",body:JSON.stringify({label})});onRenamed?.(account.id,label);onNotice("Account name saved.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};

  const del=async()=>{if(!await confirmDialog({title:"Delete this account?",message:`${account.label} will be removed from Gakai and its linked WhatsApp session cleared. You can add and scan it again later.`,confirmLabel:"Delete account",danger:true}))return;setBusy(true);try{await api(base,{method:"DELETE"});onDeleted()}catch(x){onNotice(x.message)}finally{setBusy(false)}};
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
        setTestResult({ok:true,text:result.delivered?`Reply from AI Responses: "${result.reply}" — sent to ${phone}`:`AI Responses replied: "${result.reply}" (enter a phone number above to actually deliver it to WhatsApp)`});
      }
    }catch(x){
      setTestResult({ok:false,text:x.message});
    }finally{
      setBusy(false);
    }
  };
  const deleteIntegration=async kind=>{const label=kind==="n8n"?"n8n automation":"AI Responses";if(!await confirmDialog({title:`Delete ${label} integration?`,message:`The ${label} integration for ${account.label} will be removed.`,confirmLabel:"Delete integration",danger:true}))return;setBusy(true);try{await api(base+(kind==="n8n"?"/n8n/connect":"/llm"),{method:"DELETE"});await refresh();onNotice(`${label} integration deleted.`)}catch(x){onNotice(x.message)}finally{setBusy(false)}};
  const toggleAutomation=async(subscriptionId,enabled,label)=>{if(!subscriptionId)return;setBusy(true);try{const result=await api(base+"/automations/"+encodeURIComponent(subscriptionId),{method:"PATCH",body:JSON.stringify({enabled})});await refresh();onNotice(enabled&&result.aiWorkflowUnpublished?"n8n replies are on. The AI Agent workflow is now inactive.":enabled&&result.aiWorkflowMissing?"n8n replies are on. The old AI Agent workflow no longer exists in n8n.":enabled&&result.standardWorkflowRecreated?"n8n replies are on. A new standard workflow was created and activated.":enabled?"n8n replies are on and the workflow is active.":result.n8nWorkflowsDeactivated?"n8n replies are off. Both n8n workflows are inactive.":"n8n replies are off.")}catch(x){onNotice(x.message)}finally{setBusy(false)}};

  // The tab picks which panel shows; the two integration panels keep their existing content.
  const service=tab==="ai"?"llm":tab==="automation"?"n8n":null;
  const tabs=[{id:"connection",label:"Connection"},{id:"ai",label:"AI responses",ready:!!llm?.configured},{id:"voices",label:"AI Voice and Tone",ready:voices.voices.length>0},{id:"automation",label:"n8n Automation",ready:!!n8n?.connected}];
  const goTab=id=>{setTestModal(null);setTestResult(null);onTab(id)};
  const agentWorkflow=n8n?.workflows?.find(workflow=>workflow.kind==="agentic");
  const standardWorkflow=n8n?.workflows?.find(workflow=>workflow.kind==="standard");
  useEffect(()=>{if(agentWorkflow?.workflowId)setN8nWorkflowId(agentWorkflow.workflowId)},[agentWorkflow?.workflowId]);
  const detail=service==="n8n"?<><h3>n8n Automation</h3><p>Create Gakai’s standard automation template in your n8n instance. It contains no AI node.</p>{standardWorkflow?<div className="workflow-links"><a href={standardWorkflow.workflowUrl} target="_blank" rel="noreferrer"><span>{`n8n workflow (${standardWorkflow.workflowId})`}</span><b>{standardWorkflow.workflowName||"Gakai"}</b><em>Open in n8n ↗</em></a></div>:null}{standardWorkflow?.subscriptionId?<label className="checkbox-field"><input type="checkbox" checked={!!standardWorkflow.active} disabled={busy} onChange={e=>toggleAutomation(standardWorkflow.subscriptionId,e.currentTarget.checked,"n8n replies")}/><span><b>Enable n8n replies</b><small>Route direct messages, and group messages where you're tagged, through this n8n automation. Turns off native AI replies and n8n AI Agent replies.</small></span></label>:null}{standardWorkflow?.subscriptionId?<button type="button" className="secondary n8n-test-action" onClick={()=>{setTestModal({kind:"n8n",subscriptionId:standardWorkflow.subscriptionId});setTestResult(null)}}>Send test message</button>:null}<form key={`n8n-${n8n?.n8nUrl||"new"}`} className="integration-form integration-form-stacked" onSubmit={connectN8n}><label>n8n URL<input name="n8nUrl" type="url" defaultValue={n8n?.n8nUrl||""} placeholder="https://yourname.app.n8n.cloud" required/></label><label>n8n API key<input name="n8nApiKey" type="password" placeholder="Paste a replacement n8n API key" required={!n8n?.connected}/>{n8n?.connected&&<small className="saved-key-mask">Saved key: ••••…••{n8n.n8nApiKeyLast4}</small>}</label><button className="primary integration-submit" disabled={busy}>{busy?"Verifying authorization…":"Save and verify authorization"}</button></form></>:service==="llm"?<><h3>AI Responses</h3><p>Choose who writes your replies: your own LiteLLM proxy, Claude, or ChatGPT. Enter a key and Gakai lists the models available to it.</p>{agentWorkflow?<div className="workflow-links"><a href={agentWorkflow.workflowUrl} target="_blank" rel="noreferrer"><span>{`AI Agent workflow (${agentWorkflow.workflowId})`}</span><b>{agentWorkflow.workflowName||"Gakai AI Agent"}</b><em>Open in n8n ↗</em></a></div>:null}{llm?.configured?<button type="button" className="secondary llm-test-action" onClick={()=>{const useAgent=!!agentWorkflow?.active&&!!agentWorkflow?.subscriptionId;setTestModal(useAgent?{kind:"n8n",subscriptionId:agentWorkflow.subscriptionId}:{kind:"llm"});setTestResult(null)}}>Send test message{agentWorkflow?.active?" (via n8n AI Agent)":""}</button>:null}<form key={`llm-${llm?.provider||"new"}-${llm?.baseUrl||""}-${llm?.model||""}`} className="integration-form integration-form-stacked" ref={llmFormRef} onSubmit={saveLlm}><AiProviderFields llm={llm} base={base} busy={busy} onCommit={()=>llmFormRef.current?.requestSubmit()}/><label>Default instructions<small className="field-hint">Used for anyone without a voice profile. A voice profile is the better way to shape replies.</small><textarea name="systemPrompt" rows="6" defaultValue={llm?.systemPrompt||""} onBlur={e=>{if(llm?.configured&&e.currentTarget.value.trim()!==String(llm.systemPrompt||"").trim())llmFormRef.current?.requestSubmit()}}/></label>{llm?.configured&&n8n?.connected?<label className="checkbox-field"><input type="checkbox" checked={!!agentWorkflow?.active} disabled={busy} onChange={e=>setN8nAgentEnabled(e.currentTarget.checked)}/><span><b>Enable n8n AI Agent replies</b><small>Creates or updates the n8n AI Agent workflow and replies through it — direct messages, and group messages where you're tagged. Turns off native AI replies and standard n8n replies.</small></span></label>:llm?.configured?<p className="hint-inline"><small>Connect n8n in the n8n Automation tab to enable AI Agent replies through n8n.</small></p>:null}</form>{llm?.configured?<div className="ai-next"><b>Next: shape the replies</b><p>Give the AI a voice for each kind of conversation, and choose who each voice answers, in AI Voice and Tone.</p><div className="ai-next-actions"><button type="button" className="secondary" onClick={()=>goTab("voices")}>AI Voice and Tone{voices.voices.length?` (${voices.voices.length})`:""}</button></div></div>:null}{llm?.configured?<label className="checkbox-field"><input type="checkbox" checked={!!llm?.nativeEnabled} disabled={busy} onChange={e=>setNativeEnabled(e.currentTarget.checked)}/><span><b>Enable native AI replies (no n8n)</b><small>Gakai sends the incoming message to your AI provider and returns its response straight through WhatsApp. It turns off and deactivates both n8n reply workflows.</small></span></label>:null}</>:<><h3>Select services</h3><p>Choose a service to configure it for <b>{account.label}</b>.</p></>;

  return <div className="details" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header className="details-head">
      <div className="details-identity">
        <Avatar item={account}/>
        <div><span className="eyebrow">PROFILE SETTINGS</span><h2 id="settings-title">{account.label}</h2><small>{account.phone?`+${account.phone} · `:""}{status(account.status)}</small></div>
      </div>
      <div className="details-head-actions">
        <button className="secondary" onClick={onAllSettings}>All settings</button>
        <button className="secondary" onClick={onClose} aria-label="Back to inbox">‹ Inbox</button>
      </div>
    </header>
    <main className="details-main">
      <nav className="settings-tabs" role="tablist" aria-label="Profile settings">
        {tabs.map(item=><button key={item.id} type="button" role="tab" id={"tab-"+item.id} aria-selected={tab===item.id} aria-controls="settings-panel" className={tab===item.id?"on":""} onClick={()=>goTab(item.id)}>{item.label}{item.ready?<span className="tab-check" aria-label="Set up">✓</span>:null}</button>)}
      </nav>
      <div id="settings-panel" role="tabpanel" aria-labelledby={"tab-"+tab}>
        {tab==="connection"&&<>
          <section className="details-card"><h3>Account name</h3><p>Name this WhatsApp account for your workspace.</p><form onSubmit={saveName}><input name="label" defaultValue={account.label} maxLength="80" required/><button className="primary" disabled={busy}>Save</button></form></section>
          {account.status!=="WORKING"&&<section className="details-card"><h3>Connection</h3><p>This WhatsApp account is not connected right now ({status(account.status).toLowerCase()}). Reconnect it to send and receive messages.</p><button type="button" className="primary" onClick={()=>onReconnect(account)}>Reconnect with QR code</button></section>}
          <div className="details-delete"><div><h3>Delete account</h3><p>Remove this WhatsApp account from Gakai. You can add and scan it again later.</p></div><button type="button" className="danger" disabled={busy} onClick={del}>{busy?"Deleting…":"Delete account"}</button></div>
        </>}
        {tab==="voices"&&<VoiceProfilesPanel base={base} data={voices} llm={llm} onLlmSaved={result=>setLlm(current=>({...current,replyRules:result.replyRules,replyLabels:result.replyLabels}))} onOpenAi={()=>goTab("ai")} onChanged={refresh} onNotice={onNotice}/>}
        {service&&<section className="details-card service-panel"><div className="service-detail">{detail}{service==="n8n"&&n8n?.connected?<button type="button" className="integration-delete danger" disabled={busy} onClick={()=>deleteIntegration("n8n")}>Delete integration</button>:null}{service==="llm"&&llm?.configured?<button type="button" className="integration-delete danger" disabled={busy} onClick={()=>deleteIntegration("llm")}>Delete integration</button>:null}</div></section>}
      </div>
    </main>
    {testModal&&<div className="modal-overlay" role="presentation" onClick={()=>setTestModal(null)}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="test-message-title" onClick={e=>e.stopPropagation()}>
        <h3 id="test-message-title">Send test message</h3>
        <p>{testModal.kind==="n8n"?"Send a simulated WhatsApp message to your n8n automation.":"Send a test prompt to your AI provider. Add a phone number to also deliver the reply to WhatsApp."}</p>
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

// "New chat": a phone-number field that suggests already-synced contacts as
// you type, checks the number is on WhatsApp server-side, and hands the opened
// conversation back to the inbox.
function NewChatDialog({accountId,onClose,onOpened}){
  const[value,setValue]=useState("");
  const[suggestions,setSuggestions]=useState([]);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState("");
  const digits=value.replace(/[^0-9]/g,"");
  useEffect(()=>{
    if(digits.length<3){setSuggestions([]);return undefined;}
    let active=true;
    const timer=setTimeout(async()=>{
      try{
        const data=await api("/api/app/accounts/"+encodeURIComponent(accountId)+"/contacts?q="+encodeURIComponent(digits));
        if(active)setSuggestions(Array.isArray(data.contacts)?data.contacts:[]);
      }catch{if(active)setSuggestions([]);}
    },250);
    return()=>{active=false;clearTimeout(timer);};
  },[accountId,digits]);
  const submit=async event=>{
    event.preventDefault();
    if(busy)return;
    if(digits.length<6){setError("Enter the full number in international format, e.g. 15551234567.");return;}
    setBusy(true);setError("");
    try{
      const data=await api("/api/app/accounts/"+encodeURIComponent(accountId)+"/chats",{method:"POST",body:JSON.stringify({phone:digits})});
      onOpened(data.chat);
    }catch(cause){setError(cause.message||"Could not start this conversation.");}
    finally{setBusy(false);}
  };
  return <div className="modal-overlay" role="presentation" onClick={onClose}>
    <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="new-chat-title" onClick={e=>e.stopPropagation()}>
      <h3 id="new-chat-title">New chat</h3>
      <p>Enter a phone number in international format (country code, no + or spaces needed).</p>
      <form className="integration-form" onSubmit={submit}>
        <label>Phone number<input name="phone" type="tel" autoFocus placeholder="e.g. 15551234567" value={value} onChange={e=>{setValue(e.target.value);setError("")}}/></label>
        {suggestions.length>0&&<ul className="new-chat-suggest" role="listbox" aria-label="Matching contacts">
          {suggestions.map(contact=><li key={contact.id} role="option" aria-selected="false">
            <button type="button" onClick={()=>{setValue(contact.phone);setSuggestions([])}}>
              <b>{contact.name||("+"+contact.phone)}</b><small>+{contact.phone}</small>
            </button>
          </li>)}
        </ul>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy?"Checking…":"Start chat"}</button></div>
      </form>
      {error&&<p className="modal-error">{error}</p>}
    </div>
  </div>;
}

function App(){
  const[auth,setAuth]=useState(),[accounts,setAccounts]=useState([]),[accountsReady,setAccountsReady]=useState(false),[account,setAccount]=useState(),[chats,setChats]=useState([]),[chatsLoading,setChatsLoading]=useState(false),[chat,setChat]=useState(),[q,setQ]=useState(""),[add,setAdd]=useState(false),[pair,setPair]=useState(),[pairCreated,setPairCreated]=useState(false),[route,setRoute]=useState(()=>parseRoute(window.location.pathname)),[note,setNote]=useState(""),[newChat,setNewChat]=useState(false);
  const[chatFilter,setChatFilter]=useState("all");
  // The vertical menu can shrink to just the logo and account avatars. The
  // choice is remembered per browser; storage can be blocked, so it is optional.
  const[sidebarCollapsed,setSidebarCollapsed]=useState(()=>{try{return window.localStorage.getItem("gakai.sidebar")==="collapsed"}catch{return false}});
  const rememberSidebar=collapsed=>{try{window.localStorage.setItem("gakai.sidebar",collapsed?"collapsed":"expanded")}catch{}};
  // Saved in the browser (instant, no flash on reload) and on the server, so the
  // next login — in any browser — opens the menu the way it was left.
  const toggleSidebar=()=>{const next=!sidebarCollapsed;setSidebarCollapsed(next);rememberSidebar(next);api("/api/app/preferences",{method:"PATCH",body:JSON.stringify({sidebarCollapsed:next})}).catch(()=>{})};
  const[archivedChats,setArchivedChats]=useState([]);
  const[starredMessages,setStarredMessages]=useState([]);
  const settingsRef=useRef(null);
  const chatListRef=useRef(null);
  const suppressAutoSelectRef=useRef(false);
  // A conversation the app opened by itself (the first one, when the page loads) is not one the
  // reader has looked at, so it is not marked read until they click or scroll in it.
  const [autoOpened,setAutoOpened]=useState(false);
  const autoPickedRef=useRef(false);
  const engageChat=useCallback(()=>setAutoOpened(false),[]);
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

  // Screens live at real addresses (/settings, /profile-settings/<name>), so refresh, the
  // back button and shared links all work. navigate() changes the address and the screen together.
  const navigate=useCallback((path,{replace=false}={})=>{history[replace?"replaceState":"pushState"]({},"",path);setRoute(parseRoute(path))},[]);
  useEffect(()=>{const onPop=()=>setRoute(parseRoute(window.location.pathname));window.addEventListener("popstate",onPop);return()=>window.removeEventListener("popstate",onPop)},[]);
  const accountsRef=useRef([]);

  // Mention toasts: raised from the account's live SSE stream when a group
  // message @-tags this account and that chat isn't already open. Kept in a
  // ref-mirrored open-chat id and a seen-event set so the stream handler
  // (which must not re-subscribe on every chat switch) can read current state
  // and never double-toast a replayed/reconnected event.
  const[mentionToasts,setMentionToasts]=useState([]);
  const openChatIdRef=useRef(null);
  const chatsRef=useRef(chats);
  const seenEventIdsRef=useRef(new Set());
  useEffect(()=>{chatsRef.current=chats},[chats]);
  useEffect(()=>{openChatIdRef.current=chat?.id||null},[chat?.id]);
  useEffect(()=>{if(autoPickedRef.current&&chat){autoPickedRef.current=false;setAutoOpened(true)}},[chat]);
  const dismissMentionToast=useCallback(toastId=>setMentionToasts(current=>current.filter(item=>item.id!==toastId)),[]);

  const refresh=useCallback(async()=>{
    // Several call sites (mount, pairing, account delete, SSE-driven polling)
    // can each kick off a /accounts fetch. Only the most recently started one
    // is allowed to apply its result — an older, slower response landing
    // after a newer one must never overwrite it.
    const version=++accountsRequestRef.current;
    try{
      const d=await api("/api/app/accounts"),a=d.accounts||[];
      if(accountsRequestRef.current!==version)return;
      setAccounts(a);setAccount(old=>a.find(x=>x.id===old?.id)||a.find(x=>x.status==="WORKING")||a[0])
      // Only a genuinely successful read may mark accounts "ready" — the
      // auto-pair effect below treats accountsReady+zero accounts as "this
      // is a brand-new workspace" and auto-creates one. A failed fetch (the
      // server briefly unreachable during a restart, say) must never be
      // read as proof the workspace has zero accounts.
      setAccountsReady(true);
    }catch(x){if(accountsRequestRef.current===version)fail(x.message)}
  },[fail]);

  // Avatars are fetched after the list text has painted — in small sequential
  // batches so they fill in progressively rather than the whole list waiting
  // on ~40 WhatsApp profile-picture lookups up front. Guarded by the same
  // request version as load() so a stale account's avatars never land on the
  // current list.
  const hydratePictures=useCallback(async(id,version,list)=>{
    const missing=list.filter(chat=>!chat.picture&&chat.id).map(chat=>chat.id);
    for(let i=0;i<missing.length;i+=10){
      const batch=missing.slice(i,i+10);
      let pictures;
      try{pictures=(await api("/api/app/accounts/"+encodeURIComponent(id)+"/chats/pictures?ids="+encodeURIComponent(batch.join(",")))).pictures||{}}
      catch{return}
      if(chatsRequestRef.current!==version)return;
      if(!Object.keys(pictures).length)continue;
      setChats(current=>{
        const merged=current.map(chat=>pictures[chat.id]?{...chat,picture:pictures[chat.id]}:chat);
        chatsCacheRef.current.set(id,merged);
        return merged;
      });
      setChat(current=>current&&pictures[current.id]?{...current,picture:pictures[current.id]}:current);
    }
  },[]);

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
      // Carry over an avatar we already resolved this session for any row the
      // fresh (picture-less first-paint) response doesn't include one for, so
      // a background refresh never blanks avatars that are already on screen.
      const knownPictures=new Map((chatsCacheRef.current.get(id)||[]).filter(chat=>chat.picture).map(chat=>[chat.id,chat.picture]));
      const next=(Array.isArray(d)?d:d.chats||[])
        .map(chat=>!chat.picture&&knownPictures.get(chat.id)?{...chat,picture:knownPictures.get(chat.id)}:chat)
        .sort(compareChats);
      chatsCacheRef.current.set(id,next);
      setChats(next);
      // A working inbox should open on a useful conversation, not a blank
      // "Select a conversation" placeholder. Keep the reader's existing chat
      // selected during refreshes, otherwise open the newest one.
      setChat(current=>{if(current)return next.find(item=>item.id===current.id);if(suppressAutoSelectRef.current)return undefined;if(next[0])autoPickedRef.current=true;return next[0]});
      hydratePictures(id,version,next);
    }catch(x){if(chatsRequestRef.current===version)fail(x.message)}finally{if(chatsRequestRef.current===version)setChatsLoading(false)}
  },[fail,hydratePictures]);

  const handleAccountRenamed=useCallback((id,label)=>{
    // The page address is built from the name, so a rename moves the address with it.
    const renamed=accountsRef.current.map(item=>item.id===id?{...item,label}:item),current=renamed.find(item=>item.id===id),here=parseRoute(window.location.pathname);
    if(current&&here.view==="profile")navigate(profilePath(accountSlug(current,renamed),here.tab),{replace:true});
    setAccounts(current=>current.map(item=>item.id===id?{...item,label}:item));
    setAccount(current=>current?.id===id?{...current,label}:current);
  },[navigate]);

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
    const update=event=>{
      try{
        const change=JSON.parse(event.data);
        if(change.account?.id!==account.id)return;
        loadRef.current(account.id);
        const eventId=change.id||event.lastEventId;
        // Toast a group @-mention of this account — but only a genuinely new
        // one: skip the burst of recent events every fresh SSE connection
        // replays (deduped by id, backstopped by a freshness window) and skip
        // the chat the reader already has open.
        if(change.type==="message.received"&&change.mentionsYou&&eventId&&!seenEventIdsRef.current.has(eventId)){
          if(seenEventIdsRef.current.size>500)seenEventIdsRef.current.clear();
          seenEventIdsRef.current.add(eventId);
          const fresh=Date.now()-Date.parse(change.occurredAt||0)<60000;
          const knownForToast=chatsRef.current.find(item=>item.id===change.chat?.id);
          if(fresh&&change.chat?.id&&change.chat.id!==openChatIdRef.current&&!knownForToast?.muted){
            const known=knownForToast;
            const toast={id:eventId,chatId:change.chat.id,from:change.message?.sender?.name||"Someone",group:known?.name||change.chat?.name||"a group"};
            setMentionToasts(current=>[...current.filter(item=>item.id!==toast.id),toast]);
            window.setTimeout(()=>setMentionToasts(current=>current.filter(item=>item.id!==toast.id)),6000);
          }
        }
      }catch{}
    };
    // A tab that was hidden holds no connection; catch up on what it missed when it returns.
    const unsubscribe=eventHub.subscribe([account.id],update,()=>loadRef.current(account.id));
    let timer;
    const schedule=()=>{timer=window.setTimeout(()=>{if(!document.hidden)loadRef.current(account.id);schedule()},chatsLengthRef.current?60000:10000)};
    schedule();
    return()=>{unsubscribe();window.clearTimeout(timer)};
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
    const unsubscribers=ids.map(id=>{
      // Only a newly received message can make the dot appear. Everything else on the stream
      // (a read elsewhere, a status change) re-asks the server instead of guessing.
      const update=(_event,change)=>{
        const type=change?.type;
        if(type==="message.received")setAccounts(current=>current.map(item=>item.id===id?{...item,hasUnread:true}:item));
        else if(type==="chat.read")refreshRef.current();
      };
      return eventHub.subscribe([id],update,()=>refreshRef.current());
    });
    // A rare, low-frequency fallback: a read that happens entirely outside
    // Gakai (another linked device) never emits a webhook, so this alone
    // still needs an eventual-consistency check — deliberately infrequent
    // now that turning the dot on (above) and off (see handleChatClick)
    // no longer depend on it for the normal case.
    const timer=window.setInterval(()=>{if(!document.hidden)refreshRef.current()},5*60*1000);
    return()=>{unsubscribers.forEach(unsubscribe=>unsubscribe());window.clearInterval(timer)};
  },[workingAccountsKey]);

  useEffect(()=>{api("/api/app/auth/state").then(setAuth).catch(x=>fail(x.message))},[fail]);
  useEffect(()=>{if(auth?.authenticated)refresh()},[auth,refresh]);
  useEffect(()=>{accountsRef.current=accounts},[accounts]);
  // A profile page resolves its WhatsApp account from the address.
  const profileTarget=route.view==="profile"?findAccountBySlug(accounts,route.slug):null;
  useEffect(()=>{
    if(!accountsReady||route.view!=="profile")return;
    if(!profileTarget){navigate("/settings",{replace:true});fail("That WhatsApp profile doesn't exist.");return}
    if(route.legacy)navigate(profilePath(accountSlug(profileTarget,accounts),route.tab),{replace:true});   // the old /details/<name> address
    else if(account?.id!==profileTarget.id)setAccount(profileTarget);
  },[accountsReady,route,profileTarget,accounts,account?.id,navigate,fail]);
  // Once signed in, the server's saved menu state wins over this browser's.
  useEffect(()=>{
    if(!auth?.authenticated)return undefined;
    let live=true;
    api("/api/app/preferences").then(saved=>{if(live&&typeof saved.sidebarCollapsed==="boolean"){setSidebarCollapsed(saved.sidebarCollapsed);rememberSidebar(saved.sidebarCollapsed)}}).catch(()=>{});
    return()=>{live=false};
  },[auth?.authenticated]);
  useEffect(()=>{suppressAutoSelectRef.current=false;setChat();setChats(chatsCacheRef.current.get(account?.id)||[]);if(account?.status==="WORKING")load(account.id)},[account?.id,account?.status,load]);

  const logout=async()=>{if(!await confirmDialog({title:"Log off?",message:"You'll need your administrator username and password to sign back in.",confirmLabel:"Log off"}))return;await api("/api/app/auth/logout",{method:"POST"}).catch(()=>{});window.location.assign("/")};
  
  const visible=useMemo(()=>{
    const source=chatFilter==="archived"?archivedChats:chats;
    return source.filter(x=>{
      if(chatFilter==="unread"&&!x.unreadCount)return false;
      if(chatFilter==="groups"&&!/@g\.us$/i.test(x.id||""))return false;
      return (String(x.name||x.id)+" "+String(x.lastMessage?.body||x.lastMessage?.text||"")).toLowerCase().includes(q.toLowerCase());
    });
  },[chats,archivedChats,q,chatFilter]);

  // Unread state lives on the server: a conversation is read only when the reader has actually
  // seen its newest message (ChatPanel reports that), never merely because it was opened. Each
  // report names the newest message seen; the server's answer is the authoritative count. Answers
  // can arrive out of order, so only the latest report for a conversation is applied.
  const readVersionRef=useRef(new Map());
  const handleChatClick=useCallback(chatItem=>{
    suppressAutoSelectRef.current=false;
    setAutoOpened(false);
    setChat(chatItem);
  },[]);
  const handleSeen=useCallback(async(chatId,through)=>{
    if(!account)return;
    const version=(readVersionRef.current.get(chatId)||0)+1;
    readVersionRef.current.set(chatId,version);
    try{
      const result=await api("/api/app/accounts/"+encodeURIComponent(account.id)+"/chats/"+encodeURIComponent(chatId)+"/read",{method:"POST",body:JSON.stringify({through})});
      if(readVersionRef.current.get(chatId)!==version)return;
      const unreadCount=Number(result.unreadCount)||0;
      setChats(current=>{
        const next=current.map(c=>c.id===chatId?{...c,unreadCount}:c);
        chatsCacheRef.current.set(account.id,next);
        const stillUnread=next.some(c=>c.unreadCount>0);
        setAccounts(list=>list.map(a=>a.id===account.id?{...a,hasUnread:stillUnread}:a));
        return next;
      });
    }catch(x){fail(x.message||"Could not mark this conversation as read");}
  },[account,fail]);

  // Drop a freshly-opened conversation into the inbox list (deduped) and select
  // it, so a brand-new chat behaves exactly like clicking an existing one.
  const openNewConversation=useCallback((newChatOverview)=>{
    if(!newChatOverview?.id||!account)return;
    setNewChat(false);
    setChats(current=>{
      const next=[newChatOverview,...current.filter(c=>c.id!==newChatOverview.id)].sort(compareChats);
      chatsCacheRef.current.set(account.id,next);
      return next;
    });
    handleChatClick(newChatOverview);
  },[account,handleChatClick]);

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
  const handleForwarded=useCallback((targetChat)=>{
    setNote(`Forwarded to ${targetChat?.name||targetChat?.id||"chat"}`);
    setTimeout(()=>setNote(""),3500);
    if(account)load(account.id);
  },[account?.id, load]);

  // Pin / mute / archive a chat. Optimistically patches both list states, then
  // reconciles from the server's returned overview.
  const chatStateAction=useCallback(async (targetChat,body)=>{
    if(!account||!targetChat?.id)return;
    const patch=chatItem=>chatItem.id===targetChat.id?{...chatItem,
      ...( 'pin' in body?{pinned:body.pin}:{}),
      ...( 'archive' in body?{archived:body.archive}:{}),
      ...( 'mute' in body?{muted:body.mute>0}:{})}:chatItem;
    setChats(current=>{const next=current.map(patch).filter(c=>!c.archived).sort(compareChats);chatsCacheRef.current.set(account.id,next);return next;});
    setArchivedChats(current=>current.map(patch).filter(c=>c.archived));
    try{
      const {chat:updated}=await api("/api/app/accounts/"+encodeURIComponent(account.id)+"/chats/"+encodeURIComponent(targetChat.id)+"/state",{method:"POST",body:JSON.stringify(body)});
      const merge=chatItem=>chatItem.id===updated.id?{...chatItem,...updated}:chatItem;
      setChats(current=>{const next=current.map(merge).filter(c=>!c.archived).sort(compareChats);chatsCacheRef.current.set(account.id,next);return next;});
      setArchivedChats(current=>{const has=current.some(c=>c.id===updated.id);const merged=has?current.map(merge):[updated,...current];return merged.filter(c=>c.archived);});
      if(account)load(account.id);
    }catch(x){fail(x.message||"Could not update this conversation");if(account)load(account.id);}
  },[account,fail,load]);

  const blockAction=useCallback(async (targetChat,blocked)=>{
    if(!account||!targetChat?.id)return;
    try{
      await api("/api/app/accounts/"+encodeURIComponent(account.id)+"/chats/"+encodeURIComponent(targetChat.id)+"/block",{method:"POST",body:JSON.stringify({blocked})});
      const patch=c=>c.id===targetChat.id?{...c,blocked}:c;
      setChats(current=>{const next=current.map(patch);chatsCacheRef.current.set(account.id,next);return next;});
      setChat(current=>current?.id===targetChat.id?{...current,blocked}:current);
      setNote(blocked?"Contact blocked":"Contact unblocked");setTimeout(()=>setNote(""),3000);
    }catch(x){fail(x.message||"Could not update block status");}
  },[account,fail]);
  const disappearingAction=useCallback(async (targetChat,seconds)=>{
    if(!account||!targetChat?.id)return;
    try{
      const {chat:updated}=await api("/api/app/accounts/"+encodeURIComponent(account.id)+"/chats/"+encodeURIComponent(targetChat.id)+"/disappearing",{method:"POST",body:JSON.stringify({seconds})});
      const patch=c=>c.id===updated.id?{...c,...updated}:c;
      setChats(current=>{const next=current.map(patch);chatsCacheRef.current.set(account.id,next);return next;});
      setChat(current=>current?.id===updated.id?{...current,...updated}:current);
    }catch(x){fail(x.message||"Could not update disappearing messages");}
  },[account,fail]);

  // Turn the AI on or off for one conversation (it joins or leaves the AI
  // reply list). Optimistic, then reconciled with what the server stored.
  const aiToggleAction=useCallback(async targetChat=>{
    if(!account||!targetChat?.id)return;
    const enabled=!targetChat.aiReply,label=targetChat.name||targetChat.id;
    const patch=extra=>c=>c.id===targetChat.id?{...c,...extra}:c;
    const apply=extra=>{
      setChats(current=>{const next=current.map(patch(extra));chatsCacheRef.current.set(account.id,next);return next});
      setChat(current=>current?.id===targetChat.id?{...current,...extra}:current);
    };
    apply({aiReply:enabled});
    try{
      const {chat:updated}=await api("/api/app/accounts/"+encodeURIComponent(account.id)+"/chats/"+encodeURIComponent(targetChat.id)+"/ai",{method:"POST",body:JSON.stringify({enabled})});
      apply({aiReply:updated.aiReply,aiActive:updated.aiActive});
      setNote(enabled?(updated.aiActive?`AI replies on for ${label}`:`${label} added to the AI reply list — turn on AI replies in Settings to start`):`AI replies off for ${label}`);
      setTimeout(()=>setNote(""),4500);
    }catch(x){apply({aiReply:!enabled});fail(x.message||"Could not update AI replies for this conversation");}
  },[account,fail]);

  // Load the archived list only while that tab is active.
  useEffect(()=>{
    if(chatFilter!=="archived"||!account||account.status!=="WORKING"){return undefined;}
    let active=true;
    api("/api/app/accounts/"+encodeURIComponent(account.id)+"/chats?archived=1")
      .then(rows=>{if(active)setArchivedChats(Array.isArray(rows)?rows:(rows.chats||[]))})
      .catch(()=>{if(active)setArchivedChats([])});
    return()=>{active=false};
  },[chatFilter,account?.id,account?.status]);

  // Load starred messages only while that tab is active.
  useEffect(()=>{
    if(chatFilter!=="starred"||!account||account.status!=="WORKING"){return undefined;}
    let active=true;
    api("/api/app/accounts/"+encodeURIComponent(account.id)+"/starred")
      .then(data=>{if(active)setStarredMessages(Array.isArray(data.messages)?data.messages:[])})
      .catch(()=>{if(active)setStarredMessages([])});
    return()=>{active=false};
  },[chatFilter,account?.id,account?.status]);
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
    fail("Conversation deleted");
  },[account,fail]);

  // Same delete the open conversation's menu offers, available from the list.
  const deleteChatAction=useCallback(async targetChat=>{
    if(!account||!targetChat?.id)return;
    const confirmed=await confirmDialog({title:"Delete conversation?",message:`The conversation with ${targetChat.name||targetChat.id} will be deleted from WhatsApp on your phone and every linked app. This can't be undone.`,confirmLabel:"Delete conversation",danger:true});
    if(!confirmed)return;
    try{
      await api("/api/app/accounts/"+encodeURIComponent(account.id)+"/chats/"+encodeURIComponent(targetChat.id),{method:"DELETE"});
      handleChatDeleted(targetChat.id);
    }catch(x){fail(x.message||"Could not delete this conversation");}
  },[account,fail,handleChatDeleted]);

  if(!auth)return <main className="pairing">Loading Gakai…</main>;
  if(!auth.authenticated)return <Login setup={!!auth.setup} done={()=>location.reload()} fail={fail}/>;
  if(!accountsReady)return <main className="pairing">Loading your workspace…</main>;
  if(pair)return <Pairing account={pair} onCancel={cancelPairing} onLinked={x=>{setPair();setPairCreated(false);setAccount(x);refresh()}}/>;
  if((add||!accounts.length)&&!pair)return <main className="pairing"><section className="pair-card"><span className="eyebrow">CONNECT WHATSAPP</span><h1>Preparing your QR code…</h1><p>Gakai is creating a secure WhatsApp connection. The QR code will appear here automatically.</p><div className="qr loading" role="status">Starting WhatsApp…</div>{accounts.length?<button className="nav wide" onClick={()=>setAdd(false)}>Cancel</button>:null}</section></main>;
  const mentionToastStack=mentionToasts.length>0&&<div className="mention-toasts">
    {mentionToasts.map(toast=><div key={toast.id} className="mention-toast" role="status">
      <button type="button" onClick={()=>{const target=chats.find(item=>item.id===toast.chatId);if(target)handleChatClick(target);dismissMentionToast(toast.id)}}>
        <b>{toast.from}</b> mentioned you in <b>{toast.group}</b>
      </button>
      <button type="button" className="mention-toast-dismiss" aria-label="Dismiss" onClick={()=>dismissMentionToast(toast.id)}>×</button>
    </div>)}
  </div>;
  const closeSettings=()=>navigate("/");
  const openAccountSettings=x=>{setAccount(x);navigate(profilePath(accountSlug(x,accounts)))};
  const accountDeleted=async()=>{navigate("/",{replace:true});setChat();await refresh()};
  const toasts=<>{note?<div className="toast" role="status">{note}</div>:null}{mentionToastStack}</>;
  if(route.view==="settings")return <><WorkspaceSettings accounts={accounts} onClose={closeSettings} onManage={openAccountSettings} onAddAccount={beginPairing} onNotice={fail}/>{toasts}</>;
  if(route.view==="profile"&&profileTarget)return <><Settings account={profileTarget} tab={route.tab} onTab={tab=>navigate(profilePath(accountSlug(profileTarget,accounts),tab),{replace:true})} onAllSettings={()=>navigate("/settings")} onReconnect={x=>{setPairCreated(false);setPair(x)}} onClose={closeSettings} onDeleted={accountDeleted} onNotice={fail} onRenamed={handleAccountRenamed}/>{toasts}</>;
  if(route.view==="profile")return <main className="pairing">Opening profile…</main>;

  return (
    <>
      <div className={"app"+(sidebarCollapsed?" sidebar-collapsed":"")}>
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="logo" {...(sidebarCollapsed?{role:"button",tabIndex:0,title:"Expand menu","aria-label":"Expand menu","aria-expanded":false,onClick:toggleSidebar,onKeyDown:event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();toggleSidebar()}}}:{})}><picture><source media="(max-width:720px)" srcSet="/logo-mark.png?v=4"/><img className="logo-mark" src={sidebarCollapsed?"/logo-mark.png?v=4":"/logo.png?v=4"} alt="Gakai" draggable="false"/></picture></div>
            {!sidebarCollapsed&&<button type="button" className="sidebar-toggle" onClick={toggleSidebar} aria-expanded="true" aria-label="Collapse menu" title="Collapse menu">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6"/></svg>
            </button>}
          </div>
          <div className="account-switch">
            <h3 className="sidebar-title">WhatsApp accounts</h3>
            {accounts.map(x=>sidebarCollapsed
              ? <button type="button" key={x.id} className={"account-mini"+(x.id===account?.id?" selected":"")} title={x.label+" — account settings"} aria-label={"Open settings for "+x.label} onClick={()=>openAccountSettings(x)}>
                  <span className="mini-avatar"><Avatar item={x}/>{x.hasUnread?<i className="good" aria-hidden="true"/>:null}</span>
                  <small>{x.label}</small>
                </button>
              : <div className="account-row" key={x.id}>
                  <button className={"account "+(x.id===account?.id?"selected":"")} onClick={()=>setAccount(x)}>
                    <i className={x.hasUnread?"good":""}/>
                    <Avatar item={x}/>
                    <span><b>{x.label}</b><small>{status(x.status)}</small></span>
                  </button>
                  <button type="button" className="account-cog" title="Account details" aria-label={"Open settings for "+x.label} onClick={()=>openAccountSettings(x)}>⚙</button>
                </div>)}
            {/* Mobile account switcher dropdown */}
            {accounts.length>1 && <select className="mobile-account-switcher" value={account?.id||""} onChange={e=>{const id=e.target.value; if(id) setAccount(accounts.find(a=>a.id===id))}} aria-label="Switch WhatsApp account">
              {accounts.map(a=><option key={a.id} value={a.id}>{a.label} {a.status==="WORKING"?"✓":""}</option>)}
            </select>}
          </div>
          <button type="button" className="logout subtle-btn" onClick={logout} title="Log off" aria-label="Log off"><IconLogout/><span className="logout-label"> Log off</span></button>
        </aside>
        <main className="main">
          <header>
            <div><h2>Inbox</h2><small>{account?.label} · {status(account?.status)}</small></div>
            <div className="header-actions">
              {account?.status==="WORKING"&&<button type="button" className="subtle-btn" onClick={()=>setNewChat(true)}>+ New chat</button>}
              <button type="button" className="subtle-btn settings-gear" onClick={()=>navigate("/settings")} aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
            </div>
          </header>
          {account?.status!=="WORKING"?<div className="empty"><div><h1>Account needs attention</h1><p>Reconnect this account to continue.</p><button className="primary" onClick={()=>{setPairCreated(false);setPair(account)}}>Reconnect with QR code</button></div></div>:<div className="inbox">
            <section className={"chats "+(chat?"mobile-hide":"")} ref={chatListRef}>
              <input placeholder="Search conversations" value={q} onChange={e=>setQ(e.target.value)} aria-label="Search conversations"/>
              <div className="chat-filters" role="tablist" aria-label="Filter conversations">
                {[["all","All"],["unread","Unread"],["groups","Groups"],["archived","Archived"],["starred","Starred"]].map(([key,label])=>
                  <button key={key} type="button" role="tab" aria-selected={chatFilter===key} className={"chat-filter"+(chatFilter===key?" on":"")} onClick={()=>setChatFilter(key)}>{label}</button>
                )}
              </div>
              {chatFilter==="starred"
                ? (starredMessages.length
                    ? starredMessages.map((m,i)=><button key={(m.id||i)+"-star"} className="chat starred-item" onClick={()=>{const target=chats.find(c=>c.id===m.chatId)||archivedChats.find(c=>c.id===m.chatId)||{id:m.chatId,name:m.chatId};handleChatClick(target)}}>
                        <span className="starred-item-icon" aria-hidden="true">★</span>
                        <span><b>{m.sender?.name||(m.fromMe?"You":m.chatId)}</b><small>{m.body||m.text||(m.hasMedia?"Media attachment":m.location?"📍 Location":m.poll?"📊 Poll":"Message")}</small></span>
                      </button>)
                    : <p className="hint">No starred messages.</p>)
                : visible.map(x=><div key={x.id} className="chat-row">
                <button className={"chat "+(x.id===chat?.id?"active":"")+(x.unreadCount?" has-unread":"")} onClick={()=>handleChatClick(x)}>
                  <Avatar item={x}/>
                  <span><b>{x.pinned?"📌 ":""}{x.name||x.id}</b><small>{x.lastMessage?.body||x.lastMessage?.text||x.lastMessage?.system?.label||"Photo or message"}</small></span>
                  {x.muted?<span className="chat-muted" title="Muted" aria-hidden="true">🔇</span>:null}
                  {x.unreadCount?<span className="unread-pill">{x.unreadCount}</span>:null}
                </button>
                <Menu label={"Actions for "+(x.name||x.id)} className="chat-row-menu">
                  <MenuItem toggled={!!x.aiReply} onSelect={()=>aiToggleAction(x)}>AI replies - {x.aiReply?"On":"Off"}</MenuItem>
                  <MenuItem onSelect={()=>chatStateAction(x,{pin:!x.pinned})}>{x.pinned?"Unpin":"Pin"} chat</MenuItem>
                  {x.muted
                    ? <MenuItem onSelect={()=>chatStateAction(x,{mute:0})}>Unmute</MenuItem>
                    : <>
                        <MenuItem onSelect={()=>chatStateAction(x,{mute:60*60*8})}>Mute 8 hours</MenuItem>
                        <MenuItem onSelect={()=>chatStateAction(x,{mute:60*60*24*7})}>Mute 1 week</MenuItem>
                        <MenuItem onSelect={()=>chatStateAction(x,{mute:60*60*24*365})}>Mute always</MenuItem>
                      </>}
                  <MenuItem onSelect={()=>chatStateAction(x,{archive:!x.archived})}>{x.archived?"Unarchive":"Archive"}</MenuItem>
                  <MenuItem danger onSelect={()=>deleteChatAction(x)}>Delete conversation</MenuItem>
                </Menu>
              </div>)}
              {chatsLoading&&!chats.length?<p className="hint loading-hint" role="status"><span className="spinner" aria-hidden="true"/>Loading conversations from WhatsApp…</p>:!visible.length?<p className="hint">{chatFilter==="archived"?"No archived conversations.":chats.length?"No conversations match this filter.":"No conversations yet. Gakai is waiting for WhatsApp to finish syncing."}</p>:null}
            </section>
            <section className={"conversation "+(!chat?"mobile-hide":"")}>{chat?<ChatPanel key={account.id+"/"+chat.id} accountId={account.id} accountLabel={account.label} accountPicture={account.picture} chat={chat} chats={chats} onSeen={handleSeen} seenHeld={autoOpened} onEngage={engageChat} onBack={()=>setChat()} onSent={handleSent} onForwarded={handleForwarded} onChatState={chatStateAction} onBlock={blockAction} onDisappearing={disappearingAction} onDeleted={handleChatDeleted} onAiToggle={aiToggleAction}/>:<div className="blank">Select a conversation</div>}</section>
          </div>}
        </main>
      </div>
      {newChat&&account?<NewChatDialog accountId={account.id} onClose={()=>setNewChat(false)} onOpened={openNewConversation}/>:null}
      {note?<div className="toast" role="status">{note}</div>:null}
      {mentionToastStack}
    </>
  )
}
createRoot(document.querySelector("#app")).render(<><App/><ConfirmHost/></>);
