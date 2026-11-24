// End-to-end smoke test against the real Claude CLI, driving the bundled engine over stdio like the desktop shell does.
// Usage: node spike/engine-smoke.mjs <claudeConfigDir|default>
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const configDir = process.argv[2] && process.argv[2] !== "default" ? process.argv[2] : null;
const dataDir = mkdtempSync(path.join(tmpdir(), "hub-smoke-data-"));
const workDir = mkdtempSync(path.join(tmpdir(), "hub-smoke-work-çalışma-"));
const STEP_TIMEOUT_MS = 180_000;

const engine = spawn(process.execPath, [new URL("../dist/engine.mjs", import.meta.url).pathname, "--data-dir", dataDir], { stdio: ["pipe", "pipe", "pipe"] });
const stderrLines = [];
createInterface({ input: engine.stderr }).on("line", (line) => stderrLines.push(line));

const pending = new Map();
const listeners = new Set();
let nextId = 1;
createInterface({ input: engine.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.t === "res") {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) waiter?.resolve(message.result);
    else waiter?.reject(new Error(`${message.error.code}: ${message.error.message}`));
  }
  for (const listener of listeners) listener(message);
});

function rpc(method, params = {}) {
  const id = String(nextId++);
  engine.stdin.write(`${JSON.stringify({ t: "req", id, method, params, caller: { kind: "local" } })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Resolves with the first outbound message matching the predicate (event-driven, no polling). */
function waitForMessage(label, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`timeout waiting for ${label}`));
    }, STEP_TIMEOUT_MS);
    const listener = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(message);
    };
    listeners.add(listener);
  });
}

const report = [];
const step = (name, ok, detail = "") => report.push(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);

try {
  const ready = await waitForMessage("ready", (m) => m.t === "ready");
  step("engine ready", true, `api port ${ready.info.apiPort}`);

  await rpc("settings.update", {
    profiles: [{ id: "default", name: "Smoke", configDir }],
    defaultProfileId: "default",
    allowedDirectories: [workDir],
  });
  const auth = await rpc("auth.refresh");
  step("auth check", auth[0]?.method === "subscription", auth[0]?.detail);

  const started = await rpc("sessions.start", {
    cwd: workDir,
    model: "haiku",
    name: "smoke",
    labels: ["smoke"],
    prompt: "Use the AskUserQuestion tool to ask me which colour I prefer, options 'red' and 'blue'. After I answer, reply with only the colour name.",
  });
  const sessionId = started.id;
  const t0 = Date.now();
  const requestEvent = await waitForMessage("question", (m) => m.t === "evt" && m.event.type === "request.upsert" && m.event.request.sessionId === sessionId && m.event.request.state === "open");
  const latency = Date.now() - t0;
  const request = requestEvent.event.request;
  step("question reached the hub", request.kind === "question", `${latency} ms after start, "${request.questions?.[0]?.question}"`);
  const waiting = await rpc("sessions.get", { sessionId });
  step("status is waiting_input", waiting.status === "waiting_input", waiting.status);

  const question = request.questions[0];
  const blue = question.options.find((option) => /blue/i.test(option.label))?.label ?? question.options[1].label;
  const doneEvent = waitForMessage("done", (m) => m.t === "evt" && m.event.type === "session.upsert" && m.event.session.id === sessionId && ["done", "error"].includes(m.event.session.status));
  await rpc("sessions.answer", { sessionId, requestId: request.id, answer: { kind: "question", answers: { [question.question]: blue } } });
  const done = (await doneEvent).event.session;
  step("session finished after the answer", done.status === "done", `status=${done.status} preview=${JSON.stringify(done.lastMessagePreview)} cost≈$${done.costUsd.toFixed(4)}`);

  const timeline = await rpc("sessions.timeline", { sessionId });
  step("timeline recorded", timeline.length > 3, timeline.map((event) => event.kind).join(","));

  const discovery = JSON.parse(readFileSync(path.join(dataDir, "engine.json"), "utf8"));
  const base = `http://127.0.0.1:${discovery.port}`;
  const listed = await fetch(`${base}/v1/sessions?label=smoke`, { headers: { authorization: `Bearer ${discovery.token}` } }).then((r) => r.json());
  step("local API lists the session", Array.isArray(listed) && listed.some((s) => s.id === sessionId));
  const noToken = await fetch(`${base}/v1/sessions`);
  step("local API rejects a missing token", noToken.status === 401, String(noToken.status));
  const browser = await fetch(`${base}/v1/sessions`, { headers: { authorization: `Bearer ${discovery.token}`, origin: "https://evil.example" } });
  step("local API rejects browser-originated requests", browser.status === 403, String(browser.status));

  await rpc("sessions.stop", { sessionId });
} catch (err) {
  step("smoke run", false, err.message);
  console.error(stderrLines.slice(-15).join("\n"));
} finally {
  engine.stdin.end();
  console.log(report.join("\n"));
}
