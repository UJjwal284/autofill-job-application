/* Smoke test: resume parser + LLM-grade field brain. Run: npm test (node, no deps). */
const assert = require("node:assert/strict");
const ResumeAutofill = require("../src/lib/profile.js");

const SAMPLE = `Jane Marie Doe
DevOps Engineer | Berlin, Germany
jane.doe@example.com | +49 170 1234567 | linkedin.com/in/janedoe | github.com/janedoe
Senior DevOps Engineer at ExampleCorp, 2021 - Present
5+ years of experience with AWS, Kubernetes, Terraform and Python.
Skills: AWS, Kubernetes, Terraform, Python, Docker, Jenkins, Git, Linux
`;

const profile = ResumeAutofill.parseResumeText(SAMPLE);
assert.equal(profile.version, 2);
assert.equal(profile.personal.fullName, "Jane Marie Doe");
assert.equal(profile.personal.firstName, "Jane");
assert.equal(profile.personal.middleName, "Marie");
assert.equal(profile.personal.email, "jane.doe@example.com");
assert.match(profile.personal.phone, /170/);
assert.equal(profile.personal.location, "Berlin, Germany");
assert.ok(profile.personal.linkedin.includes("linkedin.com/in/janedoe"));
assert.ok(profile.personal.github.includes("github.com/janedoe"));
assert.ok(profile.professional.skills.includes("kubernetes"));
assert.ok(profile.professional.skills.includes("terraform"));
assert.equal(profile.professional.yearsExperience, 5);

const map = (label) => ResumeAutofill.mapLabelToProfile(label, profile);
assert.equal(map("Email address").value, "jane.doe@example.com");
assert.equal(map("Phone").value, profile.personal.phone);
assert.equal(map("Full name").value, "Jane Marie Doe");
assert.equal(map("First name").value, "Jane");
assert.equal(map("LinkedIn URL").value, profile.personal.linkedin);
assert.ok(map("Years of experience").value.toString().includes("5"));
assert.ok(map("Skills").value.toLowerCase().includes("kubernetes"));
assert.equal(map("Some random unknown field xyz").value, "");
assert.equal(map("Some random unknown field xyz").confidence, 0.1);
// Sensitive-field skipping lives in content.js (SKIP_RE), not the mapper.
assert.doesNotThrow(() => map("Password"));
assert.doesNotThrow(() => map("Credit card number"));

// --- new signal-based brain: name/id/autocomplete/testId, ATS quirks ---
const analyze = (s) => ResumeAutofill.analyzeField(s, profile);
assert.equal(analyze({label: "", name: "fname"}).key, "firstName");
assert.equal(analyze({label: "", name: "fname"}).value, "Jane");
assert.equal(analyze({label: "", name: "job_application[first_name]"}).key, "firstName");
assert.equal(analyze({label: "", name: "lname", id: "last"}).value, "Doe");
assert.equal(analyze({label: "", autocomplete: "email"}).value, "jane.doe@example.com");
assert.equal(analyze({label: "Email", autocomplete: "email"}).confidence >= 0.98, true);
assert.equal(analyze({label: "Vorname"}).key, "firstName");
assert.equal(analyze({label: "Nachname"}).key, "lastName");
assert.equal(analyze({label: "LinkedIn profile"}).key, "linkedin");
assert.equal(analyze({label: "", name: "", testId: "phone-number"}).key, "phone");
assert.equal(analyze({label: "", name: "city"}).key, "city");
assert.equal(analyze({label: "Are you authorized to work in the US?"}).key, "auth");
assert.equal(analyze({label: "Will you require sponsorship?"}).key, "sponsorship");
// generative fields are flagged, not silently empty
const cover = analyze({label: "Cover letter"});
assert.equal(cover.key, "coverLetter");
assert.equal(cover.generative, true);
assert.ok(cover.needsLLM);
// skips
assert.equal(analyze({label: "Password", name: "pwd", type: "password"}).skip, true);
assert.equal(analyze({label: "Search jobs", name: "q"}).skip, true);
// local composer (built-in tiny LLM) always produces a draft
const draft = ResumeAutofill.composeFreeText("coverLetter", profile);
assert.ok(draft.includes("Jane Marie Doe"));
assert.ok(draft.length > 50);

// --- global learning: one correction applies on ALL sites ---
assert.equal(ResumeAutofill.learnKeyFor("firstName", "First name"), "field::firstName");
assert.equal(ResumeAutofill.learnKeyFor("unknown", "Custom question?"), "label::custom question");
assert.equal(ResumeAutofill.learnKeyFor("", "fname"), "label::fname");
// field-keyed lookup generalizes across different labels for the same field
const learnedGlobal = {
    "field::firstName": {
        value: "Janey",
        fieldKey: "firstName",
        label: "First name",
        domain: "site-a.com",
        domains: ["site-a.com"],
        count: 2,
        updatedAt: "2026-01-01T00:00:00.000Z"
    }
};
const hitA = ResumeAutofill.lookupLearned(learnedGlobal, {
    label: "Vorname",
    name: "fname"
}, analyze({label: "Vorname"}));
assert.ok(hitA && hitA.entry.value === "Janey");
const hitB = ResumeAutofill.lookupLearned(learnedGlobal, {label: "First name"}, {key: "firstName"});
assert.equal(hitB.key, "field::firstName");
// label fallback covers unknown fields globally (no domain scoping)
const learnedLabel = {
    "label::custom question": {
        value: "42",
        label: "Custom question",
        count: 1,
        updatedAt: "2026-01-01T00:00:00.000Z"
    }
};
assert.equal(ResumeAutofill.lookupLearned(learnedLabel, {label: "Custom question?"}, {key: "unknown"}).entry.value, "42");
// migration: legacy per-site keys fold into global keys (latest wins, counts summed)
const legacy = {
    "site-a.com||First name": {
        value: "Janey",
        label: "First name",
        domain: "site-a.com",
        count: 1,
        updatedAt: "2026-01-01T00:00:00.000Z"
    },
    "site-b.com||First name": {
        value: "Jane",
        label: "First name",
        domain: "site-b.com",
        count: 2,
        updatedAt: "2026-02-01T00:00:00.000Z"
    }
};
const {store: migrated, changed} = ResumeAutofill.migrateLearned(legacy);
assert.equal(changed, true);
assert.ok(!Object.keys(migrated).some(k => k.includes("||")));
assert.equal(migrated["label::first name"].value, "Jane");
assert.equal(migrated["label::first name"].count, 3);
assert.ok(migrated["label::first name"].domains.includes("site-a.com"));

// --- Ujjwal resume (DevOps, ALL-CAPS name, pipe + two-line experience, Colleges) ---
const UJJWAL = `UJJWAL PRATAP RATNAKAR
Gurgaon, Haryana, India
ujjwalpr28@protonmail.com | +91 8901252008 | LinkedIn | GitHub
PROFESSIONAL SUMMARY
DevOps and Platform Engineer with 4+ years of experience building, automating, deploying, and operating cloud-native enterprise applications and infrastructure. Hands-on experience with AWS, Kubernetes, OpenShift, Docker, Jenkins, Helm, Terraform, Linux, and CI/CD.
TECHNICAL SKILLS
Cloud: AWS, EC2, VPC, IAM, S3, RDS, ALB, Auto Scaling, CloudFront, WAF, Route 53, CloudWatch
Containers & Orchestration: Kubernetes, OpenShift (OCP), Docker, Helm, ConfigMaps, Secrets
Backend & Database: Java, Spring Boot, Node.js, Express, REST APIs, SQL, PostgreSQL, Oracle, MySQL
Frontend: ReactJS, AngularJS
Build & Development: Gradle, Maven, Git
AI / GenAI: Ollama, ChromaDB, RAG, Vector Databases, Sentence Transformers, FastAPI, Prompt Engineering
PROFESSIONAL EXPERIENCE
Senior Software Engineer - DevOps & Platform
Incedo Inc., Gurgaon | Apr 2024 - Present
Software Engineer - Cloud & Backend
Incedo Inc., Gurgaon | Jun 2022 - Apr 2024
EDUCATION
Bachelor of Technology in Information Technology
Chandigarh Group of Colleges, Landran, Punjab`;
const up = ResumeAutofill.parseResumeText(UJJWAL);
assert.equal(up.personal.fullName, "Ujjwal Pratap Ratnakar");
assert.equal(up.personal.firstName, "Ujjwal");
assert.equal(up.personal.middleName, "Pratap");
assert.equal(up.personal.lastName, "Ratnakar");
assert.equal(up.personal.email, "ujjwalpr28@protonmail.com");
assert.match(up.personal.phone, /8901252008/);
assert.equal(up.personal.location, "Gurgaon, Haryana, India");
assert.equal(up.personal.city, "Gurgaon");
assert.equal(up.personal.country, "India");
assert.equal(up.professional.yearsExperience, 4);
assert.equal(up.professional.currentTitle, "Senior Software Engineer - DevOps & Platform");
assert.equal(up.professional.currentCompany, "Incedo Inc.");
assert.ok(up.professional.degree.includes("Bachelor of Technology"));
assert.ok(up.professional.university.includes("Chandigarh Group of Colleges"));
assert.equal(up.professional.gradYear, "");
assert.ok(up.professional.summary.startsWith("DevOps and Platform Engineer"));
assert.ok(!up.professional.summary.includes("UJJWAL"));
for (const s of ["kubernetes", "terraform", "cloudfront", "waf", "alb", "auto scaling", "fastapi", "prompt engineering", "sentence transformers", "gradle", "maven", "rest apis", "oracle", "mysql", "angularjs", "ollama", "chromadb", "rag"]) {
    assert.ok(up.professional.skills.includes(s), `missing skill: ${s}`);
}
assert.ok(!up.professional.skills.includes("figma"), "figma must not match ConfigMaps");
// single-line pipe variant: "Title | Company, Loc | dates"
const up2 = ResumeAutofill.parseResumeText(
    "Jane Marie Doe\nDevOps Engineer | Berlin, Germany\njane.doe@example.com | +49 170 1234567\nPROFESSIONAL SUMMARY\nDevOps Engineer with 5+ years of experience.\nPROFESSIONAL EXPERIENCE\nSenior DevOps Engineer | ExampleCorp, Berlin | Apr 2024 - Present\nEDUCATION\nBachelor of Science\nSome University"
);
assert.equal(up2.professional.currentTitle, "Senior DevOps Engineer");
assert.equal(up2.professional.currentCompany, "ExampleCorp");
assert.equal(up2.personal.location, "Berlin, Germany");

console.log("smoke: all assertions passed");
