/**
 * Detects a turn that ended by asking the user something in plain text. In `claude -p` runs the model
 * cannot use AskUserQuestion (it is not offered without a permission host), so it asks in prose; the
 * hub then shows the session as waiting for a reply instead of "done".
 */

/** Characters that may trail the question mark: markdown emphasis, quotes, brackets, whitespace. */
const TRAILING = String.raw`[\s*_~\x60"'”’»)\]]*`;
/** "…?" optionally followed by a short parenthetical such as "(A or B)". */
const QUESTION_END = new RegExp(String.raw`[?？]${TRAILING}(?:\([^()\n]{0,80}\)${TRAILING})?$`);
const FENCE = /^\s*(```|~~~)/;
const MAX_QUESTION_LINE = 600;

/** The last line of prose, ignoring trailing blank lines and anything inside a fenced code block. */
function lastProseLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let insideFence = false;
  let last: string | null = null;
  for (const line of lines) {
    if (FENCE.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (!insideFence && line.trim() !== "") last = line.trim();
  }
  return insideFence ? null : last;
}

export function endsWithQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const line = lastProseLine(text);
  if (!line || line.length > MAX_QUESTION_LINE) return false;
  return QUESTION_END.test(line);
}

/** Added to `claude -p` runs started by `hubctl run`, where AskUserQuestion is unavailable. */
export const PLAIN_QUESTION_HINT =
  "This run is unattended and supervised through Session Hub. If you need a decision or information from the user, finish your reply with exactly one clear question on its own last line, ending with a question mark, and stop.";

/** Added to app sessions, where AskUserQuestion is available and shows up as a card in the hub. */
export const ASK_TOOL_HINT =
  "When you need a decision or information from the user, use the AskUserQuestion tool instead of asking in plain text; the user answers it from Session Hub.";
