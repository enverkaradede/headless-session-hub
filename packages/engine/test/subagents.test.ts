import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { translate } from "../src/sessions/translate.ts";
import { ACTOR, makeHarness, msg, waitFor } from "./helpers.ts";

const AGENT_CALL = "toolu_agent_1";
const sdk = (value: Record<string, unknown>) => value as unknown as SDKMessage;

describe("subagent transcript translation", () => {
  it("keeps subagent text, tool calls and results on the subagent's own track", () => {
    const assistant = translate(sdk({
      type: "assistant",
      parent_tool_use_id: AGENT_CALL,
      message: { content: [{ type: "text", text: "Looking for auth files" }, { type: "tool_use", id: "toolu_inner", name: "Grep", input: { pattern: "jwt" } }] },
    }));
    expect(assistant.drafts.map((draft) => [draft.kind, draft.parentToolUseId])).toEqual([
      ["assistant_text", AGENT_CALL],
      ["tool_use", AGENT_CALL],
    ]);
    // Subagent text must not overwrite the main conversation's preview line.
    expect(assistant.preview).toBeUndefined();

    const result = translate(sdk({ type: "user", parent_tool_use_id: AGENT_CALL, message: { content: [{ type: "tool_result", tool_use_id: "toolu_inner", content: "src/auth.ts" }] } }));
    expect(result.drafts[0]).toMatchObject({ kind: "tool_result", toolUseId: "toolu_inner", parentToolUseId: AGENT_CALL });

    const prompt = translate(sdk({ type: "user", parent_tool_use_id: AGENT_CALL, message: { content: "Find the auth files" } }));
    expect(prompt.drafts[0]).toMatchObject({ kind: "user_message", text: "Find the auth files", parentToolUseId: AGENT_CALL });
  });

  it("turns task lifecycle messages into subagent status events", () => {
    const started = translate(sdk({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: AGENT_CALL, description: "Find auth files", subagent_type: "Explore" }));
    expect(started.drafts[0]).toMatchObject({ kind: "status", parentToolUseId: AGENT_CALL, data: { subagent: { state: "started", subagentType: "Explore" } } });

    // Real CLI 2.1.331 sends the live activity in `description` and no `summary` (spike, 2026-11-24).
    const progress = translate(sdk({ type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: AGENT_CALL, description: "Reading a.txt", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }));
    expect(progress.drafts[0]).toMatchObject({ text: "Reading a.txt", data: { subagent: { state: "progress", summary: "Reading a.txt" } } });
    const empty = translate(sdk({ type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: AGENT_CALL, description: "", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }));
    expect(empty.drafts).toHaveLength(0);

    const done = translate(sdk({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: AGENT_CALL, status: "completed", summary: "Found 3 files", output_file: "", usage: { total_tokens: 900, tool_uses: 4, duration_ms: 10 } }));
    expect(done.drafts[0]).toMatchObject({ text: "Found 3 files", data: { subagent: { state: "completed", toolUses: 4, totalTokens: 900 } } });
  });

  it("does not store the same progress summary twice", async () => {
    const progress = { type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: AGENT_CALL, description: "d", summary: "Reading files", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } };
    const h = makeHarness([
      async function* (ctx) {
        await ctx.nextUserText();
        yield sdk(progress);
        yield sdk(progress);
        yield sdk({ ...progress, summary: "Writing summary" });
        yield msg.result("ok");
        await ctx.nextUserText();
      },
    ]);
    const session = await h.manager.start({ cwd: h.workDir, prompt: "go" }, ACTOR);
    await waitFor(() => h.manager.get(session.id).status === "done");
    const statuses = h.manager.timeline(session.id, 0, 100).filter((event) => event.kind === "status").map((event) => event.text);
    expect(statuses).toEqual(["Reading files", "Writing summary"]);
    expect(h.fake.calls[0]?.forwardSubagentText).toBe(true);
  });
});

describe("database migration v1 → v2", () => {
  it("adds subagent columns to an existing database without losing rows", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hub-migrate-")), "engine.sqlite");
    const v1 = new DatabaseSync(file);
    v1.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '[]', cwd TEXT NOT NULL, profile_id TEXT NOT NULL, model TEXT, permission_mode TEXT, origin TEXT NOT NULL, status TEXT NOT NULL, end_reason TEXT, error_message TEXT, usage_limit TEXT, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, last_message_preview TEXT, launch TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, tool_name TEXT, tool_use_id TEXT, data TEXT);
      CREATE TABLE requests (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, tool_name TEXT NOT NULL, tool_use_id TEXT, input TEXT NOT NULL, questions TEXT, suggestions TEXT, blocked_path TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, policy TEXT NOT NULL, answer TEXT, answered_by TEXT, answered_at INTEGER);
      CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, session_id TEXT, request_id TEXT, detail TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO sessions (id, name, cwd, profile_id, origin, status, created_at, last_activity_at) VALUES ('s1', 'old', '/tmp', 'default', 'app', 'done', 1, 1);
      INSERT INTO events (session_id, ts, kind, text) VALUES ('s1', 1, 'assistant_text', 'kept');
      PRAGMA user_version = 1;`);
    v1.close();

    const store = new Store(file);
    expect(store.timeline("s1", 0, 10)).toEqual([expect.objectContaining({ text: "kept", parentToolUseId: null })]);
    store.close();
  });
});

describe("background subagents", () => {
  it("does not end or close the session while a backgrounded subagent is still running", async () => {
    const bg = (count: number) => sdk({ type: "system", subtype: "background_tasks_changed", tasks: Array.from({ length: count }, (_, i) => ({ task_id: `t${i}`, task_type: "local_agent", description: "d" })) });
    let closedEarly = false;
    let statusAfterFirstResult = "";
    const sessionIdRef = { value: "" };
    const h = makeHarness(
      [
        async function* (ctx) {
          await ctx.nextUserText();
          yield bg(1);
          yield msg.result("The subagent is still working.");
          statusAfterFirstResult = h.manager.get(sessionIdRef.value).status;
          // Input must stay open: a closed stream here would kill the background subagent.
          const raced = await Promise.race([ctx.nextUserText().then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("open"), 30))]);
          closedEarly = raced === "closed";
          yield bg(0);
          yield msg.result("Both files read.");
          await ctx.nextUserText();
        },
      ],
      { settings: { warmIdleMinutes: 0 } },
    );
    const session = await h.manager.start({ cwd: h.workDir, prompt: "go" }, ACTOR);
    sessionIdRef.value = session.id;
    await waitFor(() => h.manager.get(session.id).status === "done" && !h.manager.get(session.id).live, 20_000);
    expect(closedEarly).toBe(false);
    expect(statusAfterFirstResult).toBe("running");
    expect(h.lifecycle.filter((entry) => entry.event === "session.completed")).toHaveLength(1);
  });
});

