/* Shared profile + mapping logic (loaded before content.js, also usable in popup via import). */

const ResumeAutofill = (() => {
  const SKILLS_LEXICON = [
    "javascript","typescript","python","java","go","rust","c++","c#","sql","react","reactjs","angular","vue",
    "node","node.js","express","django","flask","spring","spring boot","aws","ec2","vpc","iam","s3","rds","cloudwatch","route 53",
    "azure","gcp","docker","kubernetes","openshift","helm","terraform","jenkins","git","linux",
    "postgresql","oracle db","ollama","chromadb","rag","vector databases","ci/cd","sre","observability",
    "selenium","playwright","figma","photoshop","excel","salesforce","hubspot","sap",
    "machine learning","data analysis","project management","agile","scrum","communication",
    "leadership","customer service","marketing","seo","accounting","autocad","matlab"
  ];

  function extractContacts(text) {
    const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || "";
    const phone = (text.match(/(\+?\d[\d\s\-().]{7,}\d)/) || [])[0]?.trim() || "";
    const linkedin = (text.match(/(?:linkedin\.com\/in\/[A-Za-z0-9\-_%.]+|linkedin\.com\/[A-Za-z0-9\-_]+)/i) || [])[0] || "";
    const github = (text.match(/github\.com\/[A-Za-z0-9\-_]+/i) || [])[0] || "";
    const portfolio = (text.match(/https?:\/\/[^\s)>,"]+\.(dev|io|me|com|portfolio[^\s]*)/i) || [])[0] || "";
    const website = (text.match(/https?:\/\/[^\s)>,"]+/i) || [])[0] || "";
    return { email, phone, linkedin: linkedin ? "https://" + linkedin.replace(/^https?:\/\//, "") : "", github: github ? "https://" + github : "", portfolio, website };
  }

  function extractName(lines, email) {
    // Heuristic: first non-empty line with 2-4 words, no digits, not "resume/cv".
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const l = lines[i].trim();
      if (!l || l.length > 40 || /\d/.test(l)) continue;
      if (/resume|curriculum|c\.?v\.?/i.test(l)) continue;
      if (/^[\w.'-]+\s+[\w.'-]+(\s+[\w.'-]+){0,2}$/.test(l)) return l;
    }
    if (email) {
      const part = email.split("@")[0].replace(/[._-]+/g, " ").trim();
      if (part) return part.replace(/\b\w/g, c => c.toUpperCase());
    }
    return "";
  }

  function extractSkills(text) {
    const lower = text.toLowerCase();
    return SKILLS_LEXICON.filter(s => lower.includes(s));
  }

  function extractYears(text) {
    const m = text.match(/(\d{1,2})\+?\s*(years?|yrs?)\s*(of\s*)?(experience|exp)/i);
    return m ? parseInt(m[1], 10) : "";
  }

  /** Main entry: raw resume text -> profile object. Pure local, no LLM needed. */
  function parseResumeText(rawText) {
    const text = (rawText || "").replace(/\r/g, "").trim();
    const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
    const contacts = extractContacts(text);
    const fullName = extractName(lines, contacts.email);
    const [firstName = "", ...rest] = fullName.split(/\s+/);
    const lastName = rest.join(" ");
    const skills = extractSkills(text);
    const yearsExperience = extractYears(text);

    // Location: look for "City, ST" or "City, Country" pattern.
    const locMatch = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?,\s*(?:[A-Z]{2}|[A-Z][a-z]+))/);
    const summary = lines.slice(0, 12).join(" ").slice(0, 800);

    // Work: crude split on date ranges.
    const work = [];
    const expLines = text.split(/\n/).filter(l => /\b(19|20)\d{2}\b/.test(l)).slice(0, 5);
    for (const l of expLines) work.push({ raw: l.slice(0, 200) });

    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      rawText: text.slice(0, 20000),
      personal: {
        fullName, firstName, lastName,
        email: contacts.email, phone: contacts.phone,
        location: locMatch ? locMatch[0] : "",
        linkedin: contacts.linkedin, github: contacts.github,
        portfolio: contacts.portfolio || contacts.website
      },
      professional: { summary, skills, yearsExperience, work },
      answers: {
        authorizedToWork: "",
        needSponsorship: "",
        veteranStatus: "prefer-not-to-say"
      }
    };
  }

  // ---- Field mapping: label -> profile value ----
  const FIELD_RULES = [
    [/full.?name|^name$/i, p => p.personal.fullName, "fullName"],
    [/first.?name|given.?name|vorname/i, p => p.personal.firstName, "firstName"],
    [/last.?name|family.?name|surname|nachname/i, p => p.personal.lastName, "lastName"],
    [/email|e-mail/i, p => p.personal.email, "email"],
    [/phone|mobile|tel|telefon/i, p => p.personal.phone, "phone"],
    [/linkedin/i, p => p.personal.linkedin, "linkedin"],
    [/github/i, p => p.personal.github, "github"],
    [/portfolio|website|personal.?site|url/i, p => p.personal.portfolio || p.personal.github || p.personal.linkedin, "portfolio"],
    [/location|address|city/i, p => p.personal.location, "location"],
    [/zip|postal|plz/i, p => "", "zip"],
    [/current.?company|employer/i, p => p.professional.work?.[0]?.raw || "", "company"],
    [/current.?title|job.?title|position/i, p => "", "title"],
    [/years?.*exper|experience.*years|wie.*jahre/i, p => p.professional.yearsExperience, "years"],
    [/summary|about.?you|bio|profile/i, p => p.professional.summary, "summary"],
    [/skills?/i, p => (p.professional.skills || []).join(", "), "skills"],
    [/cover.?letter|anschreiben|why.*fit|why.*you|motivation/i, p => "", "coverLetter_needsLLM"],
    [/authori[sz]ed.*work|sind.*arbeitserlaubnis|work.*permit/i, p => p.answers.authorizedToWork || "yes", "auth"],
    [/sponsor/i, p => p.answers.needSponsorship || "no", "sponsorship"],
  ];

  function mapLabelToProfile(labelText, profile) {
    const label = (labelText || "").trim();
    for (const [re, getter, key] of FIELD_RULES) {
      if (re.test(label)) {
        const value = String(getter(profile) ?? "");
        return { key, value, confidence: value ? 0.9 : 0.35, needsLLM: key.includes("needsLLM") || !value };
      }
    }
    return { key: "unknown", value: "", confidence: 0.1, needsLLM: true };
  }

  return { parseResumeText, mapLabelToProfile };
})();

if (typeof window !== "undefined") window.ResumeAutofill = ResumeAutofill;
if (typeof self !== "undefined") self.ResumeAutofill = ResumeAutofill;
if (typeof module !== "undefined" && module.exports) module.exports = ResumeAutofill;
