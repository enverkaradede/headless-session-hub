import type { CatalogCommand } from "@hub/protocol";
import { describe, expect, it } from "vitest";
import { applyCommand, commandQuery, leadingCommand, mergeCatalogs, rankEntries, type CatalogSource } from "./commands";

const mac: CatalogSource = { device: "local", deviceLabel: "Mac", profileId: "personal", profileLabel: "Kişisel", cwd: null };
const office: CatalogSource = { device: "office", deviceLabel: "Ofis", profileId: "default", profileLabel: "Varsayılan", cwd: null };
const cmd = (name: string, builtin = false, description = ""): CatalogCommand => ({ name, description, argumentHint: "", builtin });

describe("commandQuery", () => {
  it("opens only while the first token is being typed", () => {
    expect(commandQuery("/", 1)).toBe("");
    expect(commandQuery("/rev", 4)).toBe("rev");
    expect(commandQuery("/review-pr 12", 13)).toBeNull();
    expect(commandQuery("fix /rev", 8)).toBeNull();
    expect(commandQuery("/rev", 2)).toBe("r");
  });
});

describe("applyCommand", () => {
  it("replaces the token and keeps the rest of the prompt", () => {
    expect(applyCommand("/rev", "review-pr")).toEqual({ text: "/review-pr ", caret: 11 });
    expect(applyCommand("/rev  please check 12", "review-pr")).toEqual({ text: "/review-pr please check 12", caret: 11 });
  });
  it("reads the leading command back", () => {
    expect(leadingCommand("/review-pr 12")).toBe("review-pr");
    expect(leadingCommand("review")).toBeNull();
  });
});

describe("mergeCatalogs + rankEntries", () => {
  const entries = mergeCatalogs([
    { source: mac, commands: [cmd("compact", true), cmd("review-pr"), cmd("home-lab")] },
    { source: office, commands: [cmd("compact", true), cmd("review-pr"), cmd("figma:figma-use", false, "Use Figma")] },
  ]);

  it("lists built-ins once and a skill once per device that has it", () => {
    expect(entries.filter((entry) => entry.name === "compact")).toHaveLength(1);
    expect(entries.filter((entry) => entry.name === "review-pr").map((entry) => entry.owner?.deviceLabel)).toEqual(["Mac", "Ofis"]);
  });

  it("matches the prefix (also after a plugin namespace) and puts skills before built-ins", () => {
    expect(rankEntries(entries, "figma").map((entry) => entry.name)).toEqual(["figma:figma-use"]);
    expect(rankEntries(entries, "use").map((entry) => entry.name)).toEqual(["figma:figma-use"]);
    expect(rankEntries(entries, "").at(-1)?.name).toBe("compact");
    expect(rankEntries(entries, "zzz")).toEqual([]);
  });
});
