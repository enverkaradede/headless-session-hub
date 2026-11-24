// Spike: verify the [DOĞRULA] behaviours against the real CLI. Writes a JSON report to spike/out/.
// Usage: CLAUDE_CONFIG_DIR=... node spike/sdk-spike.mjs <claudeExePath> [scenario...]
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudePath = process.argv[2];
const only = process.argv.slice(3);
const MODEL = "haiku";
const outDir = new URL("./out/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const workDir = mkdtempSync(join(tmpdir(), "hub-spike-"));

const baseOptions = () => ({
  cwd: workDir,
  model: MODEL,
  pathToClaudeCodeExecutable: claudePath,
  env: { ...process.env },
  maxTurns: 6,
});

function summarize(msg) {
  const base = { type: msg.type, subtype: msg.subtype };
  if (msg.type === "result") {
    const { result, stop_reason, terminal_reason, deferred_tool_use, is_error, subtype, num_turns, total_cost_usd, permission_denials } = msg;
    return { ...base, result, stop_reason, terminal_reason, deferred_tool_use, is_error, subtype, num_turns, total_cost_usd, permission_denials };
  }
  if (msg.type === "system" && msg.subtype === "init") return { ...base, apiKeySource: msg.apiKeySource, permissionMode: msg.permissionMode, model: msg.model, hasAskUserQuestion: msg.tools.includes("AskUserQuestion"), version: msg.claude_code_version };
  if (msg.type === "assistant") return { ...base, content: msg.message.content.map((c) => (c.type === "text" ? { text: c.text } : c.type === "tool_use" ? { tool_use: c.name, input: c.input } : { [c.type]: true })) };
  if (msg.type === "user") return { ...base, content: Array.isArray(msg.message.content) ? msg.message.content.map((c) => (c.type === "tool_result" ? { tool_result: typeof c.content === "string" ? c.content.slice(0, 300) : c.content, is_error: c.is_error } : { [c.type]: true })) : msg.message.content };
  if (msg.type === "rate_limit_event") return { ...base, info: msg.rate_limit_info };
  if (msg.type === "system") return { ...base, state: msg.state };
  return base;
}

async function run(label, prompt, options) {
  const log = [];
  let sessionId = null;
  const started = Date.now();
  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.session_id) sessionId = msg.session_id;
      log.push(summarize(msg));
      if (msg.type === "result" && options.onResult) options.onResult();
    }
  } catch (err) {
    log.push({ thrown: String(err?.message ?? err) });
  }
  return { label, sessionId, ms: Date.now() - started, log };
}

const scenarios = {
  // A: AskUserQuestion round-trip through canUseTool with a single-select string answer.
  async askSingle() {
    const seen = [];
    const r = await run("askSingle",
      "Use the AskUserQuestion tool to ask me which colour I prefer, options 'red' and 'blue' (single select). After I answer, reply with only the colour name.",
      { ...baseOptions(), canUseTool: async (toolName, input, ctx) => {
        seen.push({ toolName, input, suggestions: ctx.suggestions ?? null });
        if (toolName === "AskUserQuestion") {
          const q = input.questions[0];
          return { behavior: "allow", updatedInput: { questions: input.questions, answers: { [q.question]: "blue" } } };
        }
        return { behavior: "deny", message: "not in this test" };
      } });
    return { ...r, canUseToolCalls: seen };
  },
  // B: permission denial, does the model receive the message and continue?
  async denyBash() {
    const seen = [];
    const r = await run("denyBash",
      "Run the shell command `touch spike-marker.txt` with the Bash tool. If it is denied, reply with exactly: DENIED <the denial message you received>.",
      { ...baseOptions(), canUseTool: async (toolName, input, ctx) => {
        seen.push({ toolName, input, suggestions: ctx.suggestions ?? null, blockedPath: ctx.blockedPath ?? null });
        return { behavior: "deny", message: "spike-denial-42" };
      }, settingSources: [] });
    return { ...r, canUseToolCalls: seen };
  },
  // C: PreToolUse defer in the SDK, then resume and answer on the second PreToolUse.
  async deferResume() {
    const hookCalls = [];
    let answerNow = false;
    const hooks = { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [async (input) => {
      hookCalls.push({ phase: answerNow ? "resume" : "first", tool: input.tool_name, tool_use_id: input.tool_use_id });
      if (!answerNow) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } };
      const q = input.tool_input.questions[0];
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { questions: input.tool_input.questions, answers: { [q.question]: "green" } } } };
    }] }] };
    const canUseTool = async () => ({ behavior: "deny", message: "canUseTool should not be reached" });
    const first = await run("defer-first",
      "Use the AskUserQuestion tool to ask me which colour I prefer, options 'green' and 'yellow' (single select). After I answer, reply with only the colour name.",
      { ...baseOptions(), hooks, canUseTool });
    answerNow = true;
    // Resume without a new prompt, but keep stdin (the SDK control channel) open until the result arrives.
    let release;
    const gate = new Promise((r) => (release = r));
    async function* openInput() { await gate; }
    const second = first.sessionId
      ? await run("defer-resume-open-stream", openInput(), { ...baseOptions(), hooks, canUseTool, resume: first.sessionId, onResult: () => release() })
      : null;
    return { first, second, hookCalls };
  },
  // D: multiSelect answered with an array.
  async askMulti() {
    const r = await run("askMulti",
      "Use the AskUserQuestion tool with multiSelect true to ask which fruits I like, options 'apple', 'pear', 'plum'. After I answer, reply with only the chosen fruits comma separated.",
      { ...baseOptions(), canUseTool: async (toolName, input) => {
        if (toolName !== "AskUserQuestion") return { behavior: "deny", message: "no" };
        const q = input.questions[0];
        return { behavior: "allow", updatedInput: { questions: input.questions, answers: { [q.question]: ["apple", "plum"] } } };
      } });
    return r;
  },
};

const report = {};
for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  process.stderr.write(`running ${name}…\n`);
  report[name] = await fn();
}
const file = join(outDir, `sdk-spike-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(file);
