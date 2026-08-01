import {
  emptySetupOperationCheckpoints,
  hasCompletedSetupOperation,
  recordCompletedSetupOperation,
} from "@station/setup-core";
import { describe, expect, it } from "vitest";

describe("setup operation checkpoints", () => {
  it("retains each completed operation id only once", () => {
    const first = recordCompletedSetupOperation(emptySetupOperationCheckpoints, {
      operationId: "link-station-launchers",
    });
    const duplicate = recordCompletedSetupOperation(first, {
      operationId: "link-station-launchers",
    });

    expect(hasCompletedSetupOperation(first, "link-station-launchers")).toBe(true);
    expect(duplicate).toEqual(first);
    expect(duplicate).toHaveLength(1);
  });
});
