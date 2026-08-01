import {
  emptySetupOperationCheckpoints,
  hasCompletedSetupOperation,
  recordCompletedSetupOperation,
} from "@station/setup-core";
import { describe, expect, it } from "vitest";

describe("setup operation checkpoints", () => {
  it("retains only completed operation ids and their typed commit evidence", () => {
    const first = recordCompletedSetupOperation(emptySetupOperationCheckpoints, {
      operationId: "link-station-launchers",
      commit: { kind: "launcher-link" },
    });
    const duplicate = recordCompletedSetupOperation(first, {
      operationId: "link-station-launchers",
      commit: { kind: "launcher-link" },
    });

    expect(hasCompletedSetupOperation(first, "link-station-launchers")).toBe(true);
    expect(duplicate).toEqual(first);
    expect(duplicate).toHaveLength(1);
  });
});
