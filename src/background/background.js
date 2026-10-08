/* Background: install defaults + optional BYO-LLM relay.
 * No network unless the user enabled their own AI endpoint in Settings.
 * The relay exists so content scripts don't fight page CSP/mixed-content rules:
 * the fetch runs with the extension principal (needs the optional host permission
 * the browser grants when the user enables the feature).
 */
const DEFAULTS = {
  settings: {
    autoFill: true,
    learnFromEdits: true,
    fillGenerative: true,
    useLLM: false,
    llmUrl: "",
    llmModel: "",
    llmKey: "",
    disabledSites: []
  }
};

const api = globalThis.browser ?? globalThis.chrome;
api?.runtime?.onInstalled?.addListener(async () => {
  try {
    const cur = await api.storage.local.get(["settings"]);
    if (!cur.settings) await api.storage.local.set(DEFAULTS);
    else {
      // Merge new defaults without clobbering user choices (forward migration).
      const merged = {...DEFAULTS.settings, ...cur.settings};
      if (JSON.stringify(merged) !== JSON.stringify(cur.settings)) {
        await api.storage.local.set({settings: merged});
      }
    }
  } catch (e) { console.warn("[autofill-bg]", e); }
});

api?.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "LLM_CHAT") {
    (async () => {
      try {
          const {settings} = await api.storage.local.get("settings");
          if (!settings?.useLLM || !settings.llmUrl) return sendResponse({text: null});
          let base = settings.llmUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
          const endpoint = /\/v1$/i.test(base)
              ? base + "/chat/completions"
              : base + "/v1/chat/completions";
        const headers = {"Content-Type": "application/json"};
        if (settings.llmKey) headers.Authorization = "Bearer " + settings.llmKey;
        // OpenRouter (openrouter.ai) is OpenAI-compatible; these optional headers are
        // recommended by OpenRouter for identification and are harmless elsewhere.
        headers["X-Title"] = "Resume Autofill";
        try {
          const extUrl = api?.runtime?.getURL?.("/");
          if (extUrl) headers["HTTP-Referer"] = extUrl;
        } catch {
        }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 25000);
        try {
          const res = await fetch(endpoint, {
            method: "POST", headers, signal: ctrl.signal,
            body: JSON.stringify({
              model: settings.llmModel?.trim() || "llama3.1",
              messages: msg.messages, max_tokens: msg.maxTokens || 400, temperature: 0.4
            })
          });
          if (!res.ok) return sendResponse({text: null});
          const data = await res.json();
          sendResponse({text: data?.choices?.[0]?.message?.content?.trim()?.slice(0, 3000) || null});
        } finally {
          clearTimeout(t);
        }
      } catch {
        try {
          sendResponse({text: null});
        } catch {
        }
      }
    })();
    return true; // async response
  }
});
