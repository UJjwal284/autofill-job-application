/* Background: first-install defaults only. Fully local, no network calls. */
const DEFAULTS = {
  settings: { autoFill: true, learnFromEdits: true }
};

const api = globalThis.browser ?? globalThis.chrome;
api?.runtime?.onInstalled?.addListener(async () => {
  try {
    const cur = await api.storage.local.get(["settings"]);
    if (!cur.settings) await api.storage.local.set(DEFAULTS);
    // Drop legacy LLM keys if present from older versions.
    if (cur.settings && ("useLLM" in cur.settings || "apiKey" in cur.settings || "providerUrl" in cur.settings)) {
      const { useLLM, apiKey, providerUrl, model, ...rest } = cur.settings;
      await api.storage.local.set({ settings: { ...DEFAULTS.settings, ...rest } });
    }
  } catch (e) { console.warn("[autofill-bg]", e); }
});
