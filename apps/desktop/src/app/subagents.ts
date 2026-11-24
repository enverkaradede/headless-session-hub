/** Derives subagent state from a session timeline: each Agent/Task call owns a nested transcript. */
import { SUBAGENT_TOOLS, type SubagentStatusData, type TimelineEvent } from "@hub/protocol";

export type SubagentState = "running" | "completed" | "failed" | "stopped";

export interface SubagentInfo {
  id: string;
  /** Subagent that spawned this one, or null for the main conversation. */
  parent: string | null;
  type: string;
  description: string;
  state: SubagentState;
  steps: number;
  summary: string | null;
  lastActivity: string | null;
  totalTokens: number | null;
  startedAt: number;
}

export function isSubagentCall(event: TimelineEvent): boolean {
  return event.kind === "tool_use" && event.toolName !== null && SUBAGENT_TOOLS.includes(event.toolName) && event.toolUseId !== null;
}

export function buildSubagentIndex(events: readonly TimelineEvent[]): Map<string, SubagentInfo> {
  const index = new Map<string, SubagentInfo>();
  for (const event of events) {
    if (isSubagentCall(event) && event.toolUseId) {
      const input = (event.data ?? {}) as { description?: string; subagent_type?: string };
      index.set(event.toolUseId, {
        id: event.toolUseId,
        parent: event.parentToolUseId,
        type: input.subagent_type ?? "general-purpose",
        description: input.description ?? "Subagent",
        state: "running",
        steps: 0,
        summary: null,
        lastActivity: null,
        totalTokens: null,
        startedAt: event.ts,
      });
    }
  }
  for (const event of events) {
    // The spawning call's own tool_result (in the parent's scope) means the subagent returned.
    if (event.kind === "tool_result" && event.toolUseId && index.has(event.toolUseId)) {
      const info = index.get(event.toolUseId);
      if (info && info.state === "running") info.state = (event.data as { isError?: boolean } | null)?.isError ? "failed" : "completed";
      continue;
    }
    const owner = event.parentToolUseId ? index.get(event.parentToolUseId) : undefined;
    if (!owner) continue;
    if (event.kind === "tool_use") {
      owner.steps += 1;
      owner.lastActivity = event.toolName;
    } else if (event.kind === "status") {
      const status = (event.data as SubagentStatusData | null)?.subagent;
      if (!status) continue;
      if (status.summary) owner.summary = status.summary;
      if (status.totalTokens !== null) owner.totalTokens = status.totalTokens;
      if (status.state === "completed" || status.state === "failed" || status.state === "stopped") owner.state = status.state;
    } else if (event.kind === "assistant_text" && !owner.summary) {
      owner.lastActivity = event.text.split("\n")[0]?.slice(0, 120) ?? owner.lastActivity;
    }
  }
  return index;
}

/** Ancestors of a subagent from the outermost to itself, for the breadcrumb. */
export function subagentPath(index: Map<string, SubagentInfo>, id: string): SubagentInfo[] {
  const path: SubagentInfo[] = [];
  let current = index.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parent ? index.get(current.parent) : undefined;
  }
  return path;
}
