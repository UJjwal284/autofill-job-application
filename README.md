# Resume Autofill for Job Applications (Firefox)

Save your resume once. Job application forms fill themselves. Correct any field once and the extension learns your fix for that site.

**100% local.** No account, no server, no analytics, no network calls. Your resume never leaves your browser (`storage.local`).

## Install (development)

1. `npm install`
2. `npm run build` (or `npm run release` = lint + build)
3. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `manifest.json`.

## Use

1. Toolbar icon → **Upload / edit resume** (opens Settings; uploading must happen there because popups close when the file picker opens).
2. Upload PDF / DOCX / TXT / MD / HTML, or paste resume text, → **Save resume → build profile**.
3. Open any job form → it fills itself. Hit **Fill this form now** in the popup to re-run.
4. Fix anything wrong directly in the form. Your correction is remembered per site and wins next time.

`test-page.html` (repo root, never packaged) is a fake job form for trying it out.

## Why some sites failed before (fixed)

Old filler only read the visible `<label>` text and knew ~15 field types, so it missed:

- cryptic ATS names (`fname`, `job_application[first_name]`, `data-automation-id`),
- `autocomplete` / `aria-labelledby` / placeholder-only labels (Workday, Greenhouse, Lever, Ashby),
- fields inside shadow DOM, iframes, or rendered late by React (SPA),
- React-controlled inputs (setting `.value` without the native setter + events is ignored),
- `<select>`, radio groups, date inputs, contenteditable editors,
- cover-letter / "why are you a fit?" boxes (nothing to copy — needs drafting).

New behavior: every field is scored against **all** signals (label, name, id, placeholder,
`autocomplete`, `aria`, `data-automation-id`) across 40+ field types in several languages; fills use the React-safe
native setter; shadow DOM + iframes + late-rendered SPA fields are observed and filled; cover/why-fit boxes get a local
draft you review (or your own AI model, below).

## Optional AI (off by default)

Built-in drafting is 100% local and always available. If you want longer AI-drafted cover letters, enable **Settings →
Optional AI**: point it at your own model — local Ollama (`http://localhost:11434`, model e.g. `llama3.1`) or any
OpenAI-compatible endpoint + key. Your resume text is sent only to *your* endpoint, never to us (we operate no server).
Enabling cloud endpoints will prompt for host permission; local Ollama needs none beyond localhost. AI output is always
inserted as an editable draft — review before submitting.

## Privacy

- Resume text, profile, settings, and learned corrections live only in Firefox `storage.local` on your machine.
- Content scripts run on job sites solely to read form labels and fill values. Nothing is transmitted anywhere. The extension makes zero network requests.
- Password, payment, SSN, and search fields are never filled and never learned.

## Permissions (and why)

| Permission | Why |
|---|---|
| `storage` | Save your resume profile, settings, and per-site corrections locally |
| Content scripts on all URLs | Detect and fill job forms wherever they appear |

No `host_permissions`, no `activeTab`, no `scripting`, no remote code. PDF/DOCX parsing uses vendored local libraries
(`pdfjs-dist 3.4.120`, `mammoth 1.12.3`, see `src/lib/vendor/`). That is why `web-ext lint` reports `DANGEROUS_EVAL`
warnings for those vendored files only. Further benign warnings note that `data_collection_permissions` (Firefox 140+)
and `optional_host_permissions` (Firefox 128+) are ignored on older versions; `strict_min_version` stays at 109 for
broad support (the optional-AI endpoint feature simply stays dormant there).

## Scripts

- `npm test`: node smoke test for the resume parser + field mapping (`test/smoke.cjs`)
- `npm run lint`: `web-ext lint`
- `npm run build` / `npm run release`: lint + `web-ext build` into `web-ext-artifacts/`

Personal data in `profiles/` (local fixtures only) is git-ignored and excluded from the store package.
