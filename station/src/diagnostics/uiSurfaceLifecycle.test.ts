import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentLogPath, createJsonlLogger, readJsonlLog } from "@station/observability";
import { describe, expect, it } from "bun:test";
import { createStationStore } from "../state/store.js";
import { createUiLifecycleWitness } from "./uiLifecycle.js";
import {
  observeUiSurfaceLifecycle,
  selectUiLifecycleSurface,
} from "./uiSurfaceLifecycle.js";

const uiRunContext = {
  uiRunId: "ui_11111111-1111-4111-8111-111111111111",
  rendererPid: 4242,
  clientKind: "native_renderer" as const,
};

async function createHarness(
  name: string,
  options: { boot?: "empty"; welcomeIntroOnBoot?: boolean } = {},
) {
  const stateDir = await mkdtemp(join(tmpdir(), `${name}-`));
  const logger = createJsonlLogger({
    component: "tui",
    path: componentLogPath(stateDir, "tui"),
  });
  const witness = createUiLifecycleWitness({ logger, context: uiRunContext });
  const store = createStationStore(options);
  await witness.ready(selectUiLifecycleSurface(store.getState()));
  const stop = observeUiSurfaceLifecycle({ store, witness });
  return { stateDir, store, witness, stop };
}

async function lifecycleChanges(harness: Awaited<ReturnType<typeof createHarness>>) {
  await Promise.resolve();
  await harness.witness.flush();
  const records = await readJsonlLog(join(harness.stateDir, "logs", "tui.jsonl"));
  return records.flatMap((record) =>
    record.lifecycle?.kind === "ui.surface.changed" ? [record.lifecycle] : [],
  );
}

describe("UI surface lifecycle observer", () => {
  it("records context-menu and store-driven overlay transitions", async () => {
    const harness = await createHarness("station-ui-surface-overlay");

    harness.store.actions.openContextMenu({ kind: "header" }, { x: 2, y: 3 });
    expect(
      (await lifecycleChanges(harness)).map(({ before, after, reason }) => ({
        before,
        after,
        reason,
      })),
    ).toEqual([
      { before: "workspace", after: "context_menu", reason: "overlay_open" },
    ]);

    harness.store.actions.closeContextMenu();
    harness.store.actions.openOverlay("station");
    expect(
      (await lifecycleChanges(harness)).map(({ before, after, reason }) => ({
        before,
        after,
        reason,
      })),
    ).toEqual([
      { before: "workspace", after: "context_menu", reason: "overlay_open" },
      { before: "context_menu", after: "station_overlay", reason: "overlay_open" },
    ]);
    harness.stop();
  });

  it("uses state_change when the welcome intro is dismissed", async () => {
    const harness = await createHarness("station-ui-surface-welcome", {
      welcomeIntroOnBoot: true,
    });

    harness.store.actions.dismissWelcomeIntro();

    expect(
      (await lifecycleChanges(harness)).map(({ before, after, reason }) => ({
        before,
        after,
        reason,
      })),
    ).toEqual([
      { before: "welcome", after: "workspace", reason: "state_change" },
    ]);
    harness.stop();
  });

  it("records the visible welcome surface for an empty boot", async () => {
    const harness = await createHarness("station-ui-surface-empty", { boot: "empty" });
    const records = await readJsonlLog(join(harness.stateDir, "logs", "tui.jsonl"));

    expect(records[0]?.lifecycle).toMatchObject({ kind: "ui.ready", surface: "welcome" });

    harness.store.actions.openOverlay("station");
    await lifecycleChanges(harness);
    harness.store.actions.closeOverlay();
    expect(
      (await lifecycleChanges(harness)).map(({ before, after, reason }) => ({
        before,
        after,
        reason,
      })),
    ).toEqual([
      { before: "welcome", after: "station_overlay", reason: "overlay_open" },
      { before: "station_overlay", after: "welcome", reason: "overlay_close" },
    ]);
    harness.stop();
  });

  it("does not report an open-close transition that never survives the turn", async () => {
    const harness = await createHarness("station-ui-surface-transient");

    harness.store.actions.openOverlay("station");
    harness.store.actions.closeOverlay();

    expect(await lifecycleChanges(harness)).toEqual([]);
    harness.stop();
  });
});
