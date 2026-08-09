import {
  CliSetupActionSchema,
  CliSetupCheckSchema,
  CliSetupHarnessIdSchema,
  CliSetupPlanSchema,
  CliSetupSummarySchema,
  cliSetupHarnessIds,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const plan = {
  generatedAt: "2026-07-29T12:00:00.000Z",
  mode: "plan",
  checks: [
    {
      id: "harness-tracking:codex",
      tier: "required",
      status: "missing",
      label: "Codex tracking",
      message: "Codex tracking artifacts need repair.",
      details: {
        harness: "codex",
        selectionSource: "configured",
        capability: "supported",
        state: "artifact-missing-or-drifted",
        requested: "true",
        installed: "false",
      },
    },
  ],
  actions: [
    {
      id: "codex-hooks",
      kind: "run-command",
      tier: "required",
      selected: true,
      label: "Install Codex tracking",
      message: "Install Station-owned Codex tracking artifacts.",
      command: [
        "/sandbox/bin/stn",
        "--config",
        "/sandbox/config.toml",
        "hooks",
        "install",
        "codex",
        "--yes",
        "--hook-bin",
        "/sandbox/bin/stn-ingress",
      ],
      data: { setupRole: "hook", harness: "codex" },
    },
  ],
  summary: {
    launchReady: true,
    workflowReady: false,
    requiredOk: false,
    requiredMissing: 1,
    warnings: 0,
    selectedActions: 1,
    selectionSource: "configured",
    selectedHarness: "codex",
    configPath: "/sandbox/config.toml",
  },
  nextSteps: ["Resolve the missing required setup items, then run: stn setup check"],
} as const;

describe("CLI setup schemas", () => {
  it("accepts the existing strict setup payload", () => {
    expect(CliSetupPlanSchema.parse(plan)).toEqual(plan);
  });

  it("rejects unknown top-level and nested keys", () => {
    expect(CliSetupPlanSchema.safeParse({ ...plan, extra: true }).success).toBe(false);
    expect(
      CliSetupPlanSchema.safeParse({
        ...plan,
        checks: [{ ...plan.checks[0], extra: true }],
      }).success,
    ).toBe(false);
    expect(
      CliSetupPlanSchema.safeParse({
        ...plan,
        actions: [{ ...plan.actions[0], extra: true }],
      }).success,
    ).toBe(false);
    expect(
      CliSetupPlanSchema.safeParse({
        ...plan,
        summary: { ...plan.summary, extra: true },
      }).success,
    ).toBe(false);
  });

  it("accepts every wire enum and rejects values outside them", () => {
    for (const mode of ["check", "plan", "apply"]) {
      expect(CliSetupPlanSchema.safeParse({ ...plan, mode }).success).toBe(true);
    }
    for (const harnessId of ["codex", "cursor", "opencode", "pi", "claude"]) {
      expect(CliSetupHarnessIdSchema.parse(harnessId)).toBe(harnessId);
    }
    for (const tier of ["required", "recommended", "optional"]) {
      expect(CliSetupCheckSchema.safeParse({ ...plan.checks[0], tier }).success).toBe(true);
      expect(CliSetupActionSchema.safeParse({ ...plan.actions[0], tier }).success).toBe(true);
    }
    for (const status of ["ok", "missing", "warning", "skipped"]) {
      expect(CliSetupCheckSchema.safeParse({ ...plan.checks[0], status }).success).toBe(true);
    }
    for (const kind of [
      "brew-install",
      "run-command",
      "write-config",
      "append-file",
      "mkdir",
      "noop",
    ]) {
      expect(CliSetupActionSchema.safeParse({ ...plan.actions[0], kind }).success).toBe(true);
    }
    for (const status of ["pending", "completed", "failed", "skipped"]) {
      expect(CliSetupActionSchema.safeParse({ ...plan.actions[0], status }).success).toBe(true);
    }
    for (const selectionSource of ["configured", "explicit", "inferred", "unresolved"]) {
      expect(CliSetupSummarySchema.safeParse({ ...plan.summary, selectionSource }).success).toBe(
        true,
      );
    }

    expect(CliSetupPlanSchema.safeParse({ ...plan, mode: "repair" }).success).toBe(false);
    expect(CliSetupHarnessIdSchema.safeParse("crush").success).toBe(false);
    expect(CliSetupCheckSchema.safeParse({ ...plan.checks[0], tier: "blocking" }).success).toBe(
      false,
    );
    expect(
      CliSetupActionSchema.safeParse({ ...plan.actions[0], kind: "provider-command" }).success,
    ).toBe(false);
  });

  it("keeps requiredOk equal to workflowReady", () => {
    expect(CliSetupSummarySchema.safeParse({ ...plan.summary, requiredOk: true }).success).toBe(
      false,
    );
  });

  it("preserves absent optional fields", () => {
    const check = CliSetupCheckSchema.parse({
      id: "git-project",
      tier: "required",
      status: "ok",
      label: "Git",
      message: "Git is available.",
    });
    const action = CliSetupActionSchema.parse({
      id: "link-station-launchers",
      kind: "run-command",
      tier: "recommended",
      selected: false,
      label: "Link STATION launchers",
      message: "Link launchers.",
    });
    const summary = CliSetupSummarySchema.parse({
      launchReady: true,
      workflowReady: false,
      requiredOk: false,
      requiredMissing: 1,
      warnings: 0,
      selectedActions: 0,
      selectionSource: "unresolved",
      configPath: "/sandbox/config.toml",
    });

    expect("details" in check).toBe(false);
    expect("command" in action).toBe(false);
    expect("path" in action).toBe(false);
    expect("status" in action).toBe(false);
    expect("data" in action).toBe(false);
    expect("selectedHarness" in summary).toBe(false);
  });

  it("pins the canonical setup-managed harness vocabulary", () => {
    const expected = ["codex", "cursor", "opencode", "pi", "claude"];

    expect(cliSetupHarnessIds).toEqual(expected);
    expect(CliSetupHarnessIdSchema.options).toEqual(expected);
  });
});
