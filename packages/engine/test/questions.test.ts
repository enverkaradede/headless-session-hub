import { describe, expect, it } from "vitest";
import { endsWithQuestion } from "../src/sessions/questions.ts";

describe("endsWithQuestion", () => {
  it.each([
    ["Which database should I use?"],
    ["I found two options.\n\nShould I go with **Postgres**?"],
    ["Hangisini tercih edersin?"],
    ["Proceed with the migration? (yes/no)"],
    ["Want me to continue? 🙂".replace(" 🙂", "")],
    ["Do you want A or B?\n\n"],
    ["> Shall I open a PR?"],
    ["Devam edeyim mi？"],
  ])("detects a question at the end: %j", (text) => {
    expect(endsWithQuestion(text)).toBe(true);
  });

  it.each([
    ["Done. All tests pass."],
    ["Why did it fail? Because the port was taken. Fixed it."],
    ["Here is the query:\n```sql\nSELECT * FROM t WHERE a = ?\n```"],
    ["Unclosed fence makes it unsafe to judge:\n```\nwhat?"],
    [""],
    [null],
  ])("does not flag non-questions: %j", (text) => {
    expect(endsWithQuestion(text)).toBe(false);
  });
});
