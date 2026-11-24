import { beforeEach, describe, expect, it, vi } from "vitest";

// The store talks to the Tauri shell; these tests only exercise navigation, so stub the IPC boundary.
vi.mock("../ipc", () => ({
  LOCAL: "local",
  rpc: vi.fn(async () => []),
  shell: {},
  onEngineEvent: vi.fn(),
  onEngineStatus: vi.fn(),
  onPeersChanged: vi.fn(),
}));

const { hub } = await import("../store");

describe("leave guard (unsaved new-session form)", () => {
  beforeEach(() => {
    hub.clearLeaveGuard();
    hub.cancelLeave();
    hub.setView({ kind: "new" }, { force: true });
  });

  it("navigates freely when the form is clean", () => {
    const remove = hub.setLeaveGuard(() => false);
    hub.setView({ kind: "home" });
    expect(hub.getState().view).toEqual({ kind: "home" });
    expect(hub.getState().pendingView).toBeNull();
    remove();
  });

  it("holds any navigation (Esc, sidebar, settings) while the form is dirty", () => {
    hub.setLeaveGuard(() => true);
    hub.setView({ kind: "settings" });
    expect(hub.getState().view).toEqual({ kind: "new" });
    expect(hub.getState().pendingView).toEqual({ kind: "settings" });
  });

  it("'Kal' keeps the form, 'Sil ve çık' goes where the owner was heading", () => {
    hub.setLeaveGuard(() => true);
    hub.setView({ kind: "home" });
    hub.cancelLeave();
    expect(hub.getState().view).toEqual({ kind: "new" });
    expect(hub.getState().pendingView).toBeNull();

    hub.setView({ kind: "settings" });
    hub.confirmLeave();
    expect(hub.getState().view).toEqual({ kind: "settings" });
    expect(hub.getState().pendingView).toBeNull();
  });

  it("does not ask after a successful start", () => {
    hub.setLeaveGuard(() => true);
    hub.clearLeaveGuard();
    hub.setView({ kind: "home" });
    expect(hub.getState().view).toEqual({ kind: "home" });
  });

  it("a stale remover does not drop a newer screen's guard", () => {
    const removeOld = hub.setLeaveGuard(() => true);
    hub.setLeaveGuard(() => true);
    removeOld();
    hub.setView({ kind: "home" });
    expect(hub.getState().pendingView).toEqual({ kind: "home" });
  });
});
