// Bumps the app version everywhere and opens a CHANGELOG entry.
//   node scripts/version.mjs patch|minor|major|<x.y.z>
// Source of truth: apps/desktop/package.json (tauri.conf.json points at it; the engine injects it at build).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const JSON_FILES = ["package.json", "apps/desktop/package.json", "packages/engine/package.json", "packages/protocol/package.json"];
const CARGO_FILES = ["apps/desktop/src-tauri/Cargo.toml", "crates/hubctl/Cargo.toml"];

function readJson(file) {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

function nextVersion(current, bump) {
  if (SEMVER.test(bump)) return bump;
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`current version ${current} is not x.y.z`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump "${bump}" (use patch, minor, major or x.y.z)`);
}

/** Conventional-commit subjects since the last tag, as a starting point for the release notes. */
function commitsSinceLastTag() {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  let range = "HEAD";
  try {
    range = `${git(["describe", "--tags", "--abbrev=0"])}..HEAD`;
  } catch {
    // no tags yet: whole history
  }
  return git(["log", range, "--pretty=format:%s"])
    .split("\n")
    .filter((subject) => subject && !subject.startsWith("chore(release)"));
}

const bump = process.argv[2];
if (!bump) {
  console.error("usage: node scripts/version.mjs patch|minor|major|<x.y.z>");
  process.exit(2);
}
const current = readJson("apps/desktop/package.json").version;
const version = nextVersion(current, bump);

for (const file of JSON_FILES) {
  const json = readJson(file);
  json.version = version;
  writeFileSync(path.join(root, file), `${JSON.stringify(json, null, 2)}\n`);
}
for (const file of CARGO_FILES) {
  const full = path.join(root, file);
  const text = readFileSync(full, "utf8");
  // Only the [package] version (first `version =` line), never dependency versions.
  writeFileSync(full, text.replace(/^version = "[^"]*"/m, `version = "${version}"`));
}

const changelog = path.join(root, "CHANGELOG.md");
const existing = existsSync(changelog) ? readFileSync(changelog, "utf8") : "# Changelog\n";
const date = new Date().toISOString().slice(0, 10);
const entries = commitsSinceLastTag().map((subject) => `- ${subject}`).join("\n") || "- ";
const [title, ...rest] = existing.split("\n");
writeFileSync(changelog, [title, "", `## ${version} — ${date}`, "", entries, ...rest].join("\n").replace(/\n{3,}/g, "\n\n"));

console.log(`${current} → ${version}`);
console.log("Next: edit CHANGELOG.md, then");
console.log(`  git commit -am "chore(release): v${version}" && git tag -a v${version} -m \"Session Hub ${version}\" && git push --follow-tags`);
console.log("  (Windows VM) pnpm bundle && pnpm release");
