// End-to-end: a `hubctl run` claude -p session asks in plain text, the hub shows it as awaiting a reply,
// `hubctl reply` resumes it inside the hub. Uses its own engine + data dir (HUB_DATA_DIR), not the app's.
// Usage: node spike/compat-reply-smoke.mjs <hubctlPath> <claudeConfigDir>
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const [hubctl, configDir] = process.argv.slice(2);
const dataDir = mkdtempSync(path.join(tmpdir(), "hub-reply-data-"));
const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-reply-work-")));
const env = { ...process.env, HUB_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: configDir, HUB_CLAUDE_PATH: path.join(process.env.HOME, ".local/bin/claude") };
const POLL_MS = 1000;
const TIMEOUT_MS = 240_000;

const engine = spawn(process.execPath, [new URL("../dist/engine.mjs", import.meta.url).pathname, "--data-dir", dataDir, "--hubctl", hubctl], { stdio: ["pipe", "pipe", "ignore"] });
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
const hub = (args) => execFileSync(hubctl, args, { env, encoding: "utf8", cwd: workDir });
const sessionByLabel = () => JSON.parse(hub(["sessions", "--label", "reply-smoke", "--json"]))[0];
async function until(label, predicate) {
  const started = Date.now();
  for (;;) {
    const session = sessionByLabel();
    if (session && predicate(session)) return session;
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

try {
  await readyPromise;
  await rpc("settings.update", { profiles: [{ id: "default", name: "Smoke", configDir }], defaultProfileId: "default", allowedDirectories: [workDir], warmIdleMinutes: 0 });
  hub(["run", "--name", "reply smoke", "--label", "reply-smoke", "--", "-p", "I need a colour for a button. Ask me whether I prefer red or blue, then stop.", "--model", "haiku", "--output-format", "json"]);
  const asked = await until("awaiting reply", (session) => session.awaitingReply && session.inputTokens > 0);
  console.log("asked:", { status: asked.status, awaitingReply: asked.awaitingReply, question: asked.lastMessagePreview, costUsd: asked.costUsd });
  console.log(hub(["reply", asked.id.slice(0, 8), "Blue please. Reply with only the colour name."]).trim());
  const done = await until("done after reply", (session) => session.status === "done" && !session.awaitingReply);
  const timeline = await rpc("sessions.timeline", { sessionId: done.id });
  console.log("resumed:", { status: done.status, origin: done.origin, answer: timeline.filter((event) => event.kind === "assistant_text").pop()?.text });
  // The allowlist also guards resuming a claude -p session inside the hub.
  await until("process closed", (session) => !session.live);
  await rpc("settings.update", { allowedDirectories: [] });
  try {
    hub(["reply", done.id.slice(0, 8), "again"]);
    console.log("allowlist: NOT ENFORCED (reply went through)");
  } catch (err) {
    console.log("allowlist: enforced ->", String(err.stderr ?? err.message).trim());
  }
} catch (err) {
  console.log("FAILED:", err.message);
} finally {
  engine.stdin.end();
}
