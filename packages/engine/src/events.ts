/** In-process fan-out of engine events to transports, webhooks and notifications. */
import type { EngineEvent, SessionSummary, WebhookEvent } from "@hub/protocol";
import { log } from "./log.ts";

export type EngineListener = (event: EngineEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EngineListener>();

  on(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.error("event listener failed", { err, type: event.type });
      }
    }
  }
}

/** Receives session lifecycle transitions (drives webhooks and desktop notifications). */
export interface LifecycleSink {
  lifecycle(event: WebhookEvent, session: SessionSummary, lastMessage: string | null): void;
}
