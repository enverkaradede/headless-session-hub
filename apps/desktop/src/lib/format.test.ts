import { describe, expect, it } from "vitest";
import { loginCommand, modelPreset } from "./format";

describe("modelPreset", () => {
  it("keeps aliases and the profile default as they are", () => {
    expect(modelPreset("haiku")).toBe("haiku");
    expect(modelPreset("")).toBe("");
  });

  it("maps the full ids a running session reports to their family", () => {
    expect(modelPreset("claude-haiku-5-5")).toBe("haiku");
    expect(modelPreset("claude-opus-5-5[1m]")).toBe("opus");
    expect(modelPreset("Claude-Sonnet-5-5")).toBe("sonnet");
  });

  it("treats anything else as a custom model", () => {
    expect(modelPreset("claude-fable-5-2")).toBeNull();
    expect(modelPreset("claude-opusx")).toBeNull();
    expect(modelPreset("my-proxy-model")).toBeNull();
  });
});

describe("loginCommand", () => {
  it("opens Claude under the profile's folder on macOS and Linux", () => {
    expect(loginCommand("~/.claude-work", "darwin", "/Users/a/.local/bin/claude")).toBe("CLAUDE_CONFIG_DIR=~/.claude-work /Users/a/.local/bin/claude");
    expect(loginCommand("/Volumes/My Disk/claude", "linux")).toBe('CLAUDE_CONFIG_DIR="/Volumes/My Disk/claude" claude');
    expect(loginCommand(null, "darwin")).toBe("claude");
  });

  it("uses PowerShell syntax on Windows", () => {
    expect(loginCommand("C:\\Users\\Ayşe\\.claude-work", "win32", "C:\\Users\\Ayşe\\.local\\bin\\claude.exe")).toBe(
      '$env:CLAUDE_CONFIG_DIR="C:\\Users\\Ayşe\\.claude-work"; & "C:\\Users\\Ayşe\\.local\\bin\\claude.exe"',
    );
    expect(loginCommand(null, "win32")).toBe("claude");
  });
});
