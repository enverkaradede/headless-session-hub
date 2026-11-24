/**
 * Local HTTP API on 127.0.0.1 for hubctl, Claude Code hooks and automations.
 * Bearer-token auth; browser-originated requests are refused (no CORS, Origin rejected, Host pinned).
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ErrorCode } from "@hub/protocol";
import { z } from "zod";
import { EngineError, HTTP_STATUS } from "../errors.ts";
import { HookEnvelope, type CompatLayer } from "../hooks/compat.ts";
import { log } from "../log.ts";
import type { RpcDispatcher } from "../rpc.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = "127.0.0.1";
const DEFAULT_RESUME_TEXT = "Continue where you left off.";
const UUID_SEGMENT = "([0-9a-fA-F-]{36})";

interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pattern: RegExp;
  handle: (match: RegExpExecArray, body: unknown, url: URL, signal: AbortSignal) => Promise<unknown>;
}

function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new EngineError("BAD_REQUEST", "Request body too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new EngineError("BAD_REQUEST", "Body must be JSON");
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

const AnswerBody = z.object({ requestId: z.string().uuid(), answer: z.unknown() });
const MessageBody = z.object({ text: z.string().min(1) });
const ResumeBody = z.object({ text: z.string().min(1).optional() });

export class LocalApi {
  private server: Server | null = null;
  private readonly routes: Route[];

  constructor(
    private readonly token: string,
    rpc: RpcDispatcher,
    private readonly compat: CompatLayer,
  ) {
    const api = { kind: "api" as const };
    const call = (method: string, params: unknown) => rpc.dispatch(method, params, api);
    this.routes = [
      { method: "GET", pattern: /^\/v1\/info$/, handle: () => call("engine.info", {}) },
      {
        method: "GET",
        pattern: /^\/v1\/sessions$/,
        handle: (_m, _b, url) => {
          const status = url.searchParams.get("status");
          const label = url.searchParams.get("label");
          return call("sessions.list", { ...(status ? { status: status.split(",") } : {}), ...(label ? { label } : {}) });
        },
      },
      { method: "POST", pattern: /^\/v1\/sessions$/, handle: (_m, body) => call("sessions.start", body) },
      { method: "GET", pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}$`), handle: (m) => call("sessions.get", { sessionId: m[1] }) },
      {
        method: "PATCH",
        pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}$`),
        handle: (m, body) => call("sessions.update", { ...(body as object), sessionId: m[1] }),
      },
      {
        method: "GET",
        pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}/timeline$`),
        handle: (m, _b, url) => call("sessions.timeline", { sessionId: m[1], afterSeq: Number(url.searchParams.get("after") ?? 0) }),
      },
      { method: "GET", pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}/requests$`), handle: (m) => call("sessions.requests", { sessionId: m[1] }) },
      {
        method: "POST",
        pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}/answer$`),
        handle: (m, body) => {
          const parsed = AnswerBody.parse(body);
          return call("sessions.answer", { sessionId: m[1], requestId: parsed.requestId, answer: parsed.answer });
        },
      },
      {
        method: "POST",
        pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}/message$`),
        handle: (m, body) => call("sessions.message", { sessionId: m[1], text: MessageBody.parse(body).text }),
      },
      {
        method: "POST",
        pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}/resume$`),
        handle: (m, body) => call("sessions.message", { sessionId: m[1], text: ResumeBody.parse(body).text ?? DEFAULT_RESUME_TEXT }),
      },
      { method: "POST", pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}/stop$`), handle: (m) => call("sessions.stop", { sessionId: m[1] }) },
      { method: "DELETE", pattern: new RegExp(`^/v1/sessions/${UUID_SEGMENT}/queue$`), handle: (m) => call("sessions.clearQueue", { sessionId: m[1] }) },
      { method: "POST", pattern: /^\/v1\/hooks$/, handle: (_m, body, _u, signal) => this.compat.handle(HookEnvelope.parse(body), signal) },
    ];
  }

  async listen(port = 0): Promise<number> {
    this.server = createServer((req, res) => void this.onRequest(req, res));
    // Hook requests can legitimately wait ~10 minutes for a human.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 30_000;
    this.server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, LOOPBACK, () => resolve());
    });
    return (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (this.server?.address() as AddressInfo | null)?.port;
    const host = req.headers.host ?? "";
    if (req.headers.origin !== undefined || (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`)) {
      send(res, 403, { error: { code: "FORBIDDEN", message: "Browser or non-loopback requests are not accepted" } });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
    if (req.method === "GET" && url.pathname === "/v1/health") {
      send(res, 200, { ok: true });
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !tokensEqual(this.token, auth.slice("Bearer ".length))) {
      send(res, 401, { error: { code: "FORBIDDEN", message: "Missing or invalid token" } });
      return;
    }
    const route = this.routes.find((candidate) => candidate.method === req.method && candidate.pattern.test(url.pathname));
    if (!route) {
      send(res, 404, { error: { code: "NOT_FOUND", message: "No such endpoint" } });
      return;
    }
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) aborter.abort();
    });
    try {
      const match = route.pattern.exec(url.pathname) as RegExpExecArray;
      const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
      send(res, 200, await route.handle(match, body, url, aborter.signal));
    } catch (err) {
      this.sendError(res, err, url.pathname);
    }
  }

  private sendError(res: ServerResponse, err: unknown, pathname: string): void {
    if (err instanceof EngineError) {
      send(res, HTTP_STATUS[err.code], { error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof z.ZodError) {
      send(res, 400, { error: { code: ErrorCode.enum.BAD_REQUEST, message: err.issues.map((issue) => issue.message).join("; ") } });
      return;
    }
    log.error("local api request failed", { err, path: pathname });
    send(res, 500, { error: { code: "INTERNAL", message: "Internal error" } });
  }
}
