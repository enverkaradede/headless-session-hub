/** Structured JSON-lines logger on stderr; stdout is reserved for the engine protocol. */
import { maskText } from "./masking.ts";

type Level = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: Level = (process.env.HUB_LOG_LEVEL as Level | undefined) ?? "info";

function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { err: { name: err.name, message: maskText(err.message), stack: err.stack } };
  return err === undefined ? {} : { err: maskText(String(err)) };
}

function write(level: Level, msg: string, ctx: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const { err, ...rest } = ctx;
  const line = { ts: new Date().toISOString(), level, msg, ...rest, ...errorFields(err) };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => write("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => write("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => write("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => write("error", msg, ctx),
};
