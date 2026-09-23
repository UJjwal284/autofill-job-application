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
  renderLearned(learned || {});
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

const clearBtn = $("clearLearned");
if (clearBtn) clearBtn.onclick = async () => {
  try { await storeSet({ learned: {} }); renderLearned({}); if ($("resumeStatus")) $("resumeStatus").textContent = "Forgot all learned corrections."; }
  catch (e) { if ($("resumeStatus")) $("resumeStatus").textContent = "Clear failed: " + (e?.message || e); }
};

const saveBtn = $("save");
if (saveBtn) saveBtn.onclick = async () => {
  try {
    const payload = { settings: {
      autoFill: $("autoFill")?.checked !== false, learnFromEdits: $("learnFromEdits")?.checked !== false
    }};
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
