import { describe, expect, it } from "bun:test";
import { createSessionReaper } from "./sessionReaper.js";
import { createStationStore } from "../store.js";
import type { PaneId } from "../types.js";

/** Store with two agent sessions; the first also carries a split shell. */
function twoSessionStore() {
  const store = createStationStore({ boot: "empty" });
  store.actions.createPane("agent-1", { role: "primary-agent" });
  store.actions.setPrimaryAgent("agent-1", { sessionId: "s1", terminalTargetId: "t1" });
  store.actions.createPane("sh-1", { split: { anchorPaneId: "agent-1", direction: "right" } });
  store.actions.createPane("agent-2", { role: "primary-agent" });
  store.actions.setPrimaryAgent("agent-2", { sessionId: "s2", terminalTargetId: "t2" });
  return store;
}

describe("createSessionReaper", () => {
  it("closes a session's panes and switches once the observer drops it", () => {
    const store = twoSessionStore();
    store.actions.focusPane("agent-1");
    let live = new Set(["s1", "s2"]);
    const killed: PaneId[] = [];
    const reap = createSessionReaper({
      store,
      liveSessionIds: () => live,
      observerInstanceId: () => "obs-1",
      killPane: (paneId) => killed.push(paneId),
    });

    reap(); // both sessions seen live
    live = new Set(["s2"]); // observer removes session 1
    reap();

    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual(["agent-2"]);
    expect(store.getState().workspace.activePaneId).toBe("agent-2");
    // Both of the removed session's panes are killed before their records drop.
    expect(killed.sort()).toEqual(["agent-1", "sh-1"]);
  });

  it("re-baselines on observer restart instead of reaping the empty pre-reconcile snapshot", () => {
    const store = twoSessionStore();
    let live: ReadonlySet<string> = new Set(["s1", "s2"]);
    let instance = "obs-A";
    const killed: PaneId[] = [];
    const reap = createSessionReaper({
      store,
      liveSessionIds: () => live,
      observerInstanceId: () => instance,
      killPane: (paneId) => killed.push(paneId),
    });

    reap(); // baseline: both sessions seen live under obs-A

    // Observer restarts: a new instance serves an empty snapshot until its
    // startup reconcile lands. The live agent panes must survive that window.
    instance = "obs-B";
    live = new Set<string>();
    reap();

    expect(store.getState().workspace.panes).toHaveLength(3);
    expect(killed).toEqual([]);

    // Reconcile repopulates the graph, then a genuine removal under the same
    // instance still reaps.
    live = new Set(["s1", "s2"]);
    reap();
    live = new Set(["s2"]);
    reap();

    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual(["agent-2"]);
    expect(killed.sort()).toEqual(["agent-1", "sh-1"]);
  });

  it("never reaps a session that has not yet appeared in the snapshot (launch race)", () => {
    const store = createStationStore({ boot: "empty" });
    store.actions.createPane("agent-1", { role: "primary-agent" });
    store.actions.setPrimaryAgent("agent-1", { sessionId: "s1", terminalTargetId: "t1" });
    const killed: PaneId[] = [];
    // The just-launched session is absent from the snapshot; without a prior
    // live sighting it must not be mistaken for a removal.
    const reap = createSessionReaper({
      store,
      liveSessionIds: () => new Set<string>(),
      observerInstanceId: () => "obs-1",
      killPane: (paneId) => killed.push(paneId),
    });

    reap();

    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual(["agent-1"]);
    expect(killed).toEqual([]);
  });

  it("is a no-op before the first snapshot load", () => {
    const store = twoSessionStore();
    const reap = createSessionReaper({
      store,
      liveSessionIds: () => undefined,
      observerInstanceId: () => "obs-1",
      killPane: () => {},
    });

    reap();

    expect(store.getState().workspace.panes).toHaveLength(3);
  });

  it("ignores panes without a managed identity", () => {
    const store = createStationStore({ boot: "empty" });
    store.actions.createPane("plain-shell", { role: "shell" });
    const killed: PaneId[] = [];
    const reap = createSessionReaper({
      store,
      liveSessionIds: () => new Set<string>(),
      observerInstanceId: () => "obs-1",
      killPane: (paneId) => killed.push(paneId),
    });

    reap();

    expect(store.getState().workspace.panes.map((pane) => pane.id)).toEqual(["plain-shell"]);
    expect(killed).toEqual([]);
  });
});
