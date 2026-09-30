/* Shared profile + LLM-grade local field brain.
 * 100% local by default. No network calls here.
 * Optional BYO LLM lives in src/lib/llm.js and is OFF unless the user enables it.
 */

const ResumeAutofill = (() => {
  const SKILLS_LEXICON = [
    "javascript","typescript","python","java","go","rust","c++","c#","sql","react","reactjs","angular","vue",
    "node","node.js","express","django","flask","spring","spring boot","aws","ec2","vpc","iam","s3","rds","cloudwatch","route 53",
    "azure","gcp","docker","kubernetes","openshift","helm","terraform","jenkins","git","linux",
      "postgresql", "postgres", "mysql", "mongodb", "redis", "oracle db", "ollama", "chromadb", "rag", "vector databases", "ci/cd", "sre", "observability",
    "selenium","playwright","figma","photoshop","excel","salesforce","hubspot","sap",
      "machine learning", "deep learning", "nlp", "data analysis", "data science", "project management", "agile", "scrum", "communication",
    "leadership","customer service","marketing","seo","accounting","autocad","matlab"
  ];

    // ---------------- resume parsing ----------------

  function extractContacts(text) {
    const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || "";
      const phones = [...text.matchAll(/(\+?\d[\d\s\-().]{7,}\d)/g)].map(m => m[0].trim()).filter(p => (p.replace(/\D/g, "").length >= 7));
      const phone = phones[0] || "";
    const linkedin = (text.match(/(?:linkedin\.com\/in\/[A-Za-z0-9\-_%.]+|linkedin\.com\/[A-Za-z0-9\-_]+)/i) || [])[0] || "";
    const github = (text.match(/github\.com\/[A-Za-z0-9\-_]+/i) || [])[0] || "";
      const urls = [...text.matchAll(/https?:\/\/[^\s)>,"]+/gi)].map(m => m[0].replace(/[.,;]+$/, ""));
      const portfolio = urls.find(u => !/linkedin\.com|github\.com/i.test(u)) || "";
      const website = urls[0] || "";
      return {
          email, phone,
          linkedin: linkedin ? "https://" + linkedin.replace(/^https?:\/\//, "") : "",
          github: github ? "https://" + github.replace(/^https?:\/\//, "") : "",
          portfolio, website
      };
  }

  function extractName(lines, email) {
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const l = lines[i].trim();
      if (!l || l.length > 40 || /\d/.test(l)) continue;
        if (/resume|curriculum|c\.?v\.?|profile|bewerbung/i.test(l)) continue;
      if (/^[\w.'-]+\s+[\w.'-]+(\s+[\w.'-]+){0,2}$/.test(l)) return l;
    }
    if (email) {
      const part = email.split("@")[0].replace(/[._-]+/g, " ").trim();
      if (part) return part.replace(/\b\w/g, c => c.toUpperCase());
    }
    return "";
  }

    function splitName(full) {
        const parts = (full || "").trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return {first: "", middle: "", last: ""};
        if (parts.length === 1) return {first: parts[0], middle: "", last: ""};
        if (parts.length === 2) return {first: parts[0], middle: "", last: parts[1]};
        return {first: parts[0], middle: parts.slice(1, -1).join(" "), last: parts[parts.length - 1]};
    }

  function extractSkills(text) {
    const lower = text.toLowerCase();
    return SKILLS_LEXICON.filter(s => lower.includes(s));
  }

  function extractYears(text) {
      const m = text.match(/(\d{1,2})\+?\s*(years?|yrs?)\s*(of\s*)?(experience|exp|jahre)/i);
    return m ? parseInt(m[1], 10) : "";
  }

    function extractAddress(text) {
        // "City, ST", "City, Country", "Street 12, 10115 Berlin", ZIP...
        const locMatch = text.match(/([A-Z][a-z\u00C0-\u024F]+(?:\s+[A-Z][a-z\u00C0-\u024F]+)?,\s*(?:[A-Z]{2}|[A-Z][a-z\u00C0-\u024F]+(?:\s+[A-Z][a-z\u00C0-\u024F]+)?))/) || null;
        // ZIP only in address context (avoid grabbing years like 2021).
        const zipMatch = text.match(/\b\d{5}\b(?=.*(?:Berlin|Germany|street|address|zip|postal|plz))/is)
            || text.match(/\b\d{5}(?:\s*[-–]\s*\d{3,4})?\b.*(?:street|address|zip|postal|plz)/is)
            || null;
        const streetMatch = text.match(/^.*\b\d{1,5}\s+[A-Z][a-z]+\s+(Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Weg|Stra\u00DFe|Str\.|Gasse)\b.*$/mi) || null;
        // Real countries only — never cities, never "Remote".
        const countryMatch = text.match(/\b(Germany|Deutschland|France|Spain|Italy|Netherlands|Poland|Austria|Switzerland|United States|USA|United Kingdom|UK|Canada|India)\b/i) || null;
        return {
            location: locMatch ? locMatch[0].trim() : "",
            city: locMatch ? locMatch[1].split(",")[0].trim() : "",
            zip: zipMatch ? zipMatch[0].trim() : "",
            street: streetMatch ? streetMatch[0].trim().slice(0, 120) : "",
            country: countryMatch ? countryMatch[0].trim() : ""
        };
    }

    function extractEducation(text) {
        const degree = (text.match(/\b(B\.?Sc\.?|M\.?Sc\.?|Bachelor|Master|MBA|Ph\.?D|Diplom|B\.?Eng|M\.?Eng|B\.?A\.|M\.?A\.)\b[^,\n]{0,60}/i) || [])[0] || "";
        const uni = (text.match(/\b(University|Universit\u00E4t|Hochschule|College|Institute|School)\b[^,\n]{0,60}/i) || [])[0] || "";
        const gradYear = (text.match(/\b(19|20)\d{2}\b/g) || []).slice(-3).join(", ");
        return {degree: degree.trim().slice(0, 120), university: uni.trim().slice(0, 120), gradYear};
    }

    /** Main entry: raw resume text -> profile object. Pure local. */
  function parseResumeText(rawText) {
    const text = (rawText || "").replace(/\r/g, "").trim();
    const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
    const contacts = extractContacts(text);
    const fullName = extractName(lines, contacts.email);
        const {first: firstName, middle: middleName, last: lastName} = splitName(fullName);
    const skills = extractSkills(text);
    const yearsExperience = extractYears(text);
        const addr = extractAddress(text);
        const edu = extractEducation(text);
    const summary = lines.slice(0, 12).join(" ").slice(0, 800);

    const work = [];
    const expLines = text.split(/\n/).filter(l => /\b(19|20)\d{2}\b/.test(l)).slice(0, 5);
    for (const l of expLines) work.push({ raw: l.slice(0, 200) });

        // Best-effort current title/company: "Title at Company, dates"
        let currentTitle = "", currentCompany = "";
        const atMatch = text.match(/^(.{2,60}?)\s+(?:at|bei|@)\s+(.{2,60}?)(?:,|\s+(?:19|20)\d{2}|\n)/im);
        if (atMatch) {
            currentTitle = atMatch[1].trim().slice(0, 80);
            currentCompany = atMatch[2].trim().slice(0, 80);
        }

    return {
        version: 2,
      updatedAt: new Date().toISOString(),
      rawText: text.slice(0, 20000),
      personal: {
          fullName, firstName, middleName, lastName, preferredName: firstName,
        email: contacts.email, phone: contacts.phone,
          location: addr.location, city: addr.city, street: addr.street, zip: addr.zip, country: addr.country,
        linkedin: contacts.linkedin, github: contacts.github,
        portfolio: contacts.portfolio || contacts.website
      },
        professional: {
            summary, skills, yearsExperience,
            currentTitle, currentCompany,
            degree: edu.degree, university: edu.university, gradYear: edu.gradYear,
            work
        },
      answers: {
        authorizedToWork: "",
        needSponsorship: "",
          willingToRelocate: "",
        veteranStatus: "prefer-not-to-say"
      }
    };
  }

    // ---------------- field brain ----------------
    // Each rule: key, autocomplete tokens, regexes tested against every signal,
    // value getter, optional generative flag (needs composing, not copying).

  const FIELD_RULES = [
      // identity — most specific first
      {
          key: "firstName",
          ac: ["given-name", "fname"],
          re: [/first.?name|given.?name|vorname|pr[e\u00E9]nom|nombre/i, /\bfname\b|\bfirst\b/i],
          get: p => p.personal.firstName
      },
      {
          key: "lastName",
          ac: ["family-name"],
          re: [/last.?name|family.?name|surname|nachname|nom de famille|apellido/i, /\blname\b|\blast\b/i],
          get: p => p.personal.lastName
      },
      {
          key: "middleName",
          ac: ["additional-name"],
          re: [/middle.?name|zweiter.?name/i],
          get: p => p.personal.middleName
      },
      {
          key: "fullName",
          ac: ["name"],
          re: [/full.?name|^name$|complete.?name|your.?name|fuller.?name|applicant.?name/i],
          get: p => p.personal.fullName
      },
      {
          key: "preferredName",
          ac: ["nickname"],
          re: [/preferred.?name|nickname|preferred.?first|rufname/i],
          get: p => p.personal.preferredName || p.personal.firstName
      },
      // contact
      {key: "email", ac: ["email"], re: [/e-?mail/i], get: p => p.personal.email},
      {
          key: "emailConfirm",
          ac: [],
          re: [/confirm.?e-?mail|re-?enter.?e-?mail|verify.?e-?mail/i],
          get: p => p.personal.email
      },
      {
          key: "phone",
          ac: ["tel", "tel-national", "tel-country-code"],
          re: [/phone|mobile|tel|telefon|handy|telephone|t[e\u00E9]l[e\u00E9]phone|tel[e\u00E9]fono/i],
          get: p => p.personal.phone
      },
      // address (never steal "email address" — that belongs to email)
      {
          key: "street",
          ac: ["street-address", "address-line1"],
          not: [/e-?mail/i],
          re: [/street|address.?line.?1|stra\u00DFe|adresse|stra\u00DFe.*nr|house.?number/i, /\baddress\b(?!.*line.?2)/i],
          get: p => p.personal.street || p.personal.location
      },
      {key: "address2", ac: ["address-line2"], re: [/address.?line.?2|apt|suite|address.?2/i], get: () => ""},
      {
          key: "city",
          ac: ["address-level2", "city"],
          not: [/e-?mail/i],
          re: [/\bcity\b|town|ort|stadt|ville|ciudad/i],
          get: p => p.personal.city || p.personal.location
      },
      {key: "state", ac: ["address-level1", "state"], re: [/\bstate\b|province|region|bundesland/i], get: () => ""},
      {
          key: "zip",
          ac: ["postal-code", "zip"],
          re: [/zip|postal|plz|postleitzahl|code.?postal/i],
          get: p => p.personal.zip
      },
      {
          key: "country",
          ac: ["country", "country-name"],
          re: [/country|land|pays|pa[i\u00ED]s/i],
          get: p => p.personal.country
      },
      {
          key: "location",
          ac: ["city"],
          not: [/e-?mail/i],
          re: [/location|current.?location|address|city/i],
          get: p => p.personal.location || [p.personal.city, p.personal.country].filter(Boolean).join(", ")
      },
      // links (specific networks first — generic "url/website" must never steal them)
      {key: "linkedin", ac: ["url"], re: [/linkedin/i], get: p => p.personal.linkedin},
      {key: "github", ac: ["url"], re: [/github/i], get: p => p.personal.github},
      {
          key: "portfolio",
          ac: ["url"],
          re: [/portfolio|personal.?site|homepage|blog|personal.?website/i, /website|web.?site/i],
          get: p => p.personal.portfolio || p.personal.github || p.personal.linkedin
      },
      // professional
      {
          key: "currentTitle",
          ac: ["organization-title"],
          re: [/current.?title|job.?title|position|desired.?title|most.?recent.?title|aktuelle.*position/i],
          get: p => p.professional.currentTitle
      },
      {
          key: "currentCompany",
          ac: ["organization"],
          re: [/current.?company|employer|current.?employer|firma|unternehmen/i],
          get: p => p.professional.currentCompany || (p.professional.work?.[0]?.raw || "")
      },
      {
          key: "years",
          ac: [],
          re: [/years?.*exper|experience.*years|wie.*jahre|total.?experience|exp.?years|ann[e\u00E9]es?.*exp/i],
          get: p => p.professional.yearsExperience
      },
      {
          key: "experience",
          ac: [],
          re: [/relevant.?experience|work.?experience|professional.?experience|berufserfahrung/i],
          get: p => (p.professional.yearsExperience !== "" ? String(p.professional.yearsExperience) + " years" : "") || p.professional.summary.slice(0, 500)
      },
      {
          key: "summary",
          ac: [],
          re: [/summary|about.?you|bio|profile|professional.?summary|tell.?us.?about.?yourself|kurzprofil/i],
          get: p => p.professional.summary,
          generative: false
      },
      {
          key: "skills",
          ac: [],
          re: [/skills?|key.?skills|technical.?skills|kenntnisse/i],
          get: p => (p.professional.skills || []).join(", ")
      },
      {
          key: "degree",
          ac: [],
          re: [/degree|education|abschluss|diploma|qualification/i],
          get: p => p.professional.degree
      },
      {
          key: "university",
          ac: [],
          re: [/university|college|school|hochschule|universit/i],
          get: p => p.professional.university
      },
      {
          key: "gradYear",
          ac: [],
          re: [/graduat|class.?of|year.?of.?graduation|abschlussjahr/i],
          get: p => p.professional.gradYear
      },
      {key: "languages", ac: ["language"], re: [/languages?|spoken.?languages|sprach/i], get: () => ""},
      {
          key: "salary",
          ac: [],
          re: [/salary|compensation|expected.?ctc|gehaltsvorstellung|gehalt|pay.?expect|salaire|salario/i],
          get: () => ""
      },
      {
          key: "notice",
          ac: [],
          re: [/notice.?period|start.?date|earliest.?start|k\u00FCndigungsfrist|verf\u00FCgbar/i],
          get: () => ""
      },
      // work authorization / EEO
      {
          key: "auth",
          ac: [],
          re: [/authori[sz]ed.*work|work.*authori|legally.*work|right.?to.?work|arbeitserlaubnis|eligible.?to.?work/i],
          get: p => p.answers.authorizedToWork || "yes"
      },
      {
          key: "sponsorship",
          ac: [],
          re: [/sponsor|visa.*sponsor|require.*sponsor/i],
          get: p => p.answers.needSponsorship || "no"
      },
      {key: "visa", ac: [], re: [/\bvisa\b|work.?permit|immigration.?status/i], get: () => ""},
      {key: "relocate", ac: [], re: [/relocat|willing.*move|umzug/i], get: p => p.answers.willingToRelocate || "yes"},
      {key: "gender", ac: ["sex"], re: [/\bgender\b|geschlecht|sexo|sexe/i], get: () => ""},
      {key: "race", ac: [], re: [/\brace\b|ethnicity|ethnie/i], get: () => ""},
      {key: "veteran", ac: [], re: [/veteran/i], get: p => "prefer-not-to-say"},
      {key: "disability", ac: [], re: [/disabilit/i], get: () => ""},
      // generative free-text (LLM or local template fills these)
      {
          key: "coverLetter",
          ac: [],
          re: [/cover.?letter|anschreiben|letter.?of.?motivation/i],
          get: () => "",
          generative: true
      },
      {
          key: "whyFit",
          ac: [],
          re: [/why.*fit|why.*you|why.*hire|why.*should|motivation|what.*motivates|pitch/i],
          get: () => "",
          generative: true
      },
      {
          key: "whyCompany",
          ac: [],
          re: [/why.*(company|us|this.?role)|interest.*(role|position|company)/i],
          get: () => "",
          generative: true
      },
      {
          key: "additionalInfo",
          ac: [],
          re: [/additional.?info|anything.?else|comments|is.?there.*else|equal.?opportunit|demographic/i],
          get: () => "",
          generative: true
      },
  ];

    const SKIP_RE = /search|captcha|password|passwd|pwd|credit.?card|card.?number|cvv|cvc|ssn|social.?security|card.?expir/i;

    function norm(s) {
        return (s || "").toLowerCase().replace(/[_-]+/g, " ").replace(/[*:\-–—()[\]{}"'.?,#\/\\|]/g, " ").replace(/\s+/g, " ").trim();
    }

    function humanizeToken(tok) {
        return norm(String(tok || "").replace(/^(job[_-]?application\[?|application\[?|applicant[_-]?|candidate[_-]?|user[_-]?|profile[_-]?)/, "").replace(/\]$/g, ""));
    }

    function matchScore(rule, sig) {
        // negative guard first (e.g. address must not steal "email address")
        const allText = [sig.label, sig.name, sig.id, sig.placeholder, sig.testId].join(" ");
        if (rule.not && rule.not.some(re => {
            re.lastIndex = 0;
            return re.test(allText);
        })) return null;
        // autocomplete attribute is the strongest signal (explicit standard)
        const ac = norm(sig.autocomplete);
        if (ac && rule.ac.some(a => ac === a || ac.includes(a))) return {score: 1.0, via: "autocomplete"};
        const fields = [
            {v: sig.label, w: 0.95},
            {v: sig.aria, w: 0.9},
            {v: sig.name, w: 0.85},
            {v: sig.id, w: 0.85},
            {v: sig.testId, w: 0.8},
            {v: sig.placeholder, w: 0.7},
        ];
        let best = 0, via = "";
        for (const {v, w} of fields) {
            const nv = norm(v) + " " + humanizeToken(v);
            if (!nv.trim()) continue;
            for (const re of rule.re) {
                // reset global regex state defensively
                re.lastIndex = 0;
                if (re.test(nv)) {
                    // No length bonus: long alternations must not outrank specific rules.
                    // Ties break by FIELD_RULES order (specific networks first).
                    if (w > best) {
                        best = w;
                        via = "regex";
                    }
                }
            }
        }
        return best > 0 ? {score: Math.min(0.99, best), via} : null;
    }

    /**
     * LLM-grade matching without a network: score every rule against every signal.
     * signals: {label,name,id,placeholder,autocomplete,type,aria,testId}
     */
    function analyzeField(signals, profile) {
        const sig = {
            label: signals?.label || "", name: signals?.name || "", id: signals?.id || "",
            placeholder: signals?.placeholder || "", autocomplete: signals?.autocomplete || "",
            type: signals?.type || "", aria: signals?.aria || signals?.ariaLabel || "",
            testId: signals?.testId || signals?.dataAutomationId || ""
        };
        const hay = [sig.label, sig.name, sig.id, sig.placeholder, sig.type].join(" ");
        if (SKIP_RE.test(hay)) return {key: "skip", value: "", confidence: 1, skip: true};

        let best = null;
        for (const rule of FIELD_RULES) {
            const m = matchScore(rule, sig);
            if (!m) continue;
            const raw = rule.get(profile);
            const value = raw === undefined || raw === null ? "" : String(raw);
            // Candidate ranking: matched score first, then prefer rules that actually have a value.
            const ranked = m.score + (value ? 0.12 : 0) - (rule.generative ? 0.02 : 0);
            if (!best || ranked > best.ranked) best = {
                rule,
                value,
                confidence: Math.min(0.98, m.score - (value ? 0 : 0.45)),
                ranked,
                via: m.via
            };
        }
        if (!best) return {key: "unknown", value: "", confidence: 0.1, needsLLM: true};
        return {
            key: best.rule.key,
            value: best.value,
            confidence: best.value ? Math.max(0.55, best.confidence) : 0.35,
            needsLLM: !best.value || !!best.rule.generative,
            generative: !!best.rule.generative,
            via: best.via
        };
    }

    /** Backwards-compatible: label-only lookup (used by old callers + tests). */
  function mapLabelToProfile(labelText, profile) {
        const r = analyzeField({label: labelText}, profile);
        return {key: r.key, value: r.value, confidence: r.confidence, needsLLM: r.needsLLM};
    }

    // ---------------- local free-text composer (no network) ----------------
    // Acts as the always-available "tiny LLM" for cover/why-fit fields.
    function composeFreeText(kind, profile) {
        const p = profile || {};
        const name = p.personal?.fullName || "";
        const title = p.professional?.currentTitle ? ` (${p.professional.currentTitle})` : "";
        const skills = (p.professional?.skills || []).slice(0, 8).join(", ");
        const years = p.professional?.yearsExperience !== "" && p.professional?.yearsExperience != null ? `${p.professional.yearsExperience}+ years of experience` : "relevant experience";
        const company = p.professional?.currentCompany ? `, most recently at ${p.professional.currentCompany}` : "";
        if (kind === "coverLetter") {
            return `Dear Hiring Manager,\n\nI am excited to apply${title}. I bring ${years}${company}${skills ? ` with strengths in ${skills}` : ""}.\n\n${(p.professional?.summary || "").slice(0, 400)}\n\nThank you for your consideration.\n\nBest regards,\n${name}`.trim();
        }
        if (kind === "whyFit" || kind === "whyCompany") {
            return `I am a strong fit with ${years}${company}${skills ? `, skilled in ${skills}` : ""}. ${(p.professional?.summary || "").slice(0, 300)}`.trim();
        }
        return (p.professional?.summary || "").slice(0, 600);
    }

    // ---------------- per-site disable list ----------------
    // Shared so content.js, popup.js and options.js all match the same way.

    /** "WWW.Example.com:8080/path" / full URLs -> "example.com". "" if unparseable. */
    function normalizeDomain(input) {
        try {
            let s = String(input || "").trim().toLowerCase();
            if (!s) return "";
            if (s.includes("://")) s = new URL(s).hostname;
            else s = s.split("/")[0].split("?")[0].split("#")[0];
            // strip port + trailing dot
            s = s.split(":")[0].replace(/\.+$/, "").trim();
            s = s.replace(/^www\./, "");
            if (!s || !s.includes(".") && s !== "localhost") return s.includes(" ") ? "" : s;
            if (/\s/.test(s)) return "";
            return s;
        } catch {
            return "";
        }
    }

    /** entry "example.com" also covers "jobs.example.com". Exact otherwise. */
    function isSiteDisabled(hostname, disabledList) {
        const d = normalizeDomain(hostname);
        if (!d) return false;
        for (const raw of disabledList || []) {
            const e = normalizeDomain(raw);
            if (!e) continue;
            if (d === e || d.endsWith("." + e)) return true;
    }
        return false;
  }

    return {
        parseResumeText,
        mapLabelToProfile,
        analyzeField,
        composeFreeText,
        humanizeToken,
        normalizeDomain,
        isSiteDisabled,
        FIELD_RULES
    };
})();

if (typeof window !== "undefined") window.ResumeAutofill = ResumeAutofill;
if (typeof self !== "undefined") self.ResumeAutofill = ResumeAutofill;
if (typeof module !== "undefined" && module.exports) module.exports = ResumeAutofill;
