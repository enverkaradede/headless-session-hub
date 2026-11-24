// Publishes the bundle built on this machine to the GitHub Release v<version> and updates latest.json,
// the manifest the in-app updater reads. Run after `pnpm bundle`, on each platform you ship.
// Needs: gh (logged in), the signed bundle (TAURI_SIGNING_PRIVATE_KEY was set during `pnpm bundle`).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "enverkaradede/headless-session-hub";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(root, "target", "release", "bundle");
const { version } = JSON.parse(readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8"));
const tag = `v${version}`;

const gh = (args, options = {}) => execFileSync("gh", args, { cwd: root, encoding: "utf8", ...options });

/** Updater artifacts per platform: the installer/archive and its .sig next to it. */
function findArtifacts() {
  const candidates = [
    { dir: "nsis", match: (name) => name.endsWith("-setup.exe"), platform: "windows-x86_64" },
    { dir: "macos", match: (name) => name.endsWith(".app.tar.gz"), platform: process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64" },
    { dir: "appimage", match: (name) => name.endsWith(".AppImage"), platform: "linux-x86_64" },
  ];
  const found = [];
  for (const candidate of candidates) {
    const dir = path.join(bundleDir, candidate.dir);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!candidate.match(name) || !name.includes(version)) continue;
      const file = path.join(dir, name);
      const signature = `${file}.sig`;
      if (!existsSync(signature)) throw new Error(`${name} has no .sig: was TAURI_SIGNING_PRIVATE_KEY set during pnpm bundle?`);
      found.push({ platform: candidate.platform, file, signature: readFileSync(signature, "utf8").trim() });
    }
  }
  if (found.length === 0) throw new Error(`no ${version} bundle found under ${bundleDir}; run pnpm bundle first`);
  return found;
}

/** The release notes are this version's CHANGELOG section. */
function releaseNotes() {
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf(`## ${version}`);
  if (start < 0) return `Session Hub ${version}`;
  const rest = changelog.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return rest.slice(0, end < 0 ? undefined : end).join("\n").trim();
}

function releaseExists() {
  try {
    gh(["release", "view", tag, "--repo", REPO], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Merges with the latest.json already on the release so per-platform builds can be published separately. */
function existingManifest(workDir) {
  try {
    gh(["release", "download", tag, "--repo", REPO, "--pattern", "latest.json", "--dir", workDir, "--clobber"], { stdio: "ignore" });
    return JSON.parse(readFileSync(path.join(workDir, "latest.json"), "utf8"));
  } catch {
    return null;
  }
}

const artifacts = findArtifacts();
const notes = releaseNotes();
const workDir = mkdtempSync(path.join(tmpdir(), "hub-release-"));

if (!releaseExists()) {
  const notesFile = path.join(workDir, "notes.md");
  writeFileSync(notesFile, notes);
  gh(["release", "create", tag, "--repo", REPO, "--title", `Session Hub ${version}`, "--notes-file", notesFile], { stdio: "inherit" });
}

const manifest = existingManifest(workDir) ?? { version, notes, pub_date: new Date().toISOString(), platforms: {} };
manifest.version = version;
manifest.notes = notes;
manifest.pub_date = new Date().toISOString();
for (const artifact of artifacts) {
  const asset = path.basename(artifact.file).replaceAll(" ", ".");
  manifest.platforms[artifact.platform] = {
    signature: artifact.signature,
    url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(asset)}`,
  };
}
const manifestFile = path.join(workDir, "latest.json");
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

// GitHub replaces spaces in asset names with dots; the manifest URLs above use the same rule.
gh(["release", "upload", tag, "--repo", REPO, "--clobber", ...artifacts.map((artifact) => artifact.file), manifestFile], { stdio: "inherit" });
console.log(`Published ${artifacts.map((artifact) => artifact.platform).join(", ")} to ${tag}.`);
