import { supportedHarnessIds as coreSupportedHarnessIds } from "@station/setup-core";
import { describe, expect, it } from "vitest";
import { harnessDefinitions } from "../../src/commands/setup/checks/harnesses.js";
import {
  SetupHarnessSelectionSourceSchema,
  SetupHarnessTrackingFactSchema,
  supportedHarnessIds,
} from "../../src/commands/setup/model.js";

describe("setup model", () => {
  it("keeps supported harness ids aligned with setup detection", () => {
    expect(supportedHarnessIds).toBe(coreSupportedHarnessIds);
    expect([...supportedHarnessIds]).toEqual(harnessDefinitions.map((harness) => harness.id));
    expect([...supportedHarnessIds]).not.toContain("crush");
  });

  it("strictly parses selection sources and tracking facts", () => {
    expect(SetupHarnessSelectionSourceSchema.parse("configured")).toBe("configured");
    expect(() => SetupHarnessSelectionSourceSchema.parse("catalog-first")).toThrow();

    const unsupported = SetupHarnessTrackingFactSchema.parse({
      harnessId: "pi",
      capability: "unsupported",
      detail: "No external artifact.",
    });
    expect("requested" in unsupported).toBe(false);
    expect("installed" in unsupported).toBe(false);
    expect("probeFailed" in unsupported).toBe(false);
    expect(() =>
      SetupHarnessTrackingFactSchema.parse({
        harnessId: "pi",
        capability: "unsupported",
        installed: false,
      }),
    ).toThrow();
    expect(() =>
      SetupHarnessTrackingFactSchema.parse({
        harnessId: "codex",
        capability: "supported",
        requested: true,
        installed: true,
        extra: true,
      }),
    ).toThrow();
  });
});
