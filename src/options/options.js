/* Options page: persistent, so file picker does NOT close it (unlike popup). */
const extApi = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);
console.log("[autofill] options loaded, extApi:", !!extApi, "pdf:", !!globalThis.pdfjsLib?.getDocument);

window.addEventListener("error", (e) => {
  try {
    const el = document.getElementById("resumeStatus");
    if (el) el.textContent = "Script error: " + (e.message || e.error);
  } catch {}
});

if (!extApi?.storage?.local) {
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("resumeStatus");
    if (el) el.textContent = "Error: extension API missing. Open this page via the toolbar icon → Upload (moz-extension://), not as a file.";
  });
}

if (globalThis.pdfjsLib?.GlobalWorkerOptions) {
  try {
    const w = extApi?.runtime?.getURL ? extApi.runtime.getURL("src/lib/vendor/pdf.worker.js") : "../lib/vendor/pdf.worker.js";
    globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = w;
  } catch {}
}

function store() {
  const s = extApi?.storage?.local;
  if (!s) throw new Error("storage.local unavailable (page opened as file? open via toolbar → Upload).");
  return s;
}
// Every storage op gets a timeout. A hung promise must fail loud, never freeze on "Loading…"/"Parsing…".
function withStoreTimeout(promise, ms, op) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`storage.local.${op} hung >${ms / 1000}s. The background page may have crashed. Reload the extension in about:debugging.`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
const storeSet = (items) => withStoreTimeout(store().set(items), 10000, "set");
const storeGet = (keys) => withStoreTimeout(store().get(keys), 10000, "get");
const storeRemove = (keys) => withStoreTimeout(store().remove(keys), 10000, "remove");

const normalize = (h) => {
    try {
        return globalThis.ResumeAutofill?.normalizeDomain ? globalThis.ResumeAutofill.normalizeDomain(h) : String(h || "").toLowerCase().replace(/^www\./, "").trim();
    } catch {
        return "";
    }
};

async function refreshAll() {
  // Self-test storage first so failures are visible instead of silent empty fields.
  await storeSet({ __ping: Date.now() });
  const ping = await storeGet("__ping");
  if (!ping || ping.__ping === undefined) throw new Error("storage.local set/get failed (private window? addon removed instead of Reloaded? page opened as file?).");
  await storeRemove("__ping").catch(() => {});
  const { settings, profile, learned } = await storeGet(["settings", "profile", "learned"]);
  const s = settings || {};
  // Guarded: old cached HTML may lack new IDs. Never let one missing node kill the whole page.
  if ($("autoFill")) $("autoFill").checked = s.autoFill !== false;
  if ($("learnFromEdits")) $("learnFromEdits").checked = s.learnFromEdits !== false;
    if ($("fillGenerative")) $("fillGenerative").checked = s.fillGenerative !== false;
    if ($("useLLM")) $("useLLM").checked = s.useLLM === true;
    if ($("llmUrl")) $("llmUrl").value = s.llmUrl || "";
    if ($("llmModel")) $("llmModel").value = s.llmModel || "";
    if ($("llmKey")) $("llmKey").value = s.llmKey || "";
  renderLearned(learned || {});
    renderDisabled(s.disabledSites || []);
  const pdfOk = !!globalThis.pdfjsLib?.getDocument, mOk = !!globalThis.mammoth?.extractRawText;
  const pOk = !!globalThis.ResumeAutofill?.parseResumeText;
  const engines = `Engines: PDF ${pdfOk ? "OK" : "MISSING"} | DOCX ${mOk ? "OK" : "MISSING"} | Profile ${pOk ? "OK" : "MISSING"}`;
  $("resumeStatus").textContent = profile
    ? `Saved: ${profile.personal.fullName || "unnamed"} | ${profile.personal.email || "no email"}\nUpdated: ${profile.updatedAt}\n${engines}`
    : `No resume saved yet.\n${engines}${(!pdfOk || !mOk || !pOk) ? ". If anything is MISSING, reload the extension." : ""}`;
}

const resumeFileEl = $("resumeFile");
if (resumeFileEl) resumeFileEl.addEventListener("change", () => {
  const f = resumeFileEl.files[0];
  if ($("fileInfo")) $("fileInfo").textContent = f ? `Selected: ${f.name} (${(f.size / 1024).toFixed(1)} KB). Click Save resume.` : "";
});

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + " timed out after " + (ms / 1000) + "s")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function readPdf(buf, onProgress) {
  if (!globalThis.pdfjsLib?.getDocument) throw new Error("PDF engine not loaded. Reload extension in about:debugging.");
  const data = new Uint8Array(buf);
  // No-worker FIRST: workers often hang inside extensions (CSP). Slower but reliable.
  const attempts = [
    { data, disableWorker: true, isEvalSupported: false },
    { data }
  ];
  let lastErr = null;
  for (const opts of attempts) {
    try {
      const pdf = await withTimeout(globalThis.pdfjsLib.getDocument(opts).promise, 20000, "PDF load");
      let out = "";
      const n = Math.min(pdf.numPages, 5);
      for (let i = 1; i <= n; i++) {
        onProgress?.(`Reading ${i}/${n} pages...`);
        // Let UI repaint between pages.
        await new Promise(r => setTimeout(r, 0));
        const page = await withTimeout(pdf.getPage(i), 15000, "PDF page " + i);
        const tc = await withTimeout(page.getTextContent(), 15000, "PDF text " + i);
        out += tc.items.map(it => it.str).join(" ") + "\n";
      }
      await pdf.destroy().catch(() => {});
      return out;
    } catch (e) { console.warn("[autofill] PDF attempt failed:", e); lastErr = e; }
  }
  throw lastErr || new Error("unknown PDF error");
}

async function readResumeFile(file) {
  const name = (file.name || "").toLowerCase();
  $("resumeStatus").textContent = `Reading ${file.name}...`;
  await new Promise(r => setTimeout(r, 30)); // paint status before blocking work
  if (name.endsWith(".pdf")) {
    const buf = await file.arrayBuffer();
    const text = await readPdf(buf, (p) => { $("resumeStatus").textContent = `Reading ${file.name}... ${p}`; });
    if (text.trim().length < 30) throw new Error("PDF has no selectable text (scanned image?). Use paste fallback below.");
    return text;
  }
  if (name.endsWith(".docx")) {
    if (!globalThis.mammoth) throw new Error("DOCX reader missing. Paste text instead.");
    const r = await globalThis.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    if ((r.value || "").trim().length < 30) throw new Error("DOCX empty. Paste text instead.");
    return r.value;
  }
  return await file.text();
}

function parseProfile(text) {
  // Single source of truth: shared parser in src/lib/profile.js (also used by content.js).
  if (!globalThis.ResumeAutofill?.parseResumeText) {
    throw new Error("Profile engine not loaded. Reload the extension in about:debugging.");
  }
  return globalThis.ResumeAutofill.parseResumeText(text);
}

const saveResumeBtn = $("saveResume");
if (saveResumeBtn) saveResumeBtn.onclick = async () => {
  console.log("[autofill] saveResume clicked");
  try {
    let text = $("resumePaste").value.trim();
    const f = $("resumeFile").files[0];
    console.log("[autofill] paste len:", text.length, "file:", f?.name, f?.size);
    if (f) text = await readResumeFile(f);
    if (!text || text.length < 30) { $("resumeStatus").textContent = "Choose a file or paste text first."; return; }
    $("resumeStatus").textContent = `Parsing ${text.length} chars...`;
    await new Promise(r => setTimeout(r, 30));
    const t0 = Date.now();
    const profile = parseProfile(text);
    const { personal } = profile;
    console.log("[autofill] parsed in", Date.now() - t0, "ms");
    $("resumeStatus").textContent = `Parsed ✓ (${Date.now() - t0}ms), saving...`;
    await storeSet({ profile });
    $("resumeStatus").textContent = `Saved (${text.length} chars): ${personal.fullName || "resume"} | ${personal.email || "no email found"}\nNow open any job form. It fills itself.`;
  } catch (e) { console.error(e); $("resumeStatus").textContent = "Error: " + (e?.message || e); }
};

function renderLearned(learned) {
  const entries = Object.entries(learned || {}).sort((a, b) => (b[1].updatedAt || "").localeCompare(a[1].updatedAt || ""));
  if ($("learnedCount")) $("learnedCount").textContent = String(entries.length);
  const list = $("learnedList");
  if (!list) return;
  if (!entries.length) { list.textContent = "Nothing learned yet. Correct any autofilled field on a job form and it appears here."; return; }
  list.innerHTML = "";
  for (const [, v] of entries.slice(0, 50)) {
    const div = document.createElement("div");
    div.style.cssText = "background:#fff;border:1px solid #ddd;border-radius:6px;padding:6px 8px;margin:4px 0";
    div.textContent = `${v.domain} | "${v.label}": ${(v.value || "").slice(0, 80)} (${v.count}x)`;
    list.appendChild(div);
  }
}

function renderDisabled(disabledSites) {
    const list = (disabledSites || []).map(normalize).filter(Boolean);
    const uniq = [...new Set(list)].sort();
    if ($("disabledCount")) $("disabledCount").textContent = String(uniq.length);
    const box = $("disabledList");
    if (!box) return;
    if (!uniq.length) {
        box.textContent = "Not disabled anywhere.";
        return;
    }
    box.innerHTML = "";
    for (const d of uniq.slice(0, 100)) {
        const div = document.createElement("div");
        div.style.cssText = "background:#fff;border:1px solid #ddd;border-radius:6px;padding:6px 8px;margin:4px 0;display:flex;gap:8px;align-items:center;justify-content:space-between";
        const span = document.createElement("span");
        span.textContent = d;
        span.style.wordBreak = "break-all";
        const btn = document.createElement("button");
        btn.textContent = "Enable";
        btn.style.cssText = "margin:0;padding:4px 10px";
        btn.onclick = async () => {
            try {
                const cur = (await storeGet("settings"))?.settings || {};
                cur.disabledSites = (cur.disabledSites || []).map(normalize).filter(x => x && x !== d);
                await storeSet({settings: cur});
                renderDisabled(cur.disabledSites);
                if ($("status")) $("status").textContent = `Enabled on ${d}.`;
            } catch (e) {
                if ($("status")) $("status").textContent = "Remove failed: " + (e?.message || e);
            }
        };
        div.appendChild(span);
        div.appendChild(btn);
        box.appendChild(div);
    }
}

async function addDisabled(raw) {
    const d = normalize(raw);
    if (!d) {
        if ($("status")) $("status").textContent = "Enter a domain like example.com.";
        return;
    }
    try {
        const cur = (await storeGet("settings"))?.settings || {};
        const set = new Set((cur.disabledSites || []).map(normalize).filter(Boolean));
        set.add(d);
        cur.disabledSites = [...set].sort();
        await storeSet({settings: cur});
        renderDisabled(cur.disabledSites);
        if ($("disabledInput")) $("disabledInput").value = "";
        if ($("status")) $("status").textContent = `Disabled on ${d}. Autofill will skip it.`;
    } catch (e) {
        if ($("status")) $("status").textContent = "Add failed: " + (e?.message || e);
    }
}

const addDisabledBtn = $("addDisabled");
if (addDisabledBtn) addDisabledBtn.onclick = () => addDisabled($("disabledInput")?.value);
const disabledInputEl = $("disabledInput");
if (disabledInputEl) disabledInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        addDisabled(disabledInputEl.value);
    }
});

const clearBtn = $("clearLearned");
if (clearBtn) clearBtn.onclick = async () => {
  try { await storeSet({ learned: {} }); renderLearned({}); if ($("resumeStatus")) $("resumeStatus").textContent = "Forgot all learned corrections."; }
  catch (e) { if ($("resumeStatus")) $("resumeStatus").textContent = "Clear failed: " + (e?.message || e); }
};

const saveBtn = $("save");
if (saveBtn) saveBtn.onclick = async () => {
  try {
      const prev = (await storeGet("settings"))?.settings || {};
    const payload = { settings: {
            ...prev,
            autoFill: $("autoFill")?.checked !== false,
            learnFromEdits: $("learnFromEdits")?.checked !== false,
            fillGenerative: $("fillGenerative")?.checked !== false,
            useLLM: $("useLLM")?.checked === true,
            llmUrl: $("llmUrl")?.value.trim() || "",
            llmModel: $("llmModel")?.value.trim() || "",
            llmKey: $("llmKey")?.value || ""
    }};
      if (payload.settings.useLLM && !payload.settings.llmUrl) {
          $("status").textContent = "Set the endpoint URL first (e.g. http://localhost:11434 for Ollama).";
          return;
      }
      // Cloud endpoints need an optional host permission; ask up front so fills don't fail silently.
      if (payload.settings.useLLM && payload.settings.llmUrl && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(payload.settings.llmUrl)) {
          try {
              const origin = new URL(payload.settings.llmUrl).origin + "/*";
              const granted = await extApi?.permissions?.request?.({origins: [origin]});
              if (granted === false) {
                  $("status").textContent = "Browser refused host permission for the endpoint. Local drafting still works.";
                  return;
              }
          } catch {
          }
      }
    await storeSet(payload);
    // Read-back: proves it actually persisted (catches private-mode / removed-addon / file:// issues).
    const check = await storeGet("settings");
    if (check?.settings && typeof check.settings.autoFill === "boolean") {
      $("status").textContent = "Saved and verified. Refresh the page. Values must stay.";
    } else {
      $("status").textContent = "Save called but read-back empty. Storage is not persisting (see resumeStatus).";
    }
  } catch (e) { console.error(e); $("status").textContent = "Save FAILED: " + (e?.message || e); }
};

refreshAll().catch(e => {
  console.error(e);
  const el = $("resumeStatus");
  if (el) el.textContent = "Load error: " + (e?.message || e);
});

const testLLMBtn = $("testLLM");
if (testLLMBtn) testLLMBtn.onclick = async () => {
    const st = $("llmStatus");
    try {
        if (st) st.textContent = "Testing…";
        const url = ($("llmUrl")?.value || "").trim().replace(/\/$/, "");
        if (!url) {
            if (st) st.textContent = "Set the endpoint URL first.";
            return;
        }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        // Prefer OpenAI-compatible /v1/models; fall back to Ollama /api/tags.
        let ok = false, detail = "";
        try {
            const r = await fetch(url + "/v1/models", {
                signal: ctrl.signal,
                headers: $("llmKey")?.value ? {Authorization: "Bearer " + $("llmKey").value} : {}
            });
            ok = r.ok;
            detail = `GET /v1/models → ${r.status}${r.status === 401 ? " (key missing/invalid — paste your OpenRouter key)" : ""}`;
        } catch (e) {
            try {
                const r2 = await fetch(url + "/api/tags", {signal: ctrl.signal});
                ok = r2.ok;
                detail = `GET /api/tags → ${r2.status}`;
            } catch (e2) {
                detail = String(e2?.message || e2);
            }
        } finally {
            clearTimeout(t);
        }
        if (st) st.textContent = ok ? `Connected ✓ (${detail}). Save settings to use it.` : `Not reachable (${detail}). For Ollama: run "ollama serve". Cloud endpoints need host permission — the browser will ask when saving.`;
    } catch (e) {
        if (st) st.textContent = "Test failed: " + (e?.message || e);
    }
};
