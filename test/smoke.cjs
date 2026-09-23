/* Smoke test: resume parser + field mapping. Run: npm test (node, no deps). */
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
assert.equal(profile.version, 1);
assert.equal(profile.personal.fullName, "Jane Marie Doe");
assert.equal(profile.personal.firstName, "Jane");
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
// The mapper must simply not crash on such labels:
assert.doesNotThrow(() => map("Password"));
assert.doesNotThrow(() => map("Credit card number"));

console.log("smoke: all assertions passed");
