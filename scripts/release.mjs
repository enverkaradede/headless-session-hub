// Publishes the bundle built on this machine to the GitHub Release v<version> and updates latest.json,
// the manifest the in-app updater reads. Run after `pnpm bundle`, on each platform you ship.
// Needs: gh (logged in), the signed bundle (TAURI_SIGNING_PRIVATE_KEY was set during `pnpm bundle`).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "enverkaradede/headless-session-hub";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8"));
const tag = `v${version}`;

const gh = (args, options = {}) => execFileSync("gh", args, { cwd: root, encoding: "utf8", ...options });

/** Updater platform key for each Rust target triple that `pnpm bundle --target` can produce. */
const PLATFORM_BY_TRIPLE = {
  "x86_64-pc-windows-msvc": "windows-x86_64",
  "aarch64-pc-windows-msvc": "windows-aarch64",
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
};
/**
 * Updater artifacts per bundle folder. macOS names its updater archive without a version, so the version is
 * read from the .app it was made from, and the asset gets a versioned, per-architecture name.
 */
const UPDATER_ARTIFACTS = [
  { dir: "nsis", match: (name) => name.endsWith("-setup.exe") && name.includes(version) },
  { dir: "macos", match: (name) => name.endsWith(".app.tar.gz") },
  { dir: "appimage", match: (name) => name.endsWith(".AppImage") && name.includes(version) },
];
/** First-install files that are not updater artifacts (Windows' setup.exe is both). */
const INSTALLERS = [{ dir: "dmg", match: (name) => name.endsWith(".dmg") && name.includes(`_${version}_`) }];

/** GitHub turns spaces in asset names into dots; naming assets that way keeps manifest URLs exact. */
const assetName = (name) => name.replaceAll(" ", ".");

function appVersion(appTarGz) {
  const plist = path.join(appTarGz.replace(/\.tar\.gz$/, ""), "Contents", "Info.plist");
  if (!existsSync(plist)) return null;
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"));
  return match?.[1] ?? null;
}

/** Signed updater artifacts and installers under target/<triple>/release/bundle for this version. */
function findArtifacts() {
  const targetDir = path.join(root, "target");
  const updaters = [];
  const installers = [];
  for (const triple of existsSync(targetDir) ? readdirSync(targetDir) : []) {
    const platform = PLATFORM_BY_TRIPLE[triple];
    const bundleDir = path.join(targetDir, triple, "release", "bundle");
    if (!platform || !existsSync(bundleDir)) continue;
    for (const kind of UPDATER_ARTIFACTS) {
      const dir = path.join(bundleDir, kind.dir);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!kind.match(name)) continue;
        const file = path.join(dir, name);
        let asset = assetName(name);
        if (kind.dir === "macos") {
          const built = appVersion(file);
          if (built !== version) {
            console.warn(`skipping ${file}: it was built as ${built ?? "an unknown version"}, not ${version}`);
            continue;
          }
          asset = assetName(`${name.replace(/\.app\.tar\.gz$/, "")}_${version}_${platform.split("-")[1]}.app.tar.gz`);
        }
        const signature = `${file}.sig`;
        if (!existsSync(signature)) throw new Error(`${name} has no .sig: was the signing key loaded during pnpm bundle?`);
        updaters.push({ platform, file, asset, signature: readFileSync(signature, "utf8").trim() });
      }
    }
    for (const kind of INSTALLERS) {
      const dir = path.join(bundleDir, kind.dir);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter(kind.match)) installers.push({ file: path.join(dir, name), asset: assetName(name) });
    }
  }
  if (updaters.length === 0) throw new Error(`no ${version} bundle found under target/<triple>/release/bundle; run pnpm bundle first`);
  return { updaters, installers };
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

const { updaters: artifacts, installers } = findArtifacts();
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
  manifest.platforms[artifact.platform] = {
    signature: artifact.signature,
    url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(artifact.asset)}`,
  };
}
const manifestFile = path.join(workDir, "latest.json");
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

// Upload copies under their asset names, so what the manifest points at is exactly what is uploaded.
const uploads = [...artifacts, ...installers].map(({ file, asset }) => {
  const copy = path.join(workDir, asset);
  copyFileSync(file, copy);
  return copy;
});
gh(["release", "upload", tag, "--repo", REPO, "--clobber", ...uploads, manifestFile], { stdio: "inherit" });
console.log(`Published ${artifacts.map((artifact) => artifact.platform).join(", ")} to ${tag}.`);
