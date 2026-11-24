/** Typed engine error carried across RPC/HTTP boundaries with a stable code. */
import type { ErrorCode } from "@hub/protocol";

export class EngineError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EngineError";
    this.code = code;
  }
}

/** HTTP status for each error code, used by the local API. */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  DIRECTORY_NOT_ALLOWED: 403,
  AUTH_BLOCKED: 412,
  CLAUDE_NOT_FOUND: 424,
  INTERNAL: 500,
};
