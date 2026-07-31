import { describe, expect, it } from "vitest";
import {
  type HarnessTrackingRepairFact,
  selectHarnessTrackingRepairTargets,
} from "../../src/index.js";

describe("selectHarnessTrackingRepairTargets", () => {
  const harnesses: readonly HarnessTrackingRepairFact[] = [
    {
      id: "codex",
      available: true,
      capability: "supported",
      prepared: false,
    },
    {
      id: "cursor",
      available: false,
      capability: "supported",
      prepared: false,
    },
    {
      id: "opencode",
      available: true,
      capability: "supported",
      prepared: false,
    },
    {
      id: "pi",
      available: true,
      capability: "unsupported",
      prepared: false,
    },
    {
      id: "claude",
      available: true,
      capability: "supported",
      prepared: true,
    },
  ];

  it("preserves required-then-persisted order while deduplicating", () => {
    expect(
      selectHarnessTrackingRepairTargets({
        requiredHarnessIds: ["opencode", "codex", "opencode"],
        persistedTrackingHarnessIds: ["codex", "opencode"],
        harnesses,
      }),
    ).toEqual(["opencode", "codex"]);
  });

  it("repairs a configured secondary harness only when persisted intent requests it", () => {
    expect(
      selectHarnessTrackingRepairTargets({
        requiredHarnessIds: ["codex"],
        persistedTrackingHarnessIds: ["opencode"],
        harnesses,
      }),
    ).toEqual(["codex", "opencode"]);
    expect(
      selectHarnessTrackingRepairTargets({
        requiredHarnessIds: ["codex"],
        persistedTrackingHarnessIds: [],
        harnesses,
      }),
    ).toEqual(["codex"]);
  });

  it("ignores unknown, unavailable, unsupported, and prepared targets", () => {
    expect(
      selectHarnessTrackingRepairTargets({
        requiredHarnessIds: ["cursor", "pi", "claude"],
        persistedTrackingHarnessIds: ["custom", "codex"],
        harnesses,
      }),
    ).toEqual(["codex"]);
  });
});
