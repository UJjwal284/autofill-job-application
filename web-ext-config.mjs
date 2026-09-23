// web-ext config: `npx web-ext lint` / `npx web-ext build`.
// Keep personal data and dev-only files OUT of the store package.
export default {
  sourceDir: ".",
  artifactsDir: "web-ext-artifacts",
  ignoreFiles: [
    "profiles/**",
    "node_modules/**",
    "web-ext-artifacts/**",
    "web-ext-config.mjs",
    "package.json",
    "package-lock.json",
    ".git/**",
    ".gitignore",
    ".idea/**",
    ".vscode/**",
    "test-page.html",
    "test/**",
    "README.md",
    ".amo-upload-uuid",
    "*.xpi",
  ],
};
