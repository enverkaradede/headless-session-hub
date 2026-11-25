import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { translate } from "../src/sessions/translate.ts";
import { msg } from "./helpers.ts";

describe("translate: results", () => {
  it("adds a 'turn finished' line for a real turn", () => {
    const translation = translate(msg.result("All done."));
    expect(translation.drafts.map((draft) => draft.kind)).toEqual(["result"]);
    expect(translation.result?.costUsd).toBe(0.01);
  });

  it("adds no line for the empty zero-turn result the CLI sends when it closes, but still reports it", () => {
    const closing = msg.result("", { num_turns: 0, stop_reason: null }) as SDKMessage;
    const translation = translate(closing);
    expect(translation.drafts).toEqual([]);
    expect(translation.result).not.toBeNull();
  });

  it("keeps a zero-turn result that has something to say", () => {
    expect(translate(msg.result("Compacted.", { num_turns: 0 })).drafts).toHaveLength(1);
  });
});
