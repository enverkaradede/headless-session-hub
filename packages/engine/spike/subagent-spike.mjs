// Spike: what a subagent run looks like on the stream with forwardSubagentText + agentProgressSummaries.
// Usage: CLAUDE_CONFIG_DIR=... node spike/subagent-spike.mjs <claudeExePath>
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workDir = mkdtempSync(path.join(tmpdir(), "hub-subagent-"));
writeFileSync(path.join(workDir, "a.txt"), "alpha");
writeFileSync(path.join(workDir, "b.txt"), "beta");

const counts = {};
const samples = [];
for await (const message of query({
  prompt: "Use the Agent tool (subagent_type general-purpose) to read every .txt file in the current directory and report their contents. Then reply with the subagent's answer in one line.",
  options: {
    cwd: workDir,
    model: "haiku",
    pathToClaudeCodeExecutable: process.argv[2],
    forwardSubagentText: true,
    agentProgressSummaries: true,
    maxTurns: 8,
    canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
  },
})) {
  const key = `${message.type}:${message.subtype ?? ""}${message.parent_tool_use_id ? ":sub" : ""}`;
  counts[key] = (counts[key] ?? 0) + 1;
  if (message.type === "system" && String(message.subtype).startsWith("task_")) {
    samples.push({ subtype: message.subtype, tool_use_id: Boolean(message.tool_use_id), description: message.description, subagent_type: message.subagent_type, summary: message.summary, status: message.status });
  }
  if (message.type === "assistant" && !message.parent_tool_use_id) {
    for (const block of message.message.content) if (block.type === "tool_use") samples.push({ mainToolUse: block.name });
  }
  if (message.type === "result") samples.push({ result: message.result?.slice(0, 120) });
}
console.log(JSON.stringify({ counts, samples }, null, 1));
