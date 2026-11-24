// End-to-end with the real CLI: catalog.list through an isolated engine (no prompt, no tokens).
// Usage: node spike/catalog-smoke.mjs <claudeConfigDir> <projectDir>
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const [configDir, projectDir] = process.argv.slice(2);
const dataDir = mkdtempSync(path.join(tmpdir(), "hub-catalog-data-"));
const engine = spawn(process.execPath, [new URL("../dist/engine.mjs", import.meta.url).pathname, "--data-dir", dataDir], {
  stdio: ["pipe", "pipe", "ignore"],
  env: { ...process.env, HUB_CLAUDE_PATH: path.join(process.env.HOME, ".local/bin/claude") },
});
const pending = new Map();
let ready;
const readyPromise = new Promise((resolve) => (ready = resolve));
createInterface({ input: engine.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.t === "ready") ready();
  if (message.t === "res") {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, (message) => (message.ok ? resolve(message.result) : reject(Object.assign(new Error(message.error.message), { code: message.error.code }))));
    engine.stdin.write(`${JSON.stringify({ t: "req", id, method, params, caller: { kind: "local" } })}\n`);
  });
const summary = (catalog, ms) => ({ ms, cwd: catalog.cwd, total: catalog.commands.length, builtin: catalog.commands.filter((c) => c.builtin).length, skills: catalog.commands.filter((c) => !c.builtin).length });

try {
  await readyPromise;
  await rpc("settings.update", { profiles: [{ id: "default", name: "Smoke", configDir }], defaultProfileId: "default", allowedDirectories: [projectDir] });
  let t = Date.now();
  console.log("no folder:", summary(await rpc("catalog.list", {}), Date.now() - t));
  t = Date.now();
  console.log("cached:", summary(await rpc("catalog.list", {}), Date.now() - t));
  t = Date.now();
  console.log("project:", summary(await rpc("catalog.list", { cwd: projectDir }), Date.now() - t));
  await rpc("catalog.list", { cwd: tmpdir() }).then(() => console.log("outside allowlist: NOT ENFORCED"), (err) => console.log("outside allowlist:", err.code));
} catch (err) {
  console.log("FAILED:", err.message);
} finally {
  engine.stdin.end();
}
