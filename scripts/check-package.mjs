// Release hygiene gate: package metadata must be consistent before a release candidate.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const problems = [];

if (lock.version !== pkg.version) problems.push(`package-lock.json version ${lock.version} != package.json ${pkg.version}`);
if (lock.packages?.[""]?.version !== pkg.version) problems.push(`package-lock.json root package version ${lock.packages?.[""]?.version} != ${pkg.version}`);
for (const field of ["dependencies", "devDependencies"]) {
  for (const [name, range] of Object.entries(pkg[field] ?? {})) {
    if (lock.packages?.[""]?.[field]?.[name] !== range) problems.push(`${field}.${name} (${range}) is not reflected in package-lock.json`);
  }
}
if (pkg.bin?.["playwright-generate-mcp"] !== "dist/index.js") problems.push("bin entry must point to dist/index.js");

if (problems.length > 0) {
  console.error(`Package metadata check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Package metadata consistent (version ${pkg.version}).`);
