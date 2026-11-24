// End-to-end: a real session that spawns a subagent; checks the stored timeline splits into the
// main conversation and the subagent's own track. Usage: node spike/engine-subagent-smoke.mjs <claudeConfigDir>
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const configDir = process.argv[2] ?? null;
const dataDir = mkdtempSync(path.join(tmpdir(), "hub-sub-data-"));
const workDir = mkdtempSync(path.join(tmpdir(), "hub-sub-work-"));
writeFileSync(path.join(workDir, "a.txt"), "alpha");
writeFileSync(path.join(workDir, "b.txt"), "beta");
const TIMEOUT_MS = 240_000;

const engine = spawn(process.execPath, [new URL("../dist/engine.mjs", import.meta.url).pathname, "--data-dir", dataDir], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
const listeners = new Set();
let nextId = 1;
createInterface({ input: engine.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.t === "res") {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    message.ok ? waiter?.resolve(message.result) : waiter?.reject(new Error(message.error.message));
  }
  for (const listener of listeners) listener(message);
});
const rpc = (method, params = {}) => {
  const id = String(nextId++);
  engine.stdin.write(`${JSON.stringify({ t: "req", id, method, params, caller: { kind: "local" } })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const waitFor = (label, predicate) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), TIMEOUT_MS);
    const listener = (message) => {
      if (predicate(message)) {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      }
    };
    listeners.add(listener);
  });

try {
  await waitFor("ready", (m) => m.t === "ready");
  await rpc("settings.update", { profiles: [{ id: "default", name: "Smoke", configDir }], defaultProfileId: "default", allowedDirectories: [workDir], warmIdleMinutes: 0 });
  const session = await rpc("sessions.start", {
    cwd: workDir,
    model: "haiku",
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Glob", "Agent"],
    prompt: "Use the Agent tool (subagent_type general-purpose) to read every .txt file here and report their contents. Then reply with one line.",
  });
  await waitFor("done", (m) => m.t === "evt" && m.event.type === "session.upsert" && m.event.session.id === session.id && ["done", "error"].includes(m.event.session.status));
  const timeline = await rpc("sessions.timeline", { sessionId: session.id });
  const agentCall = timeline.find((event) => event.kind === "tool_use" && ["Agent", "Task"].includes(event.toolName));
  const sub = timeline.filter((event) => event.parentToolUseId && event.parentToolUseId === agentCall?.toolUseId);
  const statuses = sub.filter((event) => event.kind === "status").map((event) => `${event.data?.subagent?.state}:${event.text.slice(0, 40)}`);
  const final = await rpc("sessions.get", { sessionId: session.id });
  console.log(JSON.stringify({
    status: final.status,
    agentCall: Boolean(agentCall),
    subagentEvents: sub.length,
    subagentKinds: [...new Set(sub.map((event) => event.kind))],
    statuses,
    mainPreview: final.lastMessagePreview,
    mainEvents: timeline.filter((event) => !event.parentToolUseId).map((event) => event.kind).join(","),
  }, null, 1));
} catch (err) {
  console.log("FAILED", err.message);
} finally {
  engine.stdin.end();
}
