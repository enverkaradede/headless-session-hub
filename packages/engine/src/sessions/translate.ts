/** Pure translation of Agent SDK messages into timeline drafts and session stat updates. */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TimelineKind, UsageLimitInfo } from "@hub/protocol";

const MAX_TEXT_CHARS = 8000;
const MAX_DATA_STRING_CHARS = 8000;
const PREVIEW_CHARS = 160;

export interface TimelineDraft {
  kind: TimelineKind;
  text: string;
  toolName: string | null;
  toolUseId: string | null;
  data: unknown;
}

export interface ResultInfo {
  subtype: string;
  isError: boolean;
  stopReason: string | null;
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  deferredToolUseId: string | null;
}

export interface Translation {
  drafts: TimelineDraft[];
  init?: { model: string; permissionMode: string; apiKeySource: string };
  preview?: string;
  result?: ResultInfo;
  rateLimit?: { status: "allowed" | "allowed_warning" | "rejected"; usingOverage: boolean; limit: Omit<UsageLimitInfo, "detectedAt" | "kind"> };
}

export function truncateText(text: string, max = MAX_TEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

/** Caps long strings inside tool inputs so one huge Write does not bloat the timeline. */
export function clampData(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateText(value, MAX_DATA_STRING_CHARS);
  if (depth > 12) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => clampData(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clampData(inner, depth + 1)]));
  }
  return value;
}

function draft(kind: TimelineKind, text: string, extra: Partial<TimelineDraft> = {}): TimelineDraft {
  return { kind, text, toolName: null, toolUseId: null, data: null, ...extra };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : `[${part.type ?? "content"}]`))
      .join("\n");
  }
  return "";
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

export function translate(message: SDKMessage): Translation {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        return { drafts: [], init: { model: message.model, permissionMode: message.permissionMode, apiKeySource: String(message.apiKeySource) } };
      }
      if (message.subtype === "api_retry") {
        const retry = message as unknown as { attempt?: number; error?: string };
        return { drafts: [draft("notice", `API retry${retry.attempt ? ` #${retry.attempt}` : ""}${retry.error ? `: ${retry.error}` : ""}`)] };
      }
      if (message.subtype === "compact_boundary") return { drafts: [draft("notice", "Conversation compacted")] };
      return { drafts: [] };
    }
    case "assistant": {
      if (message.parent_tool_use_id) return { drafts: [] }; // subagent chatter stays out of the main timeline
      const drafts: TimelineDraft[] = [];
      let preview: string | undefined;
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          drafts.push(draft("assistant_text", truncateText(block.text)));
          preview = oneLine(block.text);
        } else if (block.type === "tool_use") {
          drafts.push(draft("tool_use", block.name, { toolName: block.name, toolUseId: block.id, data: clampData(block.input) }));
        } else if (block.type === "thinking" && block.thinking.trim()) {
          drafts.push(draft("thinking", truncateText(block.thinking, 2000)));
        }
      }
      return preview === undefined ? { drafts } : { drafts, preview };
    }
    case "user": {
      if (message.parent_tool_use_id || typeof message.message.content === "string") return { drafts: [] };
      const drafts: TimelineDraft[] = [];
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        drafts.push(
          draft("tool_result", truncateText(toolResultText(block.content)), {
            toolUseId: block.tool_use_id,
            data: { isError: block.is_error === true },
          }),
        );
      }
      return { drafts };
    }
    case "result": {
      let inputTokens = 0;
      let outputTokens = 0;
      for (const usage of Object.values(message.modelUsage ?? {})) {
        inputTokens += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
        outputTokens += usage.outputTokens;
      }
      const text = message.subtype === "success" ? message.result : ((message as { errors?: string[] }).errors ?? []).join("\n");
      const deferred = (message as { deferred_tool_use?: { id: string } }).deferred_tool_use;
      const result: ResultInfo = {
        subtype: message.subtype,
        isError: message.is_error,
        stopReason: message.stop_reason,
        text,
        costUsd: message.total_cost_usd,
        inputTokens,
        outputTokens,
        deferredToolUseId: deferred?.id ?? null,
      };
      const summary = message.subtype === "success" ? "Finished" : `Ended: ${message.subtype}`;
      return {
        drafts: [draft("result", text ? truncateText(text) : summary, { data: { subtype: message.subtype, stopReason: message.stop_reason, costUsd: message.total_cost_usd, turns: message.num_turns } })],
        result,
      };
    }
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      return {
        drafts: [],
        rateLimit: {
          status: info.status,
          usingOverage: info.isUsingOverage === true || info.overageInUse === true,
          limit: { resetsAt: info.resetsAt ?? info.overageResetsAt ?? null, limitType: info.rateLimitType ?? null },
        },
      };
    }
    default:
      return { drafts: [] };
  }
}
