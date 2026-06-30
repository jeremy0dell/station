import { describe, expect, it } from "vitest";
import { harnessDefinitions } from "../../src/commands/setup/checks/harnesses.js";
import { SetupPlanSchema, supportedHarnessIds } from "../../src/commands/setup/model.js";

describe("setup model", () => {
  it("keeps supported harness ids aligned with setup detection", () => {
    expect([...supportedHarnessIds]).toEqual(harnessDefinitions.map((harness) => harness.id));
    expect([...supportedHarnessIds]).not.toContain("crush");
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
        requiredOk: true,
        requiredMissing: 0,
        warnings: 0,
        selectedActions: 0,
        selectedHarness: "codex",
        configPath: "/tmp/config.toml",
      },
      nextSteps: ["stn doctor"],
    });

    expect(parsed.summary.requiredOk).toBe(true);
  });

  it("rejects unexpected output fields", () => {
    expect(() =>
      SetupPlanSchema.parse({
        generatedAt: "2026-06-08T12:00:00.000Z",
        mode: "check",
        checks: [],
        actions: [],
        summary: {
          requiredOk: true,
          requiredMissing: 0,
          warnings: 0,
          selectedActions: 0,
          configPath: "/tmp/config.toml",
        },
        nextSteps: [],
        extra: true,
      }),
    ).toThrow();
  });
});
