import type { TimelineEvent } from "@hub/protocol";
import { describe, expect, it } from "vitest";
import { buildSubagentIndex } from "./subagents";

let seq = 0;
const event = (patch: Partial<TimelineEvent>): TimelineEvent => ({
  seq: ++seq,
  sessionId: "s",
  ts: seq,
  kind: "notice",
  text: "",
  toolName: null,
  toolUseId: null,
  parentToolUseId: null,
  data: null,
  ...patch,
});

const POINTER = 'This agent\'s report was delivered to you as a message from "a0da" (its SubagentHandback call). Read it there; it is not repeated here.';

describe("buildSubagentIndex", () => {
  it("shows the report a subagent handed back instead of the CLI's pointer to it", () => {
    const events = [
      event({ kind: "tool_use", toolName: "Agent", toolUseId: "agent-1", data: { description: "Read files", subagent_type: "general-purpose" } }),
      event({ kind: "tool_use", toolName: "Read", toolUseId: "r1", parentToolUseId: "agent-1" }),
      event({ kind: "tool_use", toolName: "SubagentHandback", toolUseId: "h1", parentToolUseId: "agent-1", data: { message: "Found 3 files: a, b, c." } }),
      event({ kind: "status", parentToolUseId: "agent-1", data: { subagent: { state: "completed", description: "Read files", subagentType: null, summary: POINTER, toolUses: 2, totalTokens: 100 } } }),
    ];
    const info = buildSubagentIndex(events).get("agent-1");
    expect(info).toMatchObject({ state: "completed", summary: "Found 3 files: a, b, c.", report: "Found 3 files: a, b, c.", steps: 1 });
  });

  it("keeps the completion summary when there was no handback", () => {
    const events = [
      event({ kind: "tool_use", toolName: "Agent", toolUseId: "agent-2", data: { description: "Check" } }),
      event({ kind: "status", parentToolUseId: "agent-2", data: { subagent: { state: "completed", description: "Check", subagentType: null, summary: "All good.", toolUses: 0, totalTokens: 10 } } }),
    ];
    expect(buildSubagentIndex(events).get("agent-2")).toMatchObject({ summary: "All good.", report: null });
  });
});
