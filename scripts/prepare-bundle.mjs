// Builds a release bundle for one target (default on Windows: x86_64, which also runs on Windows-on-ARM).
//   node scripts/prepare-bundle.mjs [--target <rust-triple>]
// It places what ships next to the Tauri binary, then runs `tauri build`:
//   resources/engine/engine.mjs      the engine bundle
//   resources/node/node[.exe]        Node for the TARGET (copied when target == host, else downloaded + verified)
//   binaries/hubctl-<triple>[.exe]   the hubctl sidecar (Tauri externalBin naming)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The app ships this Node LTS line (latest patch), whatever Node the build machine happens to run. */
const BUNDLED_NODE_MAJOR = 24;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "apps", "desktop");
const tauriDir = path.join(desktopDir, "src-tauri");

/** Node distribution folder for each supported target triple. */
const NODE_DIST = {
  "x86_64-pc-windows-msvc": "win-x64",
  "aarch64-pc-windows-msvc": "win-arm64",
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

/** Latest release of the bundled LTS line that has a standalone node.exe for this platform. */
async function resolveNodeVersion(dist) {
  const index = await (await fetch("https://nodejs.org/dist/index.json")).json();
  const release = index.find((entry) => entry.version.startsWith(`v${BUNDLED_NODE_MAJOR}.`) && entry.files.includes(`${dist}-exe`));
  if (!release) throw new Error(`no Node ${BUNDLED_NODE_MAJOR} release with ${dist}-exe on nodejs.org`);
  return release.version;
}

/** Downloads the bundled Node for the target from nodejs.org and checks it against SHASUMS256.txt. */
async function downloadNode(target, destination) {
  const dist = NODE_DIST[target];
  if (!dist) throw new Error(`no Node download mapping for ${target}; build on that platform instead`);
  const version = await resolveNodeVersion(dist);
  const base = `https://nodejs.org/dist/${version}`;
  console.log(`> downloading Node ${version} ${dist}/node.exe`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === `${dist}/node.exe`)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt for ${version} has no ${dist}/node.exe`);
  const response = await fetch(`${base}/${dist}/node.exe`);
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Node checksum mismatch for ${dist}/node.exe (expected ${expected}, got ${actual})`);
  writeFileSync(destination, bytes);
  console.log(`  verified sha256 ${actual}`);
  return version;
}

/** Makes sure the Rust standard library for `target` is installed; explains the fix when rustup is missing. */
function ensureRustTarget(target) {
  const sysroot = execFileSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).trim();
  if (existsSync(path.join(sysroot, "lib", "rustlib", target))) return;
  try {
    ensureRustTarget(target);
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
  console.error("TAURI_SIGNING_PRIVATE_KEY is not set. Run `. .\\scripts\\signing-env.ps1` first (docs/releasing.md).");
  process.exit(1);
}

const host = hostTriple();
// x64 Windows builds run on Intel/AMD PCs and, emulated, on Windows-on-ARM; an ARM64 build runs only on ARM.
const target = argValue("--target") ?? (process.platform === "win32" ? "x86_64-pc-windows-msvc" : host);
const targetIsWindows = target.includes("windows");
const exe = (name) => (targetIsWindows ? `${name}.exe` : name);
console.log(`Building for ${target} on ${host}`);

run("rustup", ["target", "add", target]);

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
let bundledNode;
if (NODE_DIST[target]) {
  bundledNode = await downloadNode(target, nodeTarget);
} else {
  // Non-Windows targets are developer builds: reuse this machine's Node.
  copyFileSync(process.execPath, nodeTarget);
  chmodSync(nodeTarget, 0o755);
  bundledNode = process.version;
}

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
