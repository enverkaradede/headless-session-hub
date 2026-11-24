/** Pure helpers for turning human answers into Agent SDK permission results. */
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { MAX_QUESTIONS_PER_CALL, Question, type RequestAnswer } from "@hub/protocol";
import { z } from "zod";

const MAX_PREVIEW_CHARS = 4000;
const QuestionsInput = z.object({ questions: z.array(Question).min(1).max(MAX_QUESTIONS_PER_CALL) });

/**
 * "Always allow in this session": keep only allow rules and pin them to the session.
 * The CLI also suggests persistent destinations (localSettings), directory grants and
 * mode changes (acceptEdits); forwarding those would widen permissions beyond the session.
 */
export function sessionScopedUpdates(suggestions: readonly PermissionUpdate[] | null | undefined): PermissionUpdate[] {
  if (!suggestions) return [];
  const scoped: PermissionUpdate[] = [];
  for (const suggestion of suggestions) {
    if (suggestion.type !== "addRules" || suggestion.behavior !== "allow") continue;
    scoped.push({ type: "addRules", rules: suggestion.rules, behavior: "allow", destination: "session" });
  }
  return scoped;
}

export function parseQuestions(input: Record<string, unknown>): Question[] | null {
  const parsed = QuestionsInput.safeParse(input);
  return parsed.success ? parsed.data.questions : null;
}

/** Validates an answer against the asked questions; returns an error message or null. */
export function validateQuestionAnswer(questions: readonly Question[], answers: Record<string, string | string[]>): string | null {
  for (const question of questions) {
    const value = answers[question.question];
    if (value === undefined) return `Missing answer for: ${question.question}`;
    if (Array.isArray(value) && !question.multiSelect) return `Question does not allow multiple answers: ${question.question}`;
  }
  const known = new Set(questions.map((question) => question.question));
  const unknown = Object.keys(answers).find((key) => !known.has(key));
  return unknown ? `Unknown question: ${unknown}` : null;
}

/** The AskUserQuestion allow result: original questions plus answers keyed by question text. */
export function questionAllowResult(input: Record<string, unknown>, answers: Record<string, string | string[]>): PermissionResult {
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

const DEFAULT_DENY_MESSAGE = "The user denied this action in Session Hub.";

/** Maps a permission answer to the SDK result. */
export function permissionResult(
  answer: Extract<RequestAnswer, { kind: "permission" }>,
  input: Record<string, unknown>,
  suggestions: readonly PermissionUpdate[] | null,
): PermissionResult {
  if (answer.decision === "deny") return { behavior: "deny", message: answer.message?.trim() || DEFAULT_DENY_MESSAGE };
  if (answer.decision === "allow_session") {
    const updatedPermissions = sessionScopedUpdates(suggestions);
    return updatedPermissions.length > 0
      ? { behavior: "allow", updatedInput: input, updatedPermissions }
      : { behavior: "allow", updatedInput: input };
  }
  return { behavior: "allow", updatedInput: input };
}

function truncate(text: string, max = MAX_PREVIEW_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** Human-readable preview for the permission card. Masking happens at egress, not here. */
export function previewToolInput(toolName: string, input: Record<string, unknown>): string {
  const field = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  if (toolName === "Bash") return truncate(field("command") ?? JSON.stringify(input, null, 2));
  if (toolName === "Write") return truncate(`${field("file_path") ?? "?"}\n\n${field("content") ?? ""}`);
  if (toolName === "Edit") return truncate(`${field("file_path") ?? "?"}\n\n- ${field("old_string") ?? ""}\n+ ${field("new_string") ?? ""}`);
  if (toolName === "WebFetch") return truncate(field("url") ?? JSON.stringify(input));
  return truncate(JSON.stringify(input, null, 2));
}
