import { describe, expect, it } from "bun:test";
import { createPaneReconciler } from "./reconcilePanes.js";
import { createStationStore } from "../store.js";
import type { PtyRegistry, PtyRegistryEntry } from "../../terminal/registry/ptyRegistry.js";
import { MAIN_PANE_ID, type PaneId } from "../types.js";

/** Records ensure/dispose calls and reports current entries; the only registry
 * surface the reconciler touches. */
function fakeRegistry() {
  const live = new Set<PaneId>();
  const ensured: PaneId[] = [];
  const disposed: PaneId[] = [];
  const registry = {
    ensure: (paneId: PaneId) => {
      ensured.push(paneId);
      live.add(paneId);
    },
    entries: (): readonly PtyRegistryEntry[] =>
      [...live].map((paneId) => ({ paneId }) as PtyRegistryEntry),
    dispose: (paneId: PaneId) => {
      disposed.push(paneId);
      live.delete(paneId);
    },
  } as unknown as PtyRegistry;
  return { registry, ensured, disposed, live };
}

describe("createPaneReconciler", () => {
  it("ensures created panes and disposes closed ones", () => {
    const store = createStationStore();
    const { registry, ensured, disposed } = fakeRegistry();
    const reconcile = createPaneReconciler(store, registry);

    reconcile();
    expect(ensured).toEqual([MAIN_PANE_ID]);

    store.actions.createPane("pane-2", { split: { anchorPaneId: MAIN_PANE_ID, direction: "right" } });
    reconcile();
    expect(ensured).toContain("pane-2");

    store.actions.closePane("pane-2");
    reconcile();
    expect(disposed).toEqual(["pane-2"]);
  });

  it("skips work when the panes reference is unchanged", () => {
    const store = createStationStore();
    const { registry, ensured } = fakeRegistry();
    const reconcile = createPaneReconciler(store, registry);

    reconcile();
    const afterFirst = ensured.length;
    // No structural change ⇒ same array reference ⇒ no further ensure calls.
    store.actions.showToast("noop");
    reconcile();
    expect(ensured.length).toBe(afterFirst);
  });
});
