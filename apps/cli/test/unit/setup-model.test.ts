import { describe, expect, it } from "vitest";
import { harnessDefinitions } from "../../src/commands/setup/checks/harnesses.js";
import {
  SetupHarnessSelectionSourceSchema,
  SetupHarnessTrackingFactSchema,
  SetupPlanSchema,
  supportedHarnessIds,
} from "../../src/commands/setup/model.js";

describe("setup model", () => {
  it("keeps supported harness ids aligned with setup detection", () => {
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

  it("validates setup plan JSON shape", () => {
    const parsed = SetupPlanSchema.parse({
      generatedAt: "2026-06-08T12:00:00.000Z",
      mode: "check",
      checks: [
        {
          id: "worktrunk",
          tier: "required",
          status: "ok",
          label: "Worktrunk",
          message: "Worktrunk is available.",
        },
      ],
      actions: [
        {
          id: "tmux-popup-binding",
          kind: "append-file",
          tier: "recommended",
          selected: false,
          label: "Install tmux popup binding",
          message: "Append binding.",
          path: "/tmp/home/.tmux.conf",
          data: {
            marker: "# >>> station popup binding >>>",
            appendedText: "# >>> station popup binding >>>\n",
          },
        },
      ],
      summary: {
        launchReady: true,
        workflowReady: true,
        requiredOk: true,
        requiredMissing: 0,
        warnings: 0,
        selectedActions: 0,
        selectionSource: "configured",
        selectedHarness: "codex",
        configPath: "/tmp/config.toml",
      },
      nextSteps: ["stn doctor"],
    });

    expect(parsed.summary.requiredOk).toBe(true);
    expect(parsed.summary.launchReady).toBe(true);
    expect(parsed.summary.workflowReady).toBe(true);
  });

  it("rejects unexpected output fields", () => {
    expect(() =>
      SetupPlanSchema.parse({
        generatedAt: "2026-06-08T12:00:00.000Z",
        mode: "check",
        checks: [],
        actions: [],
        summary: {
          launchReady: true,
          workflowReady: true,
          requiredOk: true,
          requiredMissing: 0,
          warnings: 0,
          selectedActions: 0,
          selectionSource: "unresolved",
          configPath: "/tmp/config.toml",
        },
        nextSteps: [],
        extra: true,
      }),
    ).toThrow();
  });

  it("keeps requiredOk as a compatibility alias of workflowReady", () => {
    expect(() =>
      SetupPlanSchema.parse({
        generatedAt: "2026-06-08T12:00:00.000Z",
        mode: "check",
        checks: [],
        actions: [],
        summary: {
          launchReady: true,
          workflowReady: false,
          requiredOk: true,
          requiredMissing: 1,
          warnings: 0,
          selectedActions: 0,
          selectionSource: "unresolved",
          configPath: "/tmp/config.toml",
        },
        nextSteps: [],
      }),
    ).toThrow("requiredOk must match workflowReady");
  });
});
