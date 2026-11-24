// Spike: list slash commands and skills for a profile + folder without sending a prompt (no tokens).
// Usage: node spike/catalog-spike.mjs <claudeConfigDir> <cwd>
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";

const [configDir, cwd] = process.argv.slice(2);
const started = Date.now();
const abort = new AbortController();
let closeInput;
const input = { async *[Symbol.asyncIterator]() { await new Promise((resolve) => (closeInput = resolve)); } };
const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
delete env.ANTHROPIC_API_KEY;
const q = query({ prompt: input, options: { cwd, env, abortController: abort, settingSources: ["user", "project", "local"], pathToClaudeCodeExecutable: path.join(process.env.HOME, ".local/bin/claude") } });
try {
  const init = await q.initializationResult();
  const builtin = init.commands.filter((c) => c.builtin);
  const custom = init.commands.filter((c) => !c.builtin);
  console.log({ ms: Date.now() - started, total: init.commands.length, builtin: builtin.length, custom: custom.length, agents: init.agents.length });
  console.log("builtin sample:", builtin.slice(0, 40).map((c) => c.name).join(" "));
  console.log("custom:", custom.map((c) => `${c.name}${c.argumentHint ? " " + c.argumentHint : ""} — ${c.description.slice(0, 50)}`).join("\n  "));
} finally {
  closeInput?.();
  abort.abort();
}
