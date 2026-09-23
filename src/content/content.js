/* Content script: detect + fill job forms, LEARN from manual corrections per site. */
(() => {
  const extApi = globalThis.browser ?? globalThis.chrome;
  const HIGHLIGHT = { high: "#b7f5c8", medium: "#fff3b0", low: "#ffc9c9", learned: "#cfe6ff" };
  const SKIP_RE = /search|captcha|password|passwd|pwd|credit.?card|card.?number|cvv|cvc|ssn|social.?security/i;

  async function getState() {
    const store = await extApi.storage.local.get(["profile", "settings", "learned"]);
    return {
      profile: store.profile || null,
      settings: store.settings || { autoFill: true, learnFromEdits: true },
      learned: store.learned || {}
    };
  }

  const domain = () => { try { return new URL(location.href).hostname.replace(/^www\./, ""); } catch { return location.host; } };
  const normLabel = (s) => (s || "").toLowerCase().replace(/[*:\-–—()[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const learnKey = (d, label) => `${d}||${normLabel(label)}`;

  function labelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.innerText?.trim()) return l.innerText.trim();
    }
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    if (el.placeholder) return el.placeholder;
    const wrap = el.closest("label");
    if (wrap?.innerText?.trim()) return wrap.innerText.trim().slice(0, 120);
    const container = el.closest("div, fieldset, li, p");
    const txt = container?.innerText?.trim().split("\n")[0]?.slice(0, 120);
    const fallback = el.name || el.id || "";
    return txt && txt.length < 80 && txt.length > 2 ? txt : fallback;
  }

  function collectFields() {
    const sel = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select';
    return [...document.querySelectorAll(sel)].filter(el => {
      const r = el.getBoundingClientRect();
      return el.offsetParent !== null || r.width > 0;
    });
  }

  function elValue(el) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "yes" : "no";
    return (el.value ?? "").toString();
  }

  function nativeFill(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
      || Object.getOwnPropertyDescriptor(HTMLElement.prototype, "value")?.set;
    if (el.type === "checkbox" || el.type === "radio") {
      el.checked = /yes|true|1/i.test(String(value));
    } else if (el.tagName === "SELECT") {
      const v = String(value).toLowerCase();
      const opt = [...el.options].find(o => o.text.toLowerCase().includes(v) || o.value.toLowerCase() === v);
      if (opt) el.value = opt.value;
    } else {
      if (setter) setter.call(el, String(value));
      else el.value = String(value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillAll(manual = false) {
    const { profile, settings, learned } = await getState();
    if (!profile) {
      // Silent on auto-fill: a new user without a saved resume must never get
      // popups on every page they visit. Only nudge on explicit manual Fill.
      if (manual) showToast("Resume Autofill: no resume saved yet. Click the toolbar icon → Upload / edit resume.");
      return { filled: 0 };
    }
    const d = domain();
    const fields = collectFields();
    let filled = 0, fromLearned = 0;

    for (const el of fields) {
      if (el.dataset.autofilled === "1" && !manual) continue;
      const label = labelFor(el);
      if (SKIP_RE.test(label + " " + el.name + " " + el.id + " " + el.type)) continue;

      // 1st priority: what YOU typed here before (manual corrections win over resume rules).
      const lk = learnKey(d, label) || learnKey(d, el.name || el.id);
      if (learned[lk]?.value) {
        nativeFill(el, learned[lk].value);
        el.dataset.autofilled = "1";
        el.style.background = HIGHLIGHT.learned;
        el.title = `Filled from your past correction on ${d} (${learned[lk].count}x). Edit to re-teach.`;
        filled++; fromLearned++;
        continue;
      }

      const m = ResumeAutofill.mapLabelToProfile(label, profile);
      if (m.value) {
        nativeFill(el, m.value);
        el.dataset.autofilled = "1";
        el.style.background = HIGHLIGHT.high;
        el.title = `Autofilled (${m.key}, ${(m.confidence * 100) | 0}%). Correct me and I'll learn.`;
        filled++;
      } else {
        el.style.background = HIGHLIGHT.low;
      }
    }

    if (manual || filled > 0) {
      const extra = fromLearned ? ` (${fromLearned} from your corrections)` : "";
      showToast(`Autofilled ${filled}/${fields.length}${extra}. Fix anything wrong and I learn it for ${d}.`);
    }
    return { filled, total: fields.length, fromLearned };
  }

  // ---- Learning: real user edits only (isTrusted=true skips our own programmatic fills). ----
  let saveTimer = null;
  document.addEventListener("change", async (e) => {
    try {
      if (!e.isTrusted) return; // ignore our own fills
      const el = e.target;
      if (!el || !/INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
      if (el.type === "hidden" || el.type === "submit" || el.type === "button" || el.type === "password") return;
      const { settings, learned } = await getState();
      if (settings.learnFromEdits === false) return;
      const label = labelFor(el);
      const hay = `${label} ${el.name} ${el.id} ${el.type}`;
      if (SKIP_RE.test(hay)) return;
      const value = elValue(el).trim();
      if (!value || value.length > 3000) return;
      const d = domain();
      const key = learnKey(d, label) || learnKey(d, el.name || el.id);
      if (!key.split("||")[1]) return;
      const prev = learned[key];
      if (prev?.value === value) return; // no change
      learned[key] = { value, label: label.slice(0, 80), domain: d, count: (prev?.count || 0) + 1, updatedAt: new Date().toISOString() };
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await extApi.storage.local.set({ learned });
        el.title = `Learned ✓. I'll reuse this on ${d}`;
        const before = el.style.background;
        el.style.background = HIGHLIGHT.learned;
        setTimeout(() => { if (el.style.background === HIGHLIGHT.learned) el.style.background = before; }, 1200);
      }, 400);
    } catch (err) { console.warn("[autofill] learn failed:", err); }
  }, true);

  function showToast(msg) {
    const d = document.createElement("div");
    d.textContent = msg;
    Object.assign(d.style, { position: "fixed", bottom: "18px", right: "18px", zIndex: 999999, background: "#111", color: "#fff", padding: "10px 14px", borderRadius: "10px", fontSize: "13px", maxWidth: "340px", boxShadow: "0 4px 18px rgba(0,0,0,.3)" });
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 5000);
  }

  extApi.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "FILL_NOW") return fillAll(true);
    if (msg?.type === "PING") return Promise.resolve({ ok: true, fields: collectFields().length });
    if (msg?.type === "FORGET_SITE") {
      return (async () => {
        const { learned } = await getState();
        const d = domain(), prefix = d + "||";
        let n = 0;
        for (const k of Object.keys(learned)) if (k.startsWith(prefix)) { delete learned[k]; n++; }
        await extApi.storage.local.set({ learned });
        return { forgotten: n };
      })();
    }
  });

  (async () => {
    const { settings } = await getState();
    if (settings.autoFill) {
      setTimeout(() => fillAll(false), 1500);
      setTimeout(() => fillAll(false), 4000);
    }
  })();
})();
