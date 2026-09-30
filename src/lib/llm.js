/* Optional BYO LLM — OFF by default. 100% local unless the user opts in.
 * Supports: local Ollama (http://localhost:11434, OpenAI-compatible /api/chat)
 *           any OpenAI-compatible endpoint (custom URL + optional API key + model).
 * Never called unless settings.useLLM === true. All failures return null
 * so the caller falls back to the local template composer.
 */
const ResumeLLM = (() => {
    async function directFetch(settings, messages, maxTokens) {
        const url = (settings.llmUrl || "").trim();
        const model = (settings.llmModel || "").trim() || "llama3.1";
        if (!url) return null;
        const endpoint = url.replace(/\/$/, "") + "/v1/chat/completions";
        const headers = {"Content-Type": "application/json"};
        if (settings.llmKey) headers.Authorization = "Bearer " + settings.llmKey;
        // OpenRouter (openrouter.ai) is OpenAI-compatible; these optional headers are
        // recommended by OpenRouter for identification and are harmless elsewhere.
        headers["X-Title"] = "Resume Autofill";
        try {
            const ref = globalThis.location?.href;
            if (ref && /^https?:/i.test(ref)) headers["HTTP-Referer"] = ref;
        } catch {
        }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 25000);
        try {
            const res = await fetch(endpoint, {
                method: "POST", headers, signal: ctrl.signal,
                body: JSON.stringify({model, messages, max_tokens: maxTokens, temperature: 0.4})
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data?.choices?.[0]?.message?.content?.trim() || null;
        } catch {
            return null;
        } finally {
            clearTimeout(t);
        }
    }

    async function chat(settings, messages, maxTokens = 400) {
        try {
            if (!settings?.useLLM) return null;
            // Prefer the background relay (extension principal, dodges page CSP/mixed-content).
            try {
                const extApi = globalThis.browser ?? globalThis.chrome;
                if (extApi?.runtime?.sendMessage) {
                    const resp = await Promise.race([
                        extApi.runtime.sendMessage({type: "LLM_CHAT", messages, maxTokens}),
                        new Promise((_, rej) => setTimeout(() => rej(new Error("relay timeout")), 27000))
                    ]);
                    if (resp?.text) return resp.text;
                    // Relay answered null (not configured / failed) — fall through to direct.
                    if (resp && "text" in resp) return null;
                }
            } catch { /* fall through to direct fetch */
            }
            return await directFetch(settings, messages, maxTokens);
        } catch {
            return null;
        }
    }

    function profileContext(profile) {
        const p = profile || {};
        return [
            `Name: ${p.personal?.fullName || ""}`,
            `Email: ${p.personal?.email || ""} | Phone: ${p.personal?.phone || ""}`,
            `Location: ${p.personal?.location || ""} | LinkedIn: ${p.personal?.linkedin || ""} | GitHub: ${p.personal?.github || ""} | Portfolio: ${p.personal?.portfolio || ""}`,
            `Title: ${p.professional?.currentTitle || ""} at ${p.professional?.currentCompany || ""}`,
            `Years: ${p.professional?.yearsExperience ?? ""} | Skills: ${(p.professional?.skills || []).join(", ")}`,
            `Summary: ${(p.professional?.summary || "").slice(0, 600)}`
        ].join("\n");
    }

    async function composeField(kind, fieldLabel, profile, settings) {
        const ctx = profileContext(profile);
        const prompts = {
            coverLetter: `Write a concise professional cover letter (150-220 words) for a job application. Applicant:\n${ctx}`,
            whyFit: `In 2-4 sentences, explain why this applicant is a strong fit. Field asked: "${fieldLabel}". Applicant:\n${ctx}`,
            whyCompany: `In 2-4 sentences, express genuine interest in the role/company. Field asked: "${fieldLabel}". Applicant:\n${ctx}`,
            additionalInfo: `Write a brief "additional information" note (1-3 sentences) for a job application. Applicant:\n${ctx}`
        };
        const text = await chat(settings, [
            {
                role: "system",
                content: "You write job-application answers. Plain text only, no markdown headers, no placeholders. Use only facts given."
            },
            {role: "user", content: prompts[kind] || prompts.additionalInfo}
        ], 450);
        return text ? text.slice(0, 3000) : null;
    }

    return {chat, composeField};
})();

if (typeof window !== "undefined") window.ResumeLLM = ResumeLLM;
if (typeof self !== "undefined") self.ResumeLLM = ResumeLLM;
if (typeof module !== "undefined" && module.exports) module.exports = ResumeLLM;
