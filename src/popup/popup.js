/* Popup is action-only (no file input: popup closes when file picker opens). Upload lives in Options page. */
const extApi = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);

async function refresh() {
  const { profile } = await extApi.storage.local.get("profile");
  $("status").textContent = profile
    ? `Resume saved: ${profile.personal.fullName || "unnamed"} | ${profile.personal.email || "no email"}\nOpen a job form and hit Fill.`
    : "No resume yet. Click Upload / edit resume.";
}
$("upload").onclick = async () => { await extApi.runtime.openOptionsPage(); window.close(); };
$("openOptions").onclick = (e) => { e.preventDefault(); extApi.runtime.openOptionsPage(); };
$("fill").onclick = async () => {
  const [tab] = await extApi.tabs.query({ active: true, currentWindow: true });
  try { await extApi.tabs.sendMessage(tab.id, { type: "FILL_NOW" }); window.close(); }
  catch { $("status").textContent = "Could not reach this page. Open a normal job form (http/https)."; }
};
$("forget").onclick = async () => {
  const [tab] = await extApi.tabs.query({ active: true, currentWindow: true });
  try {
    const r = await extApi.tabs.sendMessage(tab.id, { type: "FORGET_SITE" });
    $("status").textContent = `Forgot ${r?.forgotten ?? 0} learned fix(es) on this site.`;
  } catch { $("status").textContent = "Could not reach this page."; }
};
refresh().catch(e => { $("status").textContent = "Load error: " + (e?.message || e); });
