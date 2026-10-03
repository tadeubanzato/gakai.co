import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./app-helpers.mjs";

// Provider, credentials and model picker for the AI Responses service. There
// is no "load" or "save" button: the model list is fetched live from the
// provider (or the user's LiteLLM proxy) shortly after the URL, key or provider
// changes, and the settings save themselves once a usable model is chosen.
const PROVIDERS = [
  { id: "litellm", label: "LiteLLM", keyLabel: "LiteLLM API key", keyHint: "Paste your LiteLLM key (sk-…)" },
  { id: "claude", label: "Claude", keyLabel: "Claude API key", keyHint: "Paste your Anthropic key (sk-ant-…)" },
  { id: "chatgpt", label: "ChatGPT", keyLabel: "OpenAI API key", keyHint: "Paste your OpenAI key (sk-…)" },
];
const FIXED_URLS = { chatgpt: "https://api.openai.com/v1", claude: "https://api.anthropic.com/v1" };
const TYPING_DELAY_MS = 700;
// Configs saved before providers existed may say "omniroute"; it is the same
// OpenAI-compatible proxy shape as LiteLLM.
const providerOf = value => (value === "claude" || value === "chatgpt" ? value : "litellm");
const trimUrl = value => String(value || "").trim().replace(/\/+$/, "");

// `onCommit` asks the parent form to save itself; it is called only after the
// selected model is rendered into the form, so the form reads the final values.
export function AiProviderFields({ llm, base, busy, onCommit }) {
  const saved = llm?.configured ? { provider: providerOf(llm.provider), baseUrl: trimUrl(llm.baseUrl), model: llm.model || "" } : null;
  const [provider, setProvider] = useState(saved?.provider || "litellm");
  const [baseUrl, setBaseUrl] = useState(saved?.provider === "litellm" || !saved ? saved?.baseUrl || "" : "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(saved?.model || "");
  const [models, setModels] = useState({ status: "idle", list: [], error: "" });
  const [commitTick, setCommitTick] = useState(0);
  const latest = useRef(0);
  const edited = useRef(false);        // the user changed URL/key/provider (not just opened the panel)
  const modelRef = useRef(model);
  modelRef.current = model;

  const meta = PROVIDERS.find(item => item.id === provider);
  const isProxy = provider === "litellm";
  // The saved key may be reused only for the provider (and proxy URL) it was saved for.
  const canKeep = !!saved && saved.provider === provider && (!isProxy || saved.baseUrl === trimUrl(baseUrl));
  const keyForRequest = apiKey.trim() || (canKeep ? "__keep__" : "");
  const ready = !!keyForRequest && (!isProxy || !!baseUrl.trim());
  const dirty = !saved || saved.provider !== provider || (isProxy && saved.baseUrl !== trimUrl(baseUrl)) || saved.model !== model || !!apiKey.trim();

  const loadModels = useCallback(async ({ commitAfter = false } = {}) => {
    const ticket = ++latest.current;
    setModels(current => ({ ...current, status: "loading", error: "" }));
    try {
      const result = await api(base + "/llm/models", { method: "POST", body: JSON.stringify({ provider, baseUrl: isProxy ? baseUrl.trim() : "", apiKey: keyForRequest }) });
      if (ticket !== latest.current) return;
      const list = result.models || [];
      setModels({ status: "ok", list, error: "" });
      if (modelRef.current && !list.includes(modelRef.current)) setModel("");   // chosen model isn't offered by this key
      else if (commitAfter && modelRef.current) setCommitTick(tick => tick + 1);
    } catch (error) {
      if (ticket !== latest.current) return;
      setModels({ status: "error", list: [], error: error.message });
    }
  }, [base, provider, isProxy, baseUrl, keyForRequest]);

  // Opening the panel with a saved key: show the models available to it.
  useEffect(() => {
    if (canKeep) loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After the user edits the provider, URL or key, wait for a pause in typing,
  // then refresh the model list (and save if the current model is still valid).
  useEffect(() => {
    if (!edited.current) return undefined;
    if (!ready) { latest.current++; setModels({ status: "idle", list: [], error: "" }); return undefined; }
    const timer = setTimeout(() => loadModels({ commitAfter: true }), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, baseUrl, apiKey]);

  // Save once React has put the chosen model into the form.
  useEffect(() => {
    if (commitTick && model && dirty) onCommit?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitTick]);

  const chooseProvider = next => {
    edited.current = true;
    latest.current++;
    setProvider(next);
    setApiKey("");
    setModels({ status: "idle", list: [], error: "" });
    setModel(saved?.provider === next ? saved.model : "");
    setBaseUrl(next === "litellm" ? (saved?.provider === "litellm" ? saved.baseUrl : "") : "");
  };
  const chooseModel = id => { setModel(id); if (id) setCommitTick(tick => tick + 1); };

  const options = [...new Set([model, ...models.list].filter(Boolean))];
  const loading = models.status === "loading";
  const placeholder = loading ? "Loading models…" : options.length ? "Select a model" : ready ? "No models available" : "Enter your key to see models";

  return <>
    <label>Provider
      <select name="provider" value={provider} onChange={event => chooseProvider(event.currentTarget.value)} disabled={busy}>
        {PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    {isProxy
      ? <label>LiteLLM URL<input name="baseUrl" type="url" value={baseUrl} onChange={event => { edited.current = true; setBaseUrl(event.currentTarget.value); }} placeholder="https://litellm.example.com" required/></label>
      : <input type="hidden" name="baseUrl" value={FIXED_URLS[provider]}/>}
    <label>{meta.keyLabel}
      <input name="apiKey" type="password" value={apiKey} onChange={event => { edited.current = true; setApiKey(event.currentTarget.value); }} placeholder={canKeep ? "Paste a replacement key" : meta.keyHint} autoComplete="off" required={!canKeep}/>
      {canKeep && <small className="saved-key-mask">Saved key: ••••…••{llm.apiKeyLast4}</small>}
    </label>
    <label>Model
      <select name="model" value={model} onChange={event => chooseModel(event.currentTarget.value)} disabled={busy || loading || !options.length} required>
        <option value="">{placeholder}</option>
        {options.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
      {models.status === "ok" && <small className="model-status">{models.list.length} model{models.list.length === 1 ? "" : "s"} available from {meta.label}</small>}
      {models.status === "error" && <small className="model-status model-status-error" role="alert">{models.error}</small>}
    </label>
  </>;
}
