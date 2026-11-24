import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, type EngineSettings } from "@hub/protocol";
import { describe, expect, it } from "vitest";
import { CatalogService, toCatalogCommands } from "../src/catalog.ts";
import type { QueryFn } from "../src/sessions/manager.ts";
import { ManualClock } from "./helpers.ts";

const COMMANDS = [
  { name: "compact", description: "Compact the conversation", argumentHint: "<instructions>", builtin: true },
  { name: "__remote-workflow", description: "internal", argumentHint: "", builtin: true },
  { name: "review-pr", description: "Review a pull request", argumentHint: "<id>" },
  { name: "figma:figma-use", description: "(figma) Use Figma" },
];

function setup(settingsPatch: Partial<EngineSettings> = {}) {
  const workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "hub-catalog-")));
  const clock = new ManualClock();
  const calls: Options[] = [];
  let release: (() => void) | null = null;
  const queryFn = ((params: { options: Options }) => {
    calls.push(params.options);
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { initializationResult: async () => (await gate, { commands: COMMANDS }) } as unknown as Query;
  }) as unknown as QueryFn;
  const settings: EngineSettings = { ...DEFAULT_SETTINGS, allowedDirectories: [workDir], ...settingsPatch };
  const catalog = new CatalogService({ queryFn, clock, settings: () => settings, executable: async () => "/usr/local/bin/claude", childEnv: () => ({ MARK: "1" }), neutralDir: path.join(workDir, "neutral") });
  const releaseAll = async () => {
    for (let i = 0; i < 20 && !release; i++) await new Promise((resolve) => setImmediate(resolve));
    release?.();
    release = null;
  };
  return { workDir, clock, calls, catalog, releaseAll };
}

describe("toCatalogCommands", () => {
  it("drops internal commands, marks built-ins and sorts by name", () => {
    expect(toCatalogCommands(COMMANDS).map((command) => [command.name, command.builtin])).toEqual([
      ["compact", true],
      ["figma:figma-use", false],
      ["review-pr", false],
    ]);
  });
});

describe("CatalogService", () => {
  it("reads the list from a prompt-less process in a neutral folder, without persisting a session", async () => {
    const t = setup();
    const pending = t.catalog.list({});
    await t.releaseAll();
    const catalog = await pending;
    expect(catalog.commands.map((command) => command.name)).toContain("review-pr");
    expect(catalog.cwd).toBeNull();
    expect(t.calls[0]).toMatchObject({ cwd: path.join(t.workDir, "neutral"), persistSession: false, env: { MARK: "1" } });
  });

  it("shares one probe between concurrent callers and serves the cache until it expires", async () => {
    const t = setup();
    const first = t.catalog.list({});
    const second = t.catalog.list({});
    await t.releaseAll();
    await Promise.all([first, second]);
    await t.catalog.list({});
    expect(t.calls).toHaveLength(1);

    t.clock.advance(5 * 60_000 + 1);
    const third = t.catalog.list({});
    await t.releaseAll();
    await third;
    expect(t.calls).toHaveLength(2);
  });

  it("probes a project folder only inside the allowed directories", async () => {
    const t = setup();
    await expect(t.catalog.list({ cwd: realpathSync(tmpdir()) })).rejects.toMatchObject({ code: "DIRECTORY_NOT_ALLOWED" });
    expect(t.calls).toHaveLength(0);
    const inside = t.catalog.list({ cwd: t.workDir });
    await t.releaseAll();
    expect((await inside).cwd).toBe(t.workDir);
    expect(t.calls[0]?.cwd).toBe(t.workDir);
  });

  it("rejects an unknown profile", async () => {
    const t = setup();
    await expect(t.catalog.list({ profileId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
