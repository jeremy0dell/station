import type { TuiControlIntent, TuiKey, TuiStore } from "@station/dashboard-core";
import { describe, expect, it } from "bun:test";
import type { StoreApi } from "zustand/vanilla";
import { manyProjectsSnapshot } from "../station/fixtures/scenarios.js";
import { makeStationTestStore } from "../station/test/support/makeStationTestStore.js";
import { executeDashboardControlIntent } from "./dashboardEffects.js";
import { createDashboardSequenceHandler } from "./inputBridge.js";

function harness(resultIntent?: TuiControlIntent): {
  handle: (sequence: string) => boolean;
  keys: TuiKey[];
  intents: TuiControlIntent[];
} {
  const keys: TuiKey[] = [];
  const intents: TuiControlIntent[] = [];
  const store = {
    getState: () => ({
      handleKey: (key: TuiKey) => {
        keys.push(key);
        return {
          dismissPopup: false,
          ...(resultIntent === undefined ? {} : { controlIntent: resultIntent }),
        };
      },
    }),
  } as unknown as StoreApi<TuiStore>;
  return {
    handle: createDashboardSequenceHandler(store, (intent) => intents.push(intent)),
    keys,
    intents,
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    if (assertion()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createDashboardSequenceHandler", () => {
  it("dispatches printable keys, Enter, and arrows", () => {
    const { handle, keys } = harness();
    expect(handle("5")).toBe(true);
    expect(handle("\r")).toBe(true);
    expect(handle("\x1b[A")).toBe(true);
    expect(keys).toEqual([
      { input: "5" },
      { input: "\r", return: true },
      { input: "", upArrow: true },
    ]);
  });

  it("forwards each keyboard-produced control intent exactly once", () => {
    const intent = { type: "projectShell.open", projectId: "station" } as const;
    const { handle, intents } = harness(intent);

    expect(handle("\r")).toBe(true);
    expect(intents).toEqual([intent]);
  });

  it("executes standalone project shell and Quick Session effects from keyboard focus", async () => {
    const shellFixture = makeStationTestStore({ snapshot: manyProjectsSnapshot() });
    const openedShells: string[] = [];
    const effects = {
      openShell: ({ cwd }: { cwd: string }) => openedShells.push(cwd),
      openUrl: () => {},
    };
    const shell = createDashboardSequenceHandler(shellFixture.store, (intent) => {
      executeDashboardControlIntent(intent, shellFixture.store, effects);
    });
    shell("\x1b[B");
    shell("\x1b[C");
    shell("\r");
    expect(openedShells).toEqual(["/Users/example/Developer/station"]);

    const quickFixture = makeStationTestStore({ snapshot: manyProjectsSnapshot() });
    const quick = createDashboardSequenceHandler(quickFixture.store, (intent) => {
      executeDashboardControlIntent(intent, quickFixture.store, effects);
    });
    quick("\x1b[B");
    quick("\x1b[C");
    quick("\x1b[C");
    quick("\r");
    await waitFor(() =>
      quickFixture.service.dispatched.some((command) => command.type === "session.create"),
    );
    expect(
      quickFixture.service.dispatched.filter((command) => command.type === "session.create"),
    ).toHaveLength(1);
  });

  it("swallows terminal query replies without dispatching", () => {
    const { handle, keys } = harness();
    expect(handle("\x1b[1;1R")).toBe(true); // cursor position report
    expect(keys).toEqual([]);
  });

  it("swallows sequences the dashboard has no vocabulary for", () => {
    const { handle, keys } = harness();
    expect(handle("\x1b[Z")).toBe(true); // Shift-Tab: no dashboard binding
    expect(keys).toEqual([]);
  });
});
