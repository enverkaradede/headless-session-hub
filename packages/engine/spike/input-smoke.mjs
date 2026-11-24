// End-to-end with the real CLI: input is never locked.
//  A) app session: a question card is open, the owner types a message instead → the card closes, Claude uses the text.
//  B) `hubctl run` claude -p session still running: a message is queued and sent when the process ends.
// Uses its own engine + data dir (HUB_DATA_DIR), not the app's.
// Usage: node spike/input-smoke.mjs <hubctlPath> <claudeConfigDir>
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const [hubctl, configDir] = process.argv.slice(2);
const dataDir = mkdtempSync(path.join(tmpdir(), "hub-input-data-"));
const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-input-work-")));
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
async function until(label, probe) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
const lastAssistant = async (sessionId) => (await rpc("sessions.timeline", { sessionId })).filter((event) => event.kind === "assistant_text").pop()?.text;

try {
  await readyPromise;
  await rpc("settings.update", { profiles: [{ id: "default", name: "Smoke", configDir }], defaultProfileId: "default", allowedDirectories: [workDir], warmIdleMinutes: 0, askViaTool: true });

  // A) typing instead of answering the card
  if (process.env.SKIP_A !== "1") {
  const a = await rpc("sessions.start", { cwd: workDir, model: "haiku", prompt: "Use AskUserQuestion to ask me whether I prefer red or blue. After I answer, reply with only the colour I chose, one word." });
  const card = await until("question card", async () => (await rpc("sessions.requests", { sessionId: a.id })).find((request) => request.state === "open"));
  console.log("A card open:", card.questions?.[0]?.question);
  const sent = Date.now();
  await rpc("sessions.message", { sessionId: a.id, text: "Neither. I want green." });
  const doneA = await until("A done", async () => {
    const session = await rpc("sessions.get", { sessionId: a.id });
    return ["done", "error"].includes(session.status) || session.awaitingReply ? session : null;
  });
  const requestState = (await rpc("sessions.requests", { sessionId: a.id })).find((request) => request.id === card.id)?.state ?? "closed";
  console.log("A result:", { status: doneA.status, cardState: requestState, seconds: ((Date.now() - sent) / 1000).toFixed(1), answer: await lastAssistant(a.id) });
  }

  // B) message to a running claude -p session is queued, then sent when it ends
  const run = spawn(hubctl, ["run", "--name", "input smoke", "--label", "input-smoke", "--", "-p", "Run the bash command `sleep 20`, then reply with only the word done.", "--allowedTools", "Bash(sleep:*)", "--model", "haiku"], { env, cwd: workDir, stdio: "ignore" });
  const exited = new Promise((resolve) => run.on("exit", resolve));
  const b = await until("B registered", async () => (await rpc("sessions.list", { label: "input-smoke" }))[0]);
  const queued = await rpc("sessions.message", { sessionId: b.id, text: "Now reply with only the word banana." });
  console.log("B while running:", { status: queued.status, queuedMessages: queued.queuedMessages });
  console.log("B hubctl exit code:", await exited);
  const doneB = await until("B resumed and done", async () => {
    const session = await rpc("sessions.get", { sessionId: b.id });
    return session.status === "done" && session.queuedMessages.length === 0 && !session.live ? session : null;
  });
  const users = (await rpc("sessions.timeline", { sessionId: b.id })).filter((event) => event.kind === "user_message").map((event) => event.text);
  console.log("B result:", { status: doneB.status, origin: doneB.origin, userMessages: users, answer: await lastAssistant(b.id) });
} catch (err) {
  console.log("FAILED:", err.message);
} finally {
  engine.stdin.end();
}
