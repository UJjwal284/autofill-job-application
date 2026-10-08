/* Popup is action-only (no file input: popup closes when file picker opens). Upload lives in Options page. */
const extApi = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);
const Brain = () => globalThis.ResumeAutofill || null;

const normalize = (h) => {
    try {
        return Brain()?.normalizeDomain ? Brain().normalizeDomain(h) : String(h || "").toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
};

async function currentTab() {
    try {
        const [tab] = await extApi.tabs.query({active: true, currentWindow: true});
        return tab || null;
    } catch {
        return null;
    }
}

function hostnameOf(url) {
    try {
        const u = new URL(url);
        if (!/^https?:/i.test(u.protocol)) return "";
        return normalize(u.hostname);
    } catch {
        return "";
    }
}

let siteHost = "";

async function refresh() {
    const {profile, settings} = await extApi.storage.local.get(["profile", "settings"]);
    const disabledSites = settings?.disabledSites || [];
    const tab = await currentTab();
    siteHost = tab?.url ? hostnameOf(tab.url) : "";
    const isDisabled = siteHost && Brain()?.isSiteDisabled
        ? Brain().isSiteDisabled(siteHost, disabledSites)
        : disabledSites.includes(siteHost);

    $("site").textContent = siteHost ? `This site: ${siteHost}${isDisabled ? " (disabled)" : ""}` : "This site: not a web page";
    const toggle = $("siteToggle");
    toggle.style.display = siteHost ? "" : "none";
    toggle.textContent = isDisabled ? `Enable on ${siteHost}` : `Disable on ${siteHost || "this site"}`;
    toggle.classList.toggle("off", !isDisabled);

    $("fill").disabled = !!isDisabled;
    $("fill").textContent = isDisabled ? "Disabled on this site" : "Fill this form now";

    $("status").textContent = isDisabled
        ? `Autofill is off on ${siteHost}. Hit Enable to use it here again.`
        : profile
            ? `Resume saved: ${profile.personal.fullName || "unnamed"} | ${profile.personal.email || "no email"}\nOpen a job form and hit Fill.`
            : "No resume yet. Click Upload / edit resume.";
}
$("upload").onclick = async () => { await extApi.runtime.openOptionsPage(); window.close(); };
$("openOptions").onclick = (e) => { e.preventDefault(); extApi.runtime.openOptionsPage(); };
$("fill").onclick = async () => {
  const [tab] = await extApi.tabs.query({ active: true, currentWindow: true });
    try {
        const r = await extApi.tabs.sendMessage(tab.id, {type: "FILL_NOW"});
        if (r?.disabled) $("status").textContent = `Disabled on ${siteHost}. Hit Enable to use it here.`;
        else window.close();
    }
  catch { $("status").textContent = "Could not reach this page. Open a normal job form (http/https)."; }
};
$("siteToggle").onclick = async () => {
    if (!siteHost) return;
    try {
        const {settings} = await extApi.storage.local.get("settings");
        const s = {autoFill: true, learnFromEdits: true, fillGenerative: true, ...(settings || {})};
        const list = new Set((s.disabledSites || []).map(normalize).filter(Boolean));
        const nowDisabled = Brain()?.isSiteDisabled
            ? Brain().isSiteDisabled(siteHost, [...list])
            : list.has(siteHost);
        if (nowDisabled) {
            // remove this host and any entry that exactly covers it
            for (const e of [...list]) if (siteHost === e || siteHost.endsWith("." + e)) list.delete(e);
            // if it was disabled via a parent (e.g. disabled "example.com", on "jobs.example.com"),
            // removing the parent re-enables — that is the expected toggle behaviour.
        } else {
            list.add(siteHost);
        }
        s.disabledSites = [...list].sort();
        await extApi.storage.local.set({settings: s});
        await refresh();
    } catch (e) {
        $("status").textContent = "Toggle failed: " + (e?.message || e);
    }
};
$("forget").onclick = async () => {
  const [tab] = await extApi.tabs.query({ active: true, currentWindow: true });
  try {
      // Global learning: one store for all sites, so forgetting clears everything.
      let r = null;
      try {
          r = await extApi.tabs.sendMessage(tab.id, {type: "FORGET_ALL"});
      } catch {
          r = await extApi.tabs.sendMessage(tab.id, {type: "FORGET_SITE"});
      }
      $("status").textContent = `Forgot ${r?.forgotten ?? 0} learned fix(es) everywhere.`;
  } catch {
      // Page unreachable (e.g. about: pages): clear storage directly.
      try {
          const {learned} = await extApi.storage.local.get("learned");
          const n = Object.keys(learned || {}).length;
          await extApi.storage.local.set({learned: {}});
          $("status").textContent = `Forgot ${n} learned fix(es) everywhere.`;
      } catch {
          $("status").textContent = "Could not reach this page.";
      }
  }
};
refresh().catch(e => { $("status").textContent = "Load error: " + (e?.message || e); });
