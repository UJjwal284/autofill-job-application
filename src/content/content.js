/* Content script: detect + fill job forms, LEARN from manual corrections per site.
 * Hardened: shadow DOM, ATS quirks, React-safe fills, SPA late-render, custom widgets.
 * Local-first: profile.js brain does the mapping. Optional BYO LLM (llm.js) only
 * for generative free-text fields and only when the user enabled it.
 */
(() => {
  const extApi = globalThis.browser ?? globalThis.chrome;
    const Brain = () => globalThis.ResumeAutofill;
    const LLM = () => globalThis.ResumeLLM || null;
  const HIGHLIGHT = { high: "#b7f5c8", medium: "#fff3b0", low: "#ffc9c9", learned: "#cfe6ff" };
    const SKIP_RE = /search|captcha|password|passwd|pwd|credit.?card|card.?number|cvv|cvc|ssn|social.?security|card.?expir/i;
    const GENERATIVE_KEYS = new Set(["coverLetter", "whyFit", "whyCompany", "additionalInfo"]);

  async function getState() {
    const store = await extApi.storage.local.get(["profile", "settings", "learned"]);
    return {
      profile: store.profile || null,
        settings: Object.assign({
            autoFill: true,
            learnFromEdits: true,
            fillGenerative: true,
            useLLM: false,
            llmUrl: "",
            llmModel: "",
            llmKey: "",
            disabledSites: []
        }, store.settings || {}),
      learned: store.learned || {}
    };
  }

    const isDisabledOn = (settings, host) => {
        try {
            return Brain()?.isSiteDisabled ? Brain().isSiteDisabled(host || domain(), settings?.disabledSites) : false;
        } catch {
            return false;
        }
    };

  const domain = () => { try { return new URL(location.href).hostname.replace(/^www\./, ""); } catch { return location.host; } };
  const normLabel = (s) => (s || "").toLowerCase().replace(/[*:\-–—()[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const learnKey = (d, label) => `${d}||${normLabel(label)}`;

    // ---------- field discovery (incl. shadow DOM) ----------

    function allRoots(root = document, out = []) {
        out.push(root);
        const walker = (node) => {
            if (node.shadowRoot) {
                out.push(node.shadowRoot);
                walker(node.shadowRoot);
            }
            const kids = node.querySelectorAll ? node.querySelectorAll("*") : [];
            for (const k of kids) if (k.shadowRoot) {
                out.push(k.shadowRoot);
                walker(k.shadowRoot);
            }
        };
        walker(root === document ? document.documentElement : root);
        return out;
    }

    function isVisible(el) {
        if (el.disabled) return false;
        const type = (el.type || "").toLowerCase();
        if (["hidden", "submit", "button", "image", "file"].includes(type)) return false;
        if (el.readOnly && el.tagName !== "SELECT") {
            // readonly text fields (date pickers etc.) — still try via picker, but mark visible
        }
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : {width: 1, height: 1};
        const cs = el.ownerDocument?.defaultView?.getComputedStyle(el);
        if (cs && (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0)) return false;
        // offsetParent is null for position:fixed — don't treat as hidden.
        const stylePos = cs?.position;
        if (el.offsetParent === null && stylePos !== "fixed" && el.tagName !== "BODY" && (r.width === 0 && r.height === 0)) return false;
        return true;
    }

    function collectFields() {
        const sel = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, select, [contenteditable="true"], [role="combobox"] input, [role="textbox"]';
        const found = [];
        for (const root of allRoots()) {
            try {
                for (const el of root.querySelectorAll(sel)) {
                    if (el.tagName === "INPUT" && ["hidden", "submit", "button", "image"].includes((el.type || "").toLowerCase())) continue;
                    if (!isVisible(el)) continue;
                    found.push(el);
                }
            } catch {
            }
        }
        return [...new Set(found)];
    }

    // ---------- label / signal extraction ----------

    function ariaLabelledText(el) {
        try {
            const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
            if (!ids.length) return "";
            const root = el.getRootNode();
            const parts = ids.map(id => {
                try {
                    return root.querySelector("#" + CSS.escape(id))?.innerText?.trim() || document.getElementById(id)?.innerText?.trim() || "";
                } catch {
                    return "";
                }
            }).filter(Boolean);
            return parts.join(" ").slice(0, 140);
        } catch {
            return "";
        }
    }

    function nearbyText(el, maxChars = 140) {
        // preceding <label>/<span>/<div> siblings often hold the real question (Workday/Greenhouse)
        try {
            let node = el;
            for (let depth = 0; depth < 4 && node; depth++) {
                let sib = node.previousElementSibling;
                let hops = 0;
                while (sib && hops < 4) {
                    const t = (sib.innerText || "").trim().replace(/\s+/g, " ");
                    if (t && t.length > 2 && t.length < maxChars && !/^\s*$/.test(t)) return t.slice(0, maxChars);
                    sib = sib.previousElementSibling;
                    hops++;
                }
                node = node.parentElement;
                if (!node || /^(FORM|BODY)$/.test(node.tagName)) break;
            }
        } catch {
        }
        return "";
    }

    function containerText(el) {
        try {
            const c = el.closest("div, fieldset, li, p, td, [role='group'], [data-automation-id], [data-testid]");
            if (!c) return "";
            // legend first (fieldset), else first short line
            const legend = c.querySelector?.(":scope > legend")?.innerText?.trim();
            if (legend) return legend.slice(0, 140);
            const txt = (c.innerText || "").trim().split("\n").map(s => s.trim()).filter(Boolean)[0];
            return txt && txt.length > 2 && txt.length < 120 ? txt : "";
        } catch {
            return "";
        }
    }

    function dataTestId(el) {
        try {
            const host = el.closest("[data-automation-id],[data-testid],[data-qa],[data-ph-id],[data-automation]");
            const v = el.getAttribute("data-automation-id") || el.getAttribute("data-testid") || el.getAttribute("data-qa") || el.getAttribute("data-ph-id") || host?.getAttribute("data-automation-id") || host?.getAttribute("data-testid") || "";
            return (v || "").slice(0, 120);
        } catch {
            return "";
        }
    }

  function labelFor(el) {
      try {
          if (el.id) {
              const root = el.getRootNode();
              let l = null;
              try {
                  l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
              } catch {
              }
              if (!l && root !== document) l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
              if (l?.innerText?.trim()) return l.innerText.trim().slice(0, 140);
          }
          const aria = ariaLabelledText(el);
          if (aria) return aria;
          if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").slice(0, 140);
          const wrap = el.closest("label");
          if (wrap?.innerText?.trim()) return wrap.innerText.trim().slice(0, 140);
          if (el.placeholder) return el.placeholder.slice(0, 140);
          if (el.getAttribute("title")) return el.getAttribute("title").slice(0, 140);
          const near = nearbyText(el);
          if (near) return near;
          const cont = containerText(el);
          if (cont) return cont;
      } catch {
      }
      return "";
  }

    function collectSignals(el) {
        const label = labelFor(el);
        const rawName = el.name || el.getAttribute?.("data-name") || "";
        const rawId = el.id || "";
        const testId = dataTestId(el);
        const humanized = Brain()?.humanizeToken ? Brain().humanizeToken(rawName || rawId || testId) : "";
        return {
            // label falls back to humanized name/id so cryptic ATS names still match
            label: label || humanized || testId.replace(/[-_]+/g, " "),
            name: rawName, id: rawId,
            placeholder: el.placeholder || "",
            autocomplete: el.autocomplete || el.getAttribute?.("autocomplete") || "",
            type: el.type || el.tagName,
            aria: el.getAttribute?.("aria-label") || ariaLabelledText(el),
            testId
        };
  }

    // ---------- filling ----------

  function elValue(el) {
      if (el.isContentEditable) return (el.innerText || "").trim();
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "yes" : "no";
    return (el.value ?? "").toString();
  }

    function reactSafeSetValue(el, value) {
        const v = String(value);
        if (el.isContentEditable) {
            el.focus();
            document.execCommand?.("selectAll", false, null);
            document.execCommand?.("insertText", false, v);
            if ((el.innerText || "") !== v) el.innerText = v;
            el.dispatchEvent(new InputEvent("input", {bubbles: true}));
            el.dispatchEvent(new Event("change", {bubbles: true}));
            el.blur();
            return;
        }
        // Climb prototype chain for the native setter (beats React/Vue controlled inputs).
        let proto = Object.getPrototypeOf(el);
        let setter = null;
        while (proto && !setter) {
            setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            proto = Object.getPrototypeOf(proto);
        }
        try {
            if (setter) setter.call(el, v);
            else el.value = v;
        } catch {
            el.value = v;
        }
        // Nudge frameworks: focus → input → change → blur.
        el.dispatchEvent(new FocusEvent("focus", {bubbles: true}));
        el.dispatchEvent(new InputEvent("input", {bubbles: true, data: v}));
        el.dispatchEvent(new Event("change", {bubbles: true}));
        el.dispatchEvent(new KeyboardEvent("keydown", {bubbles: true, key: "a"}));
        el.dispatchEvent(new KeyboardEvent("keyup", {bubbles: true, key: "a"}));
        el.dispatchEvent(new FocusEvent("blur", {bubbles: true}));
    }

    function fillSelect(el, value) {
        const v = String(value).trim().toLowerCase();
        if (!v) return false;
        const opts = [...el.options];
        // exact → startsWith → includes on text or value
        const match = opts.find(o => o.text.trim().toLowerCase() === v || o.value.trim().toLowerCase() === v)
            || opts.find(o => o.text.trim().toLowerCase().startsWith(v) || o.value.trim().toLowerCase().startsWith(v))
            || opts.find(o => o.text.toLowerCase().includes(v) || v.includes(o.text.trim().toLowerCase()))
            || opts.find(o => {
                const v2 = v.replace(/^(yes|no)\b.*/, "$1");
                return v2.length >= 2 && o.text.toLowerCase().startsWith(v2);
            });
        if (match) {
            el.value = match.value;
            // some frameworks need option.selected + events
            match.selected = true;
            el.dispatchEvent(new Event("input", {bubbles: true}));
            el.dispatchEvent(new Event("change", {bubbles: true}));
            return true;
        }
        return false;
    }

    function fillCheckRadio(el, value) {
        const want = /yes|true|1|agree|consent|authorized|permit/i.test(String(value));
        // For radio groups, only check the button whose value/label matches; never force "no".
        if (el.type === "radio") {
            const group = el.name ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)] : [el];
            const target = group.find(r => {
                const t = ((r.value || "") + " " + (labelFor(r) || "")).toLowerCase();
                return want ? /yes|true|agree|authorized|permit|male|female/.test(t) && !/^(no|prefer)/.test(t) : /no|decline|prefer/.test(t);
            });
            const pick = target || (want ? group.find(r => /yes/i.test(r.value)) : null);
            if (pick && !pick.checked) {
                pick.checked = true;
                pick.dispatchEvent(new Event("input", {bubbles: true}));
                pick.dispatchEvent(new Event("change", {bubbles: true}));
                pick.dispatchEvent(new MouseEvent("click", {bubbles: true}));
                return pick;
            }
            return null;
        }
        const next = want && !el.checked ? true : (!want && el.checked ? false : null);
        if (next !== null) {
            el.checked = next;
            el.dispatchEvent(new Event("input", {bubbles: true}));
            el.dispatchEvent(new Event("change", {bubbles: true}));
            el.dispatchEvent(new MouseEvent("click", {bubbles: true}));
            return el;
        }
        return null;
    }

    function nativeFill(el, value) {
        if (el.tagName === "SELECT") {
            if (fillSelect(el, value)) return true;
            return false;
        }
        if (el.type === "checkbox" || el.type === "radio") return !!fillCheckRadio(el, value);
        if (el.type === "date" || el.type === "month") {
            try {
                el.value = String(value).slice(0, 10);
                el.dispatchEvent(new Event("change", {bubbles: true}));
                return true;
            } catch {
                return false;
            }
        }
        reactSafeSetValue(el, value);
        return true;
    }

    function paint(el, kind, title) {
        try {
            el.dataset.autofilled = "1";
            el.style.background = HIGHLIGHT[kind] || HIGHLIGHT.high;
            if (title) el.title = title;
        } catch {
        }
    }

    async function resolveValue(analysis, sig, profile, settings) {
        if (analysis.value) return analysis.value;
        if (!GENERATIVE_KEYS.has(analysis.key)) return "";
        if (settings.fillGenerative === false) return "";
        // 1) optional cloud/local LLM if user enabled it
        if (settings.useLLM && LLM()?.composeField) {
            try {
                const t = await LLM().composeField(analysis.key, sig.label, profile, settings);
                if (t && t.trim().length > 10) return t.trim();
            } catch {
            }
        }
        // 2) always-available local composer (the built-in tiny LLM)
        try {
            return (Brain().composeFreeText(analysis.key, profile) || "").slice(0, 3000);
        } catch {
            return "";
        }
  }

  async function fillAll(manual = false) {
    const { profile, settings, learned } = await getState();
      const d = domain();
      if (isDisabledOn(settings, d)) {
          if (manual) showToast(`Resume Autofill is disabled on ${d}. Click the toolbar icon → Enable on this site.`);
          return {filled: 0, disabled: true};
      }
    if (!profile) {
      if (manual) showToast("Resume Autofill: no resume saved yet. Click the toolbar icon → Upload / edit resume.");
      return { filled: 0 };
    }
    const fields = collectFields();
      let filled = 0, fromLearned = 0, generated = 0;

    for (const el of fields) {
        try {
            if (el.dataset.autofilled === "1" && !manual) continue;
            const sig = collectSignals(el);
            const hay = `${sig.label} ${sig.name} ${sig.id} ${sig.type} ${sig.testId}`;
            if (SKIP_RE.test(hay)) continue;
            if (!sig.label && !sig.name && !sig.id) continue;

            // 1st priority: your past correction on this site.
            const keys = [learnKey(d, sig.label), learnKey(d, sig.name), learnKey(d, sig.id), learnKey(d, sig.testId)].filter(k => k.split("||")[1]);
            const hitKey = keys.find(k => learned[k]?.value);
            if (hitKey) {
                // For radio groups learned values apply to the right button via fillCheckRadio.
                const ok = nativeFill(el, learned[hitKey].value);
                if (ok !== false) {
                    paint(el, "learned", `Filled from your past correction on ${d} (${learned[hitKey].count}x). Edit to re-teach.`);
                    filled++;
                    fromLearned++;
                }
                continue;
            }

            const a = Brain().analyzeField(sig, profile);
            if (a.skip) continue;
            const value = await resolveValue(a, sig, profile, settings);
            // Never overwrite user-typed content on auto-pass; manual re-fill may.
            const cur = elValue(el).trim();
            if (cur && !manual && el.dataset.autofilled !== "1") {
                // Respect existing content unless it looks like a placeholder.
                if (cur.length > 1 && cur !== sig.placeholder) continue;
            }
            if (value) {
                const ok = nativeFill(el, value);
                if (ok !== false) {
                    const wasGen = GENERATIVE_KEYS.has(a.key) && !a.value;
                    if (wasGen) generated++;
                    paint(el, a.confidence >= 0.6 ? "high" : "medium",
                        wasGen ? `Drafted for "${sig.label}" — REVIEW before submitting.` : `Autofilled (${a.key}, ${(a.confidence * 100) | 0}%). Correct me and I'll learn.`);
                    filled++;
                }
            } else if (manual && a.key !== "unknown") {
                paint(el, "low", `No resume data for "${sig.label}" (${a.key}). Type it once and I'll learn it for ${d}.`);
            } else if (a.key === "unknown" && manual) {
                paint(el, "low", `Couldn't map "${sig.label}". Type the answer once and I'll learn it for ${d}.`);
            }
        } catch (e) {
            console.warn("[autofill] fill field failed:", e);
        }
    }

    if (manual || filled > 0) {
      const extra = fromLearned ? ` (${fromLearned} from your corrections)` : "";
        const gen = generated ? ` · ${generated} drafted — review` : "";
        showToast(`Autofilled ${filled}/${fields.length}${extra}${gen}. Fix anything wrong and I learn it for ${d}.`);
    }
    return { filled, total: fields.length, fromLearned };
  }

    // ---- Learning: real user edits only (isTrusted=true skips our own fills). ----
  let saveTimer = null;
  document.addEventListener("change", async (e) => {
    try {
        if (!e.isTrusted) return;
      const el = e.target;
      if (!el || !/INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
        if (["hidden", "submit", "button", "password", "file"].includes(el.type)) return;
      const { settings, learned } = await getState();
        if (isDisabledOn(settings)) return;
      if (settings.learnFromEdits === false) return;
        const sig = collectSignals(el);
        const hay = `${sig.label} ${sig.name} ${sig.id} ${sig.type}`;
      if (SKIP_RE.test(hay)) return;
      const value = elValue(el).trim();
      if (!value || value.length > 3000) return;
      const d = domain();
        const key = learnKey(d, sig.label) || learnKey(d, sig.name || sig.id);
      if (!key.split("||")[1]) return;
      const prev = learned[key];
        if (prev?.value === value) return;
        learned[key] = {
            value,
            label: (sig.label || sig.name).slice(0, 80),
            domain: d,
            count: (prev?.count || 0) + 1,
            updatedAt: new Date().toISOString()
        };
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await extApi.storage.local.set({ learned });
          try {
              el.title = `Learned ✓. I'll reuse this on ${d}`;
              const before = el.style.background;
              el.style.background = HIGHLIGHT.learned;
              setTimeout(() => {
                  if (el.style.background === HIGHLIGHT.learned) el.style.background = before;
              }, 1200);
          } catch {
          }
      }, 400);
    } catch (err) { console.warn("[autofill] learn failed:", err); }
  }, true);

  function showToast(msg) {
      try {
          const d = document.createElement("div");
          d.textContent = msg;
          Object.assign(d.style, {
              position: "fixed",
              bottom: "18px",
              right: "18px",
              zIndex: 999999,
              background: "#111",
              color: "#fff",
              padding: "10px 14px",
              borderRadius: "10px",
              fontSize: "13px",
              maxWidth: "340px",
              boxShadow: "0 4px 18px rgba(0,0,0,.3)"
          });
          document.body.appendChild(d);
          setTimeout(() => d.remove(), 6000);
      } catch {
      }
  }

  extApi.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "FILL_NOW") return fillAll(true);
      if (msg?.type === "PING") return (async () => {
          const {settings} = await getState();
          return {ok: true, fields: collectFields().length, disabled: isDisabledOn(settings), domain: domain()};
      })();
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

    // SPA + late-render: observe DOM, refill new empty fields (debounced).
    let obsTimer = null;

    function armObserver() {
        try {
            const obs = new MutationObserver(() => {
                clearTimeout(obsTimer);
                obsTimer = setTimeout(async () => {
                    try {
                        const {settings} = await getState();
                        if (isDisabledOn(settings)) return;
                        if (settings.autoFill) await fillAll(false);
                    } catch {
                    }
                }, 1200);
            });
            obs.observe(document.documentElement, {childList: true, subtree: true});
        } catch {
        }
        // SPA navigation (Workday/Lever pushState)
        const _push = history.pushState;
        history.pushState = function (...a) {
            const r = _push.apply(this, a);
            setTimeout(async () => {
                try {
                    const {settings} = await getState();
                    if (!isDisabledOn(settings)) fillAll(false);
                } catch {
                }
            }, 1200);
            return r;
        };
        window.addEventListener("popstate", async () => setTimeout(async () => {
            try {
                const {settings} = await getState();
                if (!isDisabledOn(settings)) fillAll(false);
            } catch {
            }
        }, 1200));
    }

  (async () => {
    const { settings } = await getState();
      armObserver();
      if (!isDisabledOn(settings) && settings.autoFill) {
          setTimeout(() => fillAll(false), 1200);
          setTimeout(() => fillAll(false), 3500);
          setTimeout(() => fillAll(false), 8000);
    }
  })();
})();
