// Builds a release bundle for one target (default on Windows: x86_64, which also runs on Windows-on-ARM).
//   node scripts/prepare-bundle.mjs [--target <rust-triple>]
// It places what ships next to the Tauri binary, then runs `tauri build`:
//   resources/engine/engine.mjs      the engine bundle
//   resources/node/node[.exe]        Node LTS for the TARGET, downloaded from nodejs.org and checked against SHASUMS256
//   binaries/hubctl-<triple>[.exe]   the hubctl sidecar (Tauri externalBin naming)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The app ships this Node LTS line (latest patch), whatever Node the build machine happens to run. */
const BUNDLED_NODE_MAJOR = 24;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "apps", "desktop");
const tauriDir = path.join(desktopDir, "src-tauri");

/**
 * How nodejs.org ships Node for each supported target: Windows as a standalone node.exe, macOS as a tarball
 * whose bin/node is extracted. `indexFile` is the tag in dist/index.json that says the build exists.
 */
const NODE_DIST = {
  "x86_64-pc-windows-msvc": { kind: "exe", dist: "win-x64", indexFile: "win-x64-exe" },
  "aarch64-pc-windows-msvc": { kind: "exe", dist: "win-arm64", indexFile: "win-arm64-exe" },
  "aarch64-apple-darwin": { kind: "tar", dist: "darwin-arm64", indexFile: "osx-arm64-tar" },
  "x86_64-apple-darwin": { kind: "tar", dist: "darwin-x64", indexFile: "osx-x64-tar" },
};

function run(command, args, cwd = root) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function hostTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("host: "));
  if (!line) throw new Error("could not read the host target triple from rustc -vV");
  return line.slice("host: ".length).trim();
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Latest release of the bundled LTS line that nodejs.org ships for this platform. */
async function resolveNodeVersion(spec) {
  const index = await (await fetch("https://nodejs.org/dist/index.json")).json();
  const release = index.find((entry) => entry.version.startsWith(`v${BUNDLED_NODE_MAJOR}.`) && entry.files.includes(spec.indexFile));
  if (!release) throw new Error(`no Node ${BUNDLED_NODE_MAJOR} release with ${spec.indexFile} on nodejs.org`);
  return release.version;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads the bundled Node for the target from nodejs.org and checks it against SHASUMS256.txt. */
async function downloadNode(target, destination) {
  const spec = NODE_DIST[target];
  if (!spec) throw new Error(`no Node download mapping for ${target}`);
  const version = await resolveNodeVersion(spec);
  const base = `https://nodejs.org/dist/${version}`;
  const file = spec.kind === "exe" ? `${spec.dist}/node.exe` : `node-${version}-${spec.dist}.tar.gz`;
  console.log(`> downloading Node ${version} ${file}`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === file)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt for ${version} has no ${file}`);
  const bytes = await download(`${base}/${file}`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Node checksum mismatch for ${file} (expected ${expected}, got ${actual})`);
  console.log(`  verified sha256 ${actual}`);
  if (spec.kind === "exe") {
    writeFileSync(destination, bytes);
  } else {
    const work = mkdtempSync(path.join(tmpdir(), "hub-node-"));
    try {
      const archive = path.join(work, "node.tar.gz");
      writeFileSync(archive, bytes);
      const member = `node-${version}-${spec.dist}/bin/node`;
      run("tar", ["-xzf", archive, "-C", work, member]);
      copyFileSync(path.join(work, member), destination);
      chmodSync(destination, 0o755);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return version;
}

/** Makes sure the Rust standard library for `target` is installed; explains the fix when rustup is missing. */
function ensureRustTarget(target) {
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  if (existsSync(path.join(sysroot, "lib", "rustlib", target))) return;
  try {
    run("rustup", ["target", "add", target]);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    console.error(
      `\nRust for ${target} is not installed and rustup was not found (Rust seems to be a standalone install).\n` +
        "Install rustup, which manages targets:\n" +
        "  winget uninstall Rustlang.Rust.MSVC      (only if that package is installed)\n" +
        "  winget install Rustlang.Rustup\n" +
        "  then open a NEW PowerShell window and run:  rustup default stable\n" +
        "See docs/setup.md.",
    );
    process.exit(1);
  }
}

// Updater artifacts are signed during `tauri build`; fail before minutes of compiling, not after.
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.error("TAURI_SIGNING_PRIVATE_KEY is not set. Windows: `. .\\scripts\\signing-env.ps1`; macOS: see docs/releasing.md (Release on macOS).");
  process.exit(1);
}

const host = hostTriple();
// x64 Windows builds run on Intel/AMD PCs and, emulated, on Windows-on-ARM; an ARM64 build runs only on ARM.
const target = argValue("--target") ?? (process.platform === "win32" ? "x86_64-pc-windows-msvc" : host);
const targetIsWindows = target.includes("windows");
const exe = (name) => (targetIsWindows ? `${name}.exe` : name);
console.log(`Building for ${target} on ${host}`);

ensureRustTarget(target);

// 1. Engine bundle (platform independent JavaScript)
run(process.execPath, ["build.mjs"], path.join(root, "packages", "engine"));
const engineOut = path.join(tauriDir, "resources", "engine");
rmSync(engineOut, { recursive: true, force: true });
mkdirSync(engineOut, { recursive: true });
copyFileSync(path.join(root, "packages", "engine", "dist", "engine.mjs"), path.join(engineOut, "engine.mjs"));

// 2. Node runtime for the target
const nodeOut = path.join(tauriDir, "resources", "node");
rmSync(nodeOut, { recursive: true, force: true });
mkdirSync(nodeOut, { recursive: true });
const nodeTarget = path.join(nodeOut, exe("node"));
// Always the LTS from nodejs.org: the build machine's own Node (nvm, Homebrew, a newer major) never ships.
const bundledNode = await downloadNode(target, nodeTarget);

// 3. hubctl sidecar
run("cargo", ["build", "--release", "-p", "hubctl", "--target", target]);
const binOut = path.join(tauriDir, "binaries");
mkdirSync(binOut, { recursive: true });
const hubctlTarget = path.join(binOut, exe(`hubctl-${target}`));
copyFileSync(path.join(root, "target", target, "release", exe("hubctl")), hubctlTarget);
if (!targetIsWindows) chmodSync(hubctlTarget, 0o755);

// 4. The app itself (Tauri CLI via node, so no shell is needed for pnpm/.cmd shims on Windows)
const tauriCli = path.join(desktopDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
if (!existsSync(tauriCli)) throw new Error("Tauri CLI not installed; run pnpm install first");
run(process.execPath, [tauriCli, "build", "--target", target, "--config", "src-tauri/tauri.bundle.conf.json"], desktopDir);

console.log(`\nBundle ready: target/${target}/release/bundle/ (bundled Node ${bundledNode} for ${target}).`);
