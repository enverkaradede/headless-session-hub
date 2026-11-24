// Prepares everything a release bundle ships next to the Tauri binary:
//   resources/engine/engine.mjs   the engine bundle
//   resources/node/node[.exe]     the Node runtime that runs it (copied from the Node running this script)
//   binaries/hubctl-<triple>[.exe] the hubctl sidecar (Tauri externalBin naming)
// Run on the target OS (the Windows build happens on the Windows machine).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE_MAJOR = 24;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = path.join(root, "apps", "desktop", "src-tauri");
const isWindows = process.platform === "win32";
const exe = (name) => (isWindows ? `${name}.exe` : name);

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

// Updater artifacts are signed during `tauri build`; fail before minutes of compiling, not after.
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.error("TAURI_SIGNING_PRIVATE_KEY is not set. See docs/releasing.md (signing key + password).");
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== REQUIRED_NODE_MAJOR) {
  console.warn(`! Bundling Node ${process.versions.node}; the supported runtime is Node ${REQUIRED_NODE_MAJOR} LTS.`);
}

// 1. Engine bundle
run(process.execPath, ["build.mjs"], path.join(root, "packages", "engine"));
const engineOut = path.join(tauriDir, "resources", "engine");
rmSync(engineOut, { recursive: true, force: true });
mkdirSync(engineOut, { recursive: true });
copyFileSync(path.join(root, "packages", "engine", "dist", "engine.mjs"), path.join(engineOut, "engine.mjs"));

// 2. Node runtime
const nodeOut = path.join(tauriDir, "resources", "node");
rmSync(nodeOut, { recursive: true, force: true });
mkdirSync(nodeOut, { recursive: true });
const nodeTarget = path.join(nodeOut, exe("node"));
copyFileSync(process.execPath, nodeTarget);
if (!isWindows) chmodSync(nodeTarget, 0o755);

// 3. hubctl sidecar
run("cargo", ["build", "--release", "-p", "hubctl"]);
const triple = hostTriple();
const binOut = path.join(tauriDir, "binaries");
mkdirSync(binOut, { recursive: true });
const hubctlTarget = path.join(binOut, isWindows ? `hubctl-${triple}.exe` : `hubctl-${triple}`);
copyFileSync(path.join(root, "target", "release", exe("hubctl")), hubctlTarget);
if (!isWindows) chmodSync(hubctlTarget, 0o755);

console.log(`\nBundle inputs ready for ${triple} (Node ${process.versions.node}).`);
