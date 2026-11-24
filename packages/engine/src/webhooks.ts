/** Outgoing webhooks: HMAC-signed, masked payloads, bounded retries with jittered backoff. */
import { createHmac } from "node:crypto";
import { hostname } from "node:os";
import type { EngineSettings, SessionSummary, WebhookConfig, WebhookEvent } from "@hub/protocol";
import type { LifecycleSink } from "./events.ts";
import { log } from "./log.ts";
import { maskText } from "./masking.ts";

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;
const BACKOFF_FACTOR = 4;
const JITTER_RATIO = 0.3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_CHARS = 4_000;

export interface WebhookPayload {
  event: WebhookEvent;
  device: string;
  sentAt: string;
  session: {
    id: string;
    name: string;
    labels: string[];
    status: string;
    endReason: string | null;
    origin: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    usageLimit: SessionSummary["usageLimit"];
    lastMessage: string | null;
  };
}

/** Signature over `${timestamp}.${body}` so receivers can reject replays outside a time window. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function buildPayload(event: WebhookEvent, session: SessionSummary, lastMessage: string | null, now: Date): WebhookPayload {
  return {
    event,
    device: hostname(),
    sentAt: now.toISOString(),
    session: {
      id: session.id,
      name: maskText(session.name),
      labels: session.labels,
      status: session.status,
      endReason: session.endReason,
      origin: session.origin,
      costUsd: session.costUsd,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      usageLimit: session.usageLimit,
      lastMessage: lastMessage ? maskText(lastMessage).slice(0, MAX_MESSAGE_CHARS) : null,
    },
  };
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WebhookDispatcher implements LifecycleSink {
  constructor(
    private readonly settings: () => EngineSettings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = realSleep,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  lifecycle(event: WebhookEvent, session: SessionSummary, lastMessage: string | null): void {
    const targets = this.settings().webhooks.filter((hook) => hook.enabled && hook.events.includes(event));
    if (targets.length === 0) return;
    const body = JSON.stringify(buildPayload(event, session, lastMessage, new Date()));
    for (const target of targets) {
      this.deliver(target, body).catch((err: unknown) => log.error("webhook delivery crashed", { err, webhookId: target.id }));
    }
  }

  /** Returns true when the endpoint accepted the delivery (2xx). 4xx other than 408/429 is not retried. */
  async deliver(target: WebhookConfig, body: string): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const outcome = await this.attempt(target, body, attempt);
      if (outcome === "delivered") return true;
      if (outcome === "fatal") return false;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = BASE_BACKOFF_MS * BACKOFF_FACTOR ** (attempt - 1);
        await this.sleep(backoff + Math.floor(Math.random() * backoff * JITTER_RATIO));
      }
    }
    return false;
  }

  private async attempt(target: WebhookConfig, body: string, attempt: number): Promise<"delivered" | "retry" | "fatal"> {
    const timestamp = String(this.nowSeconds());
    try {
      const response = await this.fetchImpl(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "session-hub-webhook/1",
          "x-session-hub-timestamp": timestamp,
          "x-session-hub-signature": signPayload(target.secret, timestamp, body),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return "delivered";
      log.warn("webhook rejected", { webhookId: target.id, status: response.status, attempt });
      return response.status >= 500 || response.status === 408 || response.status === 429 ? "retry" : "fatal";
    } catch (err) {
      log.warn("webhook request failed", { webhookId: target.id, attempt, err });
      return "retry";
    }
  }
}
