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

console.log("smoke: all assertions passed");
