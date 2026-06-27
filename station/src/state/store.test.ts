import { describe, expect, it } from "bun:test";
import { selectWelcomeCanContinue, selectWelcomeVisible } from "./selectors.js";
import { createStationStore } from "./store.js";
import { MAIN_PANE_ID, STATION_OVERLAY_ID, type PaneRecord, type PaneRole } from "./types.js";

const AGENT_IDENTITY = { sessionId: "ses_a", terminalTargetId: "native:wt_a" };

describe("createStationStore initialWorkspace (cold-boot rehydration)", () => {
  it("seats restored panes/active and lands focus on the active pane", () => {
    const panes: PaneRecord[] = [
      { id: "pane-main", split: null, role: "shell" },
      { id: "pane-split-0", split: { anchorPaneId: "pane-main", direction: "right" }, role: "shell" },
    ];
    const store = createStationStore({
      initialWorkspace: { panes, activePaneId: "pane-split-0" },
    });

    expect(store.getState().workspace.panes).toEqual(panes);
    expect(store.getState().workspace.activePaneId).toBe("pane-split-0");
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-split-0" });
  });

  it("seats an empty restored workspace as empty", () => {
    const store = createStationStore({
      initialWorkspace: { panes: [], activePaneId: null },
    });
    expect(store.getState().workspace.panes).toEqual([]);
    expect(store.getState().workspace.activePaneId).toBeNull();
    expect(store.getState().input.focus).toEqual({ kind: "welcome" });
  });

  it("lands focus on the title when the restored workspace has no active pane", () => {
    const store = createStationStore({
      initialWorkspace: {
        panes: [{ id: "pane-x", split: null, role: "shell" }],
        activePaneId: null,
      },
    });
    expect(store.getState().input.focus).toEqual({ kind: "header", region: "title" });
  });
});

function createCountingStore() {
  const store = createStationStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  return { store, count: () => notifications };
}

function createCountingEmptyStore() {
  const store = createStationStore({ boot: "empty" });
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  return { store, count: () => notifications };
}

function paneRecord(
  id: string,
  split: PaneRecord["split"] = null,
  role: PaneRole = "shell",
): PaneRecord {
  return { id, split, role };
}

describe("createStationStore", () => {
  it("boots with the main pane focused and no overlay", () => {
    const store = createStationStore();
    const state = store.getState();
    expect(state.workspace.panes).toEqual([paneRecord(MAIN_PANE_ID)]);
    expect(state.workspace.activePaneId).toEqual(MAIN_PANE_ID);
    expect(state.input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
    expect(state.input.activeOverlay).toBeNull();
  });

  it("can explicitly boot empty for the welcome screen", () => {
    const store = createStationStore({ boot: "empty" });
    const state = store.getState();
    expect(state.workspace.panes).toEqual([]);
    expect(state.workspace.activePaneId).toBeNull();
    expect(state.input.focus).toEqual({ kind: "welcome" });
    expect(state.input.activeOverlay).toBeNull();
    expect(state.input.overlayReturnFocus).toBeNull();
  });

  it("boots with no intro by default so a plain boot lands on its pane", () => {
    const state = createStationStore().getState();
    expect(state.input.introVisible).toBe(false);
    expect(selectWelcomeVisible(state)).toBe(false);
    expect(selectWelcomeCanContinue(state)).toBe(false);
  });

  it("welcomeIntroOnBoot shows the intro over a restored layout, sessions intact", () => {
    const store = createStationStore({
      initialWorkspace: {
        panes: [paneRecord("pane-a"), paneRecord("pane-b")],
        activePaneId: "pane-a",
      },
      welcomeIntroOnBoot: true,
    });
    const state = store.getState();
    // Intro owns input (welcome focus), restored sessions sit untouched beneath.
    expect(state.input.introVisible).toBe(true);
    expect(state.input.focus).toEqual({ kind: "welcome" });
    expect(state.workspace.panes).toHaveLength(2);
    expect(selectWelcomeVisible(state)).toBe(true);
    expect(selectWelcomeCanContinue(state)).toBe(true);
  });

  it("dismissWelcomeIntro drops the intro and focuses the active pane", () => {
    const store = createStationStore({
      initialWorkspace: { panes: [paneRecord("pane-a")], activePaneId: "pane-a" },
      welcomeIntroOnBoot: true,
    });
    store.actions.dismissWelcomeIntro();
    const state = store.getState();
    expect(state.input.introVisible).toBe(false);
    expect(state.input.focus).toEqual({ kind: "pane", paneId: "pane-a" });
    expect(selectWelcomeVisible(state)).toBe(false);
  });

  it("welcomeIntroOnBoot with no sessions offers nothing to continue into", () => {
    const state = createStationStore({ boot: "empty", welcomeIntroOnBoot: true }).getState();
    expect(state.input.introVisible).toBe(true);
    expect(selectWelcomeVisible(state)).toBe(true);
    expect(selectWelcomeCanContinue(state)).toBe(false);
  });

  it("keeps getState reference-stable between actions and replaces it per change", () => {
    const store = createStationStore();
    const before = store.getState();
    expect(store.getState()).toBe(before);
    store.actions.openOverlay(STATION_OVERLAY_ID);
    expect(store.getState()).not.toBe(before);
    const after = store.getState();
    expect(store.getState()).toBe(after);
  });

  it("ignores focusPane for unknown panes without notifying", () => {
    const { store, count } = createCountingStore();
    const before = store.getState();
    store.actions.focusPane("pane-unknown");
    expect(store.getState()).toBe(before);
    expect(count()).toEqual(0);
  });

  it("does not notify when focusPane targets the already-focused pane", () => {
    const { store, count } = createCountingStore();
    store.actions.focusPane(MAIN_PANE_ID);
    expect(count()).toEqual(0);
  });

  it("createPane appends an overlay-opened pane as its own root session and focuses it", () => {
    const store = createStationStore();
    store.actions.createPane("pane-second");
    const state = store.getState();
    // No explicit split = an overlay-opened session/shell: it roots its OWN
    // session (split: null) so the renderer shows it full-screen rather than
    // tiling it against the focused pane.
    expect(state.workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-second"),
    ]);
    expect(state.workspace.activePaneId).toEqual("pane-second");
    expect(state.input.focus).toEqual({ kind: "pane", paneId: "pane-second" });
  });

  it("createPane roots each overlay-opened pane as its own session (no auto-tiling)", () => {
    const store = createStationStore();
    store.actions.createPane("pane-2");
    store.actions.createPane("pane-3");
    store.actions.createPane("pane-4");
    // Repeated opens never tile against each other: every one is a split:null
    // root, i.e. its own full-screen session. Tiling now requires an explicit
    // split (manual split-right/below within the active session).
    expect(store.getState().workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-2"),
      paneRecord("pane-3"),
      paneRecord("pane-4"),
    ]);
  });

  it("createPane records split metadata for a valid anchor", () => {
    const store = createStationStore();
    store.actions.createPane("pane-right", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    const state = store.getState();
    expect(state.workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-right", { anchorPaneId: MAIN_PANE_ID, direction: "right" }),
    ]);
    expect(state.workspace.activePaneId).toEqual("pane-right");
    expect(state.input.focus).toEqual({ kind: "pane", paneId: "pane-right" });
  });

  it("createPane is a silent no-op for a pane that already exists", () => {
    const { store, count } = createCountingStore();
    const before = store.getState();
    store.actions.createPane(MAIN_PANE_ID);
    expect(store.getState()).toBe(before);
    expect(count()).toEqual(0);
  });

  it("createPane is a silent no-op when split metadata points at an unknown anchor", () => {
    const { store, count } = createCountingStore();
    const before = store.getState();
    store.actions.createPane("pane-orphan", {
      split: { anchorPaneId: "pane-missing", direction: "below" },
    });
    expect(store.getState()).toBe(before);
    expect(count()).toEqual(0);
  });

  it("createPane keeps the existing record when a duplicate supplies new metadata", () => {
    const { store, count } = createCountingStore();
    store.actions.createPane("pane-right", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    const created = store.getState();
    const baseline = count();
    store.actions.createPane("pane-right", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "below" },
    });
    expect(store.getState()).toBe(created);
    expect(count()).toEqual(baseline);
    expect(store.getState().workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-right", { anchorPaneId: MAIN_PANE_ID, direction: "right" }),
    ]);
  });

  it("createPane under an open overlay queues the pane without stealing focus", () => {
    const store = createStationStore();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    store.actions.createPane("pane-shell");
    const state = store.getState();
    expect(state.workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-shell"),
    ]);
    expect(state.workspace.activePaneId).toEqual("pane-shell");
    // The overlay keeps focus; the new pane becomes the return target.
    expect(state.input.focus).toEqual({ kind: "overlay", overlayId: STATION_OVERLAY_ID });
    expect(state.input.overlayReturnFocus).toEqual({ kind: "pane", paneId: "pane-shell" });
    // Closing the overlay lands on the queued pane, not the original.
    store.actions.closeOverlay();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-shell" });
  });

  it("revealPane is overlay-aware: queues under an overlay, focuses without one", () => {
    const store = createStationStore();
    store.actions.createPane("pane-shell");
    store.actions.focusPane(MAIN_PANE_ID);
    // No overlay: revealPane focuses + activates like a plain switch.
    store.actions.revealPane("pane-shell");
    expect(store.getState().workspace.activePaneId).toEqual("pane-shell");
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-shell" });

    // Under an overlay: queue the return target, leave focus on the overlay.
    store.actions.focusPane(MAIN_PANE_ID);
    store.actions.openOverlay(STATION_OVERLAY_ID);
    store.actions.revealPane("pane-shell");
    const state = store.getState();
    expect(state.workspace.activePaneId).toEqual("pane-shell");
    expect(state.input.focus).toEqual({ kind: "overlay", overlayId: STATION_OVERLAY_ID });
    expect(state.input.overlayReturnFocus).toEqual({ kind: "pane", paneId: "pane-shell" });
    store.actions.closeOverlay();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-shell" });
  });

  it("revealPane is a silent no-op for unknown panes and for the already-active pane", () => {
    const { store, count } = createCountingStore();
    store.actions.revealPane("pane-unknown");
    expect(count()).toEqual(0);
    // MAIN is already active and focused with no overlay: nothing changes.
    const before = store.getState();
    store.actions.revealPane(MAIN_PANE_ID);
    expect(store.getState()).toBe(before);
    expect(count()).toEqual(0);
  });

  it("revealPane under an overlay is a no-op once the pane is active and already queued", () => {
    const { store, count } = createCountingStore();
    store.actions.createPane("pane-shell"); // active + focus pane-shell (no overlay)
    store.actions.openOverlay(STATION_OVERLAY_ID); // records overlayReturnFocus = pane-shell
    // pane-shell is active AND already the queued return target: nothing to do.
    const before = store.getState();
    const baseline = count();
    store.actions.revealPane("pane-shell");
    expect(store.getState()).toBe(before);
    expect(count()).toEqual(baseline);
  });

  it("closePane drops an overlayReturnFocus that points at the removed pane", () => {
    const store = createStationStore();
    store.actions.createPane("pane-shell");
    store.actions.openOverlay(STATION_OVERLAY_ID);
    expect(store.getState().input.overlayReturnFocus).toEqual({ kind: "pane", paneId: "pane-shell" });
    store.actions.closePane("pane-shell");
    expect(store.getState().input.overlayReturnFocus).toBeNull();
    // closeOverlay must land on a surviving pane, not the removed return target.
    store.actions.closeOverlay();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("closePane moves children of a closed root pane to the root slot", () => {
    const store = createStationStore();
    store.actions.createPane("pane-anchor");
    store.actions.createPane("pane-child", {
      split: { anchorPaneId: "pane-anchor", direction: "below" },
    });
    store.actions.closePane("pane-anchor");
    expect(store.getState().workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-child"),
    ]);
  });

  it("closePane preserves a left/right layout after closing one stacked right pane", () => {
    const store = createStationStore();
    store.actions.createPane("pane-right-top", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    store.actions.createPane("pane-right-bottom", {
      split: { anchorPaneId: "pane-right-top", direction: "below" },
    });

    store.actions.closePane("pane-right-top");

    expect(store.getState().workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-right-bottom", { anchorPaneId: MAIN_PANE_ID, direction: "right" }),
    ]);
  });

  it("closePane retargets active to a session sibling, not another session's pane", () => {
    const store = createStationStore();
    // A second session (its own root) created BEFORE the aux pane, so the old
    // index-based neighbor would jump focus here when the aux pane closes.
    store.actions.createPane("pane-mouse");
    store.actions.createPane("pane-aux", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    expect(store.getState().workspace.activePaneId).toEqual("pane-aux");

    store.actions.closePane("pane-aux");

    const state = store.getState();
    // Back to the aux pane's own session (its anchor), not the 'mouse' session.
    expect(state.workspace.activePaneId).toEqual(MAIN_PANE_ID);
    expect(state.input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("closePane removes the pane and retargets active + focus to a survivor", () => {
    const store = createStationStore();
    store.actions.createPane("pane-second");
    store.actions.closePane("pane-second");
    const state = store.getState();
    expect(state.workspace.panes).toEqual([paneRecord(MAIN_PANE_ID)]);
    expect(state.workspace.activePaneId).toEqual(MAIN_PANE_ID);
    expect(state.input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("closePane on a non-active pane leaves active and focus untouched", () => {
    const store = createStationStore();
    store.actions.createPane("pane-second");
    store.actions.focusPane(MAIN_PANE_ID);
    store.actions.closePane("pane-second");
    const state = store.getState();
    expect(state.workspace.panes).toEqual([paneRecord(MAIN_PANE_ID)]);
    expect(state.workspace.activePaneId).toEqual(MAIN_PANE_ID);
    expect(state.input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("preserves split metadata through focusPane and revealPane", () => {
    const store = createStationStore();
    store.actions.createPane("pane-right", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    store.actions.focusPane(MAIN_PANE_ID);
    store.actions.revealPane("pane-right");
    store.actions.focusPane(MAIN_PANE_ID);
    expect(store.getState().workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-right", { anchorPaneId: MAIN_PANE_ID, direction: "right" }),
    ]);
  });

  it("focusNextPane cycles within the active session's panes and wraps", () => {
    const store = createStationStore();
    // Both panes split MAIN's session, so all three share one forest tree.
    store.actions.createPane("pane-b", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    store.actions.createPane("pane-c", {
      split: { anchorPaneId: "pane-b", direction: "below" },
    });
    store.actions.focusPane(MAIN_PANE_ID);
    store.actions.focusNextPane();
    expect(store.getState().workspace.activePaneId).toEqual("pane-b");
    store.actions.focusNextPane();
    expect(store.getState().workspace.activePaneId).toEqual("pane-c");
    store.actions.focusNextPane();
    expect(store.getState().workspace.activePaneId).toEqual(MAIN_PANE_ID);
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("focusNextPane stays in the active session and never jumps to another session", () => {
    const store = createStationStore();
    // pane-b is a second session root (split: null); pane-a2 shares MAIN's
    // session. pane-b sits between them in creation order, so a global cycle
    // would land on it first — the session scope must skip it.
    store.actions.createPane("pane-b");
    store.actions.createPane("pane-a2", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    store.actions.focusPane(MAIN_PANE_ID);
    store.actions.focusNextPane();
    expect(store.getState().workspace.activePaneId).toEqual("pane-a2");
    store.actions.focusNextPane();
    expect(store.getState().workspace.activePaneId).toEqual(MAIN_PANE_ID);
  });

  it("focusNextPane is a no-op when the active session has a single pane", () => {
    const store = createStationStore();
    // A sibling session exists, but MAIN's session has only MAIN.
    store.actions.createPane("pane-b");
    store.actions.focusPane(MAIN_PANE_ID);
    const before = store.getState();
    store.actions.focusNextPane();
    expect(store.getState()).toBe(before);
  });

  it("focusNextPane is a silent no-op with a single pane", () => {
    const { store, count } = createCountingStore();
    const before = store.getState();
    store.actions.focusNextPane();
    expect(store.getState()).toBe(before);
    expect(count()).toEqual(0);
  });

  it("focusNextPane under an overlay queues the next pane without stealing focus", () => {
    const store = createStationStore();
    store.actions.createPane("pane-b", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    store.actions.focusPane(MAIN_PANE_ID);
    store.actions.openOverlay(STATION_OVERLAY_ID);
    store.actions.focusNextPane();
    const state = store.getState();
    expect(state.workspace.activePaneId).toEqual("pane-b");
    expect(state.input.focus).toEqual({ kind: "overlay", overlayId: STATION_OVERLAY_ID });
    expect(state.input.overlayReturnFocus).toEqual({ kind: "pane", paneId: "pane-b" });
    store.actions.closeOverlay();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-b" });
  });

  it("focusNextPane preserves split metadata", () => {
    const store = createStationStore();
    store.actions.createPane("pane-right", {
      split: { anchorPaneId: MAIN_PANE_ID, direction: "right" },
    });
    store.actions.focusPane(MAIN_PANE_ID);
    store.actions.focusNextPane();
    expect(store.getState().workspace.panes).toEqual([
      paneRecord(MAIN_PANE_ID),
      paneRecord("pane-right", { anchorPaneId: MAIN_PANE_ID, direction: "right" }),
    ]);
  });

  it("closePane of the last pane clears active and falls back off pane focus", () => {
    const store = createStationStore();
    store.actions.closePane(MAIN_PANE_ID);
    const state = store.getState();
    expect(state.workspace.panes).toEqual([]);
    expect(state.workspace.activePaneId).toBeNull();
    expect(state.input.focus).toEqual({ kind: "welcome" });
  });

  it("opens and closes the STATION overlay from empty boot back to welcome focus", () => {
    const { store, count } = createCountingEmptyStore();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    let state = store.getState();
    expect(state.input.activeOverlay).toEqual(STATION_OVERLAY_ID);
    expect(state.input.focus).toEqual({ kind: "overlay", overlayId: STATION_OVERLAY_ID });
    expect(state.input.overlayReturnFocus).toBeNull();

    store.actions.closeOverlay();
    state = store.getState();
    expect(state.workspace.panes).toEqual([]);
    expect(state.workspace.activePaneId).toBeNull();
    expect(state.input.activeOverlay).toBeNull();
    expect(state.input.overlayReturnFocus).toBeNull();
    expect(state.input.focus).toEqual({ kind: "welcome" });
    expect(count()).toEqual(2);
  });

  it("creating the first pane under the overlay queues it as the return focus", () => {
    const store = createStationStore({ boot: "empty" });
    store.actions.openOverlay(STATION_OVERLAY_ID);

    store.actions.createPane("pane-first");

    const state = store.getState();
    expect(state.workspace.panes).toEqual([paneRecord("pane-first")]);
    expect(state.workspace.activePaneId).toEqual("pane-first");
    expect(state.input.focus).toEqual({ kind: "overlay", overlayId: STATION_OVERLAY_ID });
    expect(state.input.overlayReturnFocus).toEqual({ kind: "pane", paneId: "pane-first" });

    store.actions.closeOverlay();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: "pane-first" });
  });

  it("closePane is a silent no-op for an unknown pane", () => {
    const { store, count } = createCountingStore();
    store.actions.closePane("pane-unknown");
    expect(count()).toEqual(0);
  });

  it("closePaneTree tears down the agent pane plus its splits and switches sessions", () => {
    const store = createStationStore({ boot: "empty" });
    store.actions.createPane("agent-1");
    store.actions.setPrimaryAgent("agent-1", { sessionId: "s1", terminalTargetId: "t1" });
    store.actions.createPane("sh-1", { split: { anchorPaneId: "agent-1", direction: "right" } });
    store.actions.createPane("agent-2");
    store.actions.setPrimaryAgent("agent-2", { sessionId: "s2", terminalTargetId: "t2" });

    store.actions.closePaneTree("agent-2");

    const state = store.getState();
    // The removed session's panes are gone; session 1 (agent + its shell) stays.
    expect(state.workspace.panes.map((pane) => pane.id)).toEqual(["agent-1", "sh-1"]);
    expect(state.workspace.activePaneId).toEqual("agent-1");
    expect(state.input.focus).toEqual({ kind: "pane", paneId: "agent-1" });
  });

  it("closePaneTree removes every split pane sharing the session's forest tree", () => {
    const store = createStationStore({ boot: "empty" });
    store.actions.createPane("agent-1");
    store.actions.setPrimaryAgent("agent-1", { sessionId: "s1", terminalTargetId: "t1" });
    store.actions.createPane("sh-1", { split: { anchorPaneId: "agent-1", direction: "right" } });
    store.actions.createPane("agent-2");
    store.actions.setPrimaryAgent("agent-2", { sessionId: "s2", terminalTargetId: "t2" });

    // Removing the non-active session leaves the active one untouched.
    store.actions.closePaneTree("agent-1");

    const state = store.getState();
    expect(state.workspace.panes.map((pane) => pane.id)).toEqual(["agent-2"]);
    expect(state.workspace.activePaneId).toEqual("agent-2");
    expect(state.input.focus).toEqual({ kind: "pane", paneId: "agent-2" });
  });

  it("closePaneTree of the only session clears active and lands on welcome", () => {
    const store = createStationStore({ boot: "empty" });
    store.actions.createPane("agent-1");
    store.actions.setPrimaryAgent("agent-1", { sessionId: "s1", terminalTargetId: "t1" });

    store.actions.closePaneTree("agent-1");

    const state = store.getState();
    expect(state.workspace.panes).toEqual([]);
    expect(state.workspace.activePaneId).toBeNull();
    expect(state.input.focus).toEqual({ kind: "welcome" });
  });

  it("closePaneTree switches to a surviving session that still has an agent", () => {
    const store = createStationStore({ boot: "empty" });
    store.actions.createPane("shell-x"); // a shell-only session survivor
    store.actions.createPane("agent-y");
    store.actions.setPrimaryAgent("agent-y", { sessionId: "s-y", terminalTargetId: "t-y" });
    store.actions.createPane("agent-z");
    store.actions.setPrimaryAgent("agent-z", { sessionId: "s-z", terminalTargetId: "t-z" });

    store.actions.closePaneTree("agent-z");

    // Prefers the agent session over the earlier shell-only survivor.
    expect(store.getState().workspace.activePaneId).toEqual("agent-y");
  });

  it("closePaneTree is a silent no-op for an unknown pane", () => {
    const { store, count } = createCountingStore();
    store.actions.closePaneTree("pane-unknown");
    expect(count()).toEqual(0);
  });

  it("openOverlay records the pane focus and focuses the overlay", () => {
    const store = createStationStore();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    const state = store.getState();
    expect(state.input.activeOverlay).toEqual(STATION_OVERLAY_ID);
    expect(state.input.focus).toEqual({ kind: "overlay", overlayId: STATION_OVERLAY_ID });
    expect(state.input.overlayReturnFocus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("openOverlay is idempotent when the overlay is already active", () => {
    const { store, count } = createCountingStore();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    const opened = store.getState();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    expect(store.getState()).toBe(opened);
    expect(count()).toEqual(1);
  });

  it("closeOverlay restores the recorded focus", () => {
    const store = createStationStore();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    store.actions.closeOverlay();
    const state = store.getState();
    expect(state.input.activeOverlay).toBeNull();
    expect(state.input.overlayReturnFocus).toBeNull();
    expect(state.input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("closeOverlay falls back to the active pane when nothing was recorded", () => {
    const store = createStationStore();
    store.actions.openContextMenu({ kind: "header" }, { x: 1, y: 1 });
    // Opening from non-pane focus records nothing to restore.
    store.actions.openOverlay(STATION_OVERLAY_ID);
    expect(store.getState().input.overlayReturnFocus).toBeNull();
    store.actions.closeOverlay();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("closeOverlay without an open overlay is a silent no-op", () => {
    const { store, count } = createCountingStore();
    store.actions.closeOverlay();
    expect(count()).toEqual(0);
  });

  it("toggleOverlay round-trips back to the original focus", () => {
    const store = createStationStore();
    store.actions.toggleOverlay(STATION_OVERLAY_ID);
    expect(store.getState().input.activeOverlay).toEqual(STATION_OVERLAY_ID);
    store.actions.toggleOverlay(STATION_OVERLAY_ID);
    const state = store.getState();
    expect(state.input.activeOverlay).toBeNull();
    expect(state.input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("notifies exactly once per state change", () => {
    const { store, count } = createCountingStore();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    store.actions.closeOverlay();
    expect(count()).toEqual(2);
  });

  it("unsubscribe stops notifications", () => {
    const store = createStationStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    unsubscribe();
    store.actions.openOverlay(STATION_OVERLAY_ID);
    expect(notifications).toEqual(0);
  });

  it("opens a pane context menu after activating the target pane", () => {
    const store = createStationStore();
    store.actions.createPane("pane-second");
    store.actions.focusPane(MAIN_PANE_ID);

    store.actions.openContextMenu({ kind: "pane", paneId: "pane-second" }, { x: 7, y: 4 });

    const state = store.getState();
    expect(state.workspace.activePaneId).toBe("pane-second");
    expect(state.input.focus).toEqual({ kind: "contextMenu" });
    expect(state.input.contextMenu).toEqual({
      target: { kind: "pane", paneId: "pane-second" },
      anchor: { x: 7, y: 4 },
      activeIndex: 0,
    });
  });

  it("opens a STATION context menu without stealing pane focus semantics", () => {
    const store = createStationStore();
    store.actions.createPane("pane-second");
    store.actions.focusPane(MAIN_PANE_ID);
    store.actions.openOverlay(STATION_OVERLAY_ID);

    store.actions.openContextMenu(
      { kind: "station", target: { kind: "projectHeader", projectId: "station" } },
      { x: 9, y: 5 },
    );

    const state = store.getState();
    expect(state.workspace.activePaneId).toBe(MAIN_PANE_ID);
    expect(state.input.overlayReturnFocus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
    expect(state.input.focus).toEqual({ kind: "contextMenu" });
  });

  it("moves context menu active index and closes back to the underlying focus", () => {
    const store = createStationStore();
    store.actions.openContextMenu({ kind: "pane", paneId: MAIN_PANE_ID }, { x: 1, y: 1 });

    store.actions.setContextMenuActiveIndex(2);
    expect(store.getState().input.contextMenu?.activeIndex).toBe(2);
    store.actions.closeContextMenu();

    expect(store.getState().input.contextMenu).toBeNull();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });

  it("clears stale context menus on pane close and overlay close", () => {
    const store = createStationStore();
    store.actions.createPane("pane-second");
    store.actions.openContextMenu({ kind: "pane", paneId: "pane-second" }, { x: 1, y: 1 });
    store.actions.closePane("pane-second");
    expect(store.getState().input.contextMenu).toBeNull();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });

    store.actions.openOverlay(STATION_OVERLAY_ID);
    store.actions.openContextMenu({ kind: "header" }, { x: 1, y: 1 });
    store.actions.closeOverlay();
    expect(store.getState().input.contextMenu).toBeNull();
    expect(store.getState().input.focus).toEqual({ kind: "pane", paneId: MAIN_PANE_ID });
  });
});

describe("createStationStore primary-agent bookkeeping", () => {
  const recordOf = (store: ReturnType<typeof createStationStore>, paneId: string) =>
    store.getState().workspace.panes.find((pane) => pane.id === paneId);
  const roleOf = (store: ReturnType<typeof createStationStore>, paneId: string) =>
    recordOf(store, paneId)?.role;

  it("seeds the boot pane as a shell with no agent identity", () => {
    const store = createStationStore();
    expect(roleOf(store, MAIN_PANE_ID)).toEqual("shell");
    expect(recordOf(store, MAIN_PANE_ID)?.agentIdentity).toBeUndefined();
  });

  it("createPane records the given role and defaults to shell", () => {
    const store = createStationStore();
    store.actions.createPane("pane-agent", { role: "primary-agent" });
    store.actions.createPane("pane-plain");
    expect(roleOf(store, "pane-agent")).toEqual("primary-agent");
    expect(roleOf(store, "pane-plain")).toEqual("shell");
  });

  it("setPrimaryAgent flips the role and stamps the identity onto the record", () => {
    const store = createStationStore();
    store.actions.createPane("pane-agent");
    store.actions.setPrimaryAgent("pane-agent", AGENT_IDENTITY);
    expect(roleOf(store, "pane-agent")).toEqual("primary-agent");
    expect(recordOf(store, "pane-agent")?.agentIdentity).toEqual(AGENT_IDENTITY);
  });

  it("setPrimaryAgent is a silent no-op for a non-member pane", () => {
    const { store, count } = createCountingStore();
    const before = store.getState();
    store.actions.setPrimaryAgent("pane-ghost", AGENT_IDENTITY);
    expect(store.getState()).toBe(before);
    expect(count()).toEqual(0);
  });

  it("setPrimaryAgent is a silent no-op when the same identity is already recorded", () => {
    const { store, count } = createCountingStore();
    store.actions.createPane("pane-agent");
    store.actions.setPrimaryAgent("pane-agent", AGENT_IDENTITY);
    const baseline = count();
    const settled = store.getState();
    store.actions.setPrimaryAgent("pane-agent", AGENT_IDENTITY);
    expect(store.getState()).toBe(settled);
    expect(count()).toEqual(baseline);
  });

  it("setPrimaryAgent preserves the provider when restamping the same agent without one", () => {
    const store = createStationStore();
    store.actions.createPane("pane-agent");
    store.actions.setPrimaryAgent("pane-agent", {
      sessionId: "ses_a",
      terminalTargetId: "native:wt_a",
      harnessProvider: "codex",
    });

    store.actions.setPrimaryAgent("pane-agent", {
      sessionId: "ses_a",
      terminalTargetId: "native:wt_a",
    });

    expect(recordOf(store, "pane-agent")?.agentIdentity).toEqual({
      sessionId: "ses_a",
      terminalTargetId: "native:wt_a",
      harnessProvider: "codex",
    });
  });

  it("setPrimaryAgent re-records when the identity changes", () => {
    const store = createStationStore();
    store.actions.createPane("pane-agent");
    store.actions.setPrimaryAgent("pane-agent", AGENT_IDENTITY);
    store.actions.setPrimaryAgent("pane-agent", {
      sessionId: "ses_b",
      terminalTargetId: "native:wt_a",
    });
    expect(recordOf(store, "pane-agent")?.agentIdentity?.sessionId).toEqual("ses_b");
  });

  it("setPrimaryAgent leaves focus and overlay untouched under an open overlay", () => {
    const store = createStationStore();
    store.actions.createPane("pane-agent");
    store.actions.openOverlay(STATION_OVERLAY_ID);
    const focusBefore = store.getState().input.focus;
    const returnBefore = store.getState().input.overlayReturnFocus;

    store.actions.setPrimaryAgent("pane-agent", AGENT_IDENTITY);

    const { input } = store.getState();
    expect(input.activeOverlay).toEqual(STATION_OVERLAY_ID);
    expect(input.focus).toEqual(focusBefore);
    expect(input.overlayReturnFocus).toEqual(returnBefore);
    expect(recordOf(store, "pane-agent")?.agentIdentity).toEqual(AGENT_IDENTITY);
  });

  it("closePane drops the pane record and its agent identity with it", () => {
    const store = createStationStore();
    store.actions.createPane("pane-agent", { role: "primary-agent" });
    store.actions.setPrimaryAgent("pane-agent", AGENT_IDENTITY);
    store.actions.closePane("pane-agent");
    expect(recordOf(store, "pane-agent")).toBeUndefined();
  });
});

describe("createStationStore toasts", () => {
  it("shows a toast with a fresh token and reference-changed state", () => {
    const store = createStationStore();
    const before = store.getState();
    store.actions.showToast("Copied 3 lines");
    const toast = store.getState().feedback.toast;
    expect(toast).toMatchObject({ message: "Copied 3 lines", kind: "info" });
    expect(store.getState()).not.toBe(before);

    store.actions.showToast("oops", "error");
    const next = store.getState().feedback.toast;
    expect(next?.kind).toBe("error");
    expect(next?.token).toBeGreaterThan(toast?.token ?? 0);
  });

  it("dismiss only clears the toast that still owns the token", () => {
    const store = createStationStore();
    store.actions.showToast("first");
    const firstToken = store.getState().feedback.toast?.token ?? -1;
    store.actions.showToast("second");

    // A stale timer firing for the first toast must not clear the second.
    store.actions.dismissToast(firstToken);
    expect(store.getState().feedback.toast?.message).toBe("second");

    const secondToken = store.getState().feedback.toast?.token ?? -1;
    store.actions.dismissToast(secondToken);
    expect(store.getState().feedback.toast).toBeNull();
  });
});
