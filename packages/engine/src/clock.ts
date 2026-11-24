/** Injectable time source so policy timers and timestamps are deterministic in tests. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
};
