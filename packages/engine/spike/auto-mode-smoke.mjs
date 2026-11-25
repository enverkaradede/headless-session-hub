// Real CLI: does permissionMode "auto" run headless on a subscription, and which steps still reach the hub?
// Usage: node spike/auto-mode-smoke.mjs <claudeConfigDir>
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [configDir] = process.argv.slice(2);
const dataDir = mkdtempSync(path.join(tmpdir(), "hub-auto-data-"));
const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-auto-work-")));
const POLL_MS = 1000;
const TIMEOUT_MS = 240_000;
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
    pending.set(id, (message) => (message.ok ? resolve(message.result) : reject(new Error(message.error.message))));
    engine.stdin.write(`${JSON.stringify({ t: "req", id, method, params, caller: { kind: "local" } })}\n`);
  });

async function poll(probe) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(POLL_MS);
  }
  throw new Error("timeout");
}

try {
  await readyPromise;
  await rpc("settings.update", { profiles: [{ id: "default", name: "Smoke", configDir }], defaultProfileId: "default", allowedDirectories: [workDir], warmIdleMinutes: 0 });
  const session = await rpc("sessions.start", {
    cwd: workDir,
    permissionMode: "auto",
    prompt: "Create a file notes.txt containing 'hello', then run `ls -la` and `wc -c notes.txt`. Reply with the byte count only.",
  });
  const seen = new Set();
  const done = await poll(async () => {
    for (const request of await rpc("sessions.requests", { sessionId: session.id })) {
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      console.log("request reached the hub:", request.toolName, String(request.inputPreview ?? "").slice(0, 80));
      if (request.state === "open") await rpc("sessions.answer", { sessionId: session.id, requestId: request.id, answer: { kind: "permission", decision: "allow" } });
    }
    const current = await rpc("sessions.get", { sessionId: session.id });
    return ["done", "error", "usage_limit"].includes(current.status) && !current.live ? current : null;
  });
  const timeline = await rpc("sessions.timeline", { sessionId: session.id });
  console.log({
    status: done.status,
    permissionMode: done.permissionMode,
    model: done.model,
    error: done.errorMessage,
    requests: seen.size,
    tools: timeline.filter((event) => event.kind === "tool_use").map((event) => event.toolName),
    answer: timeline.filter((event) => event.kind === "assistant_text").pop()?.text,
  });
} catch (err) {
  console.log("FAILED:", err.message);
} finally {
  engine.stdin.end();
}
