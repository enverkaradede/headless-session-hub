/** Push-based async iterable feeding user messages into a streaming-input Agent SDK query. */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  pushText(text: string): void {
    this.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("input queue is closed");
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
      return;
    }
    this.buffered.push(message);
  }

  /** Ends the stream; the CLI process exits once its current turn finishes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.buffered.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
