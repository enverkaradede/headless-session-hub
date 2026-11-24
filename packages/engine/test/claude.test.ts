import { describe, expect, it } from "vitest";
import { authAllowsStart, buildChildEnv, classifyAuth } from "../src/claude.ts";
import { isInside } from "../src/paths.ts";

const NOW = 1_800_000_000_000;

describe("buildChildEnv", () => {
  const base = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "should-not-pass",
    anthropic_auth_token: "lowercase-too",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDECODE: "1",
    CLAUDE_CONFIG_DIR: "/somewhere/else",
  };

  it("strips API-key, provider and nesting variables by default", () => {
    const env = buildChildEnv({ profile: null, allowNonSubscriptionAuth: false, base });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("never lets a caller re-inject an API key through extra env", () => {
    const env = buildChildEnv({ profile: null, allowNonSubscriptionAuth: false, base, extra: { ANTHROPIC_API_KEY: "x", FOO: "bar" } });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.FOO).toBe("bar");
  });

  it("points the CLI at the profile's config directory", () => {
    const env = buildChildEnv({ profile: { id: "p", name: "P", configDir: "/Users/ayşe/.claude-personal" }, allowNonSubscriptionAuth: false, base });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/ayşe/.claude-personal");
  });

  it("keeps the API key only when the owner explicitly allowed non-subscription auth", () => {
    const env = buildChildEnv({ profile: null, allowNonSubscriptionAuth: true, base });
    expect(env.ANTHROPIC_API_KEY).toBe("should-not-pass");
  });
});

describe("classifyAuth", () => {
  it.each([
    ['{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"x@y"}', 0, "subscription"],
    ['{"loggedIn":true,"authMethod":"oauth_token"}', 0, "subscription"],
    ['{"loggedIn":true,"authMethod":"api_key"}', 0, "api_key"],
    ['{"loggedIn":true,"authMethod":"api_key_helper"}', 0, "api_key"],
    ['{"loggedIn":true,"authMethod":"third_party"}', 0, "third_party"],
    ['{"loggedIn":false,"authMethod":"none"}', 1, "not_logged_in"],
    ["not json", 0, "unknown"],
  ])("maps %s (exit %d) to %s", (stdout, exitCode, method) => {
    expect(classifyAuth("p", exitCode, stdout, NOW).method).toBe(method);
  });

  it("never copies identity fields into the stored detail", () => {
    const state = classifyAuth("p", 0, '{"authMethod":"claude.ai","subscriptionType":"max","email":"someone@example.com","orgName":"Org"}', NOW);
    expect(JSON.stringify(state)).not.toMatch(/example\.com|Org/);
  });

  it("only lets non-subscription methods start with explicit owner approval", () => {
    const apiKey = classifyAuth("p", 0, '{"authMethod":"api_key"}', NOW);
    expect(authAllowsStart(apiKey, false)).toBe(false);
    expect(authAllowsStart(apiKey, true)).toBe(true);
    expect(authAllowsStart(classifyAuth("p", 1, "{}", NOW), true)).toBe(false);
  });
});

describe("isInside", () => {
  it("is case-insensitive on Windows and handles Turkish characters", () => {
    expect(isInside("C:\\Users\\AyşeŞahin\\Repo\\app", "c:\\users\\ayşeşahin\\repo", "win32")).toBe(true);
    expect(isInside("C:\\Users\\AyşeŞahin\\Repo-evil", "C:\\Users\\AyşeŞahin\\Repo", "win32")).toBe(false);
  });
  it("rejects prefix siblings and parents on POSIX", () => {
    expect(isInside("/srv/app", "/srv/app")).toBe(true);
    expect(isInside("/srv/app-evil", "/srv/app")).toBe(false);
    expect(isInside("/srv", "/srv/app")).toBe(false);
  });
});
