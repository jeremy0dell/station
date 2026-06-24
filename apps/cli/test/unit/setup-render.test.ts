import { describe, expect, it } from "vitest";
import type { SetupAction, SetupPlan } from "../../src/commands/setup/model.js";
import { renderActionStart, renderSetupPlan } from "../../src/commands/setup/render.js";

describe("setup renderer", () => {
  it("renders a spaced checklist without color by default", () => {
    const output = renderSetupPlan(plan());

    expect(output).toContain("Core\n\n");
    expect(output).toContain("  OK        Worktrunk / wt");
    expect(output).toContain("  MISSING   STATION project config");
    expect(output).toContain("           path /tmp/station/config.toml");
    expect(output).toContain("Actions\n\n");
    expect(output).toContain("  WILL      Write STATION config");
    expect(output).toContain("           command brew install tmux");
    expect(output).not.toContain("\u001B[");
  });

  it("adds ANSI styling only when requested", () => {
    const output = renderSetupPlan(plan(), { color: true });

    expect(output).toContain("\u001B[1m");
    expect(output).toContain("\u001B[32mOK\u001B[0m");
    expect(output).toContain("\u001B[31mMISSING\u001B[0m");
  });

  it("styles action progress while preserving readable plain text", () => {
    const action: SetupAction = {
      id: "write-config",
      kind: "write-config",
      tier: "required",
      selected: true,
      label: "Write STATION config",
      message: "Write config.",
      path: "/tmp/station/config.toml",
    };

    expect(renderActionStart(action)).toBe(
      "Applying: Write STATION config (/tmp/station/config.toml)",
    );
    expect(renderActionStart(action, { color: true })).toContain("\u001B[1mApplying:\u001B[0m");
  });

  it("renders the effective Worktrunk automation mode", () => {
    const skipHooks = renderSetupPlan({
      ...plan(),
      checks: [
        {
          id: "worktrunk-hooks",
          tier: "recommended",
          status: "ok",
          label: "Worktrunk hooks",
          message: "Lifecycle hooks are disabled; automated Worktrunk mutations pass --no-hooks.",
          details: { automationMode: "skip-hooks" },
        },
      ],
      actions: [],
    });
    const preapproveHooks = renderSetupPlan({
      ...plan(),
      checks: [
        {
          id: "worktrunk-hooks",
          tier: "recommended",
          status: "ok",
          label: "Worktrunk hooks",
          message:
            "Lifecycle hooks are enabled; automated Worktrunk mutations pass --yes to pre-approve prompts.",
          details: { automationMode: "preapprove-hooks" },
        },
      ],
      actions: [],
    });

    expect(skipHooks).toContain("automated Worktrunk mutations pass --no-hooks");
    expect(skipHooks).toContain("automationMode skip-hooks");
    expect(preapproveHooks).toContain("automated Worktrunk mutations pass --yes");
    expect(preapproveHooks).toContain("automationMode preapprove-hooks");
  });
});

function plan(): SetupPlan {
  return {
    generatedAt: "2026-06-08T12:00:00.000Z",
    mode: "plan",
    checks: [
      {
        id: "worktrunk",
        tier: "required",
        status: "ok",
        label: "Worktrunk / wt",
        message: "Worktrunk / wt is available.",
        details: { command: "wt", version: "1.2.3" },
      },
      {
        id: "config",
        tier: "required",
        status: "missing",
        label: "STATION project config",
        message: "Config is missing.",
        details: { path: "/tmp/station/config.toml" },
      },
    ],
    actions: [
      {
        id: "install-tmux",
        kind: "brew-install",
        tier: "required",
        selected: true,
        label: "Install tmux",
        message: "Install tmux with Homebrew.",
        command: ["brew", "install", "tmux"],
      },
      {
        id: "write-config",
        kind: "write-config",
        tier: "required",
        selected: true,
        label: "Write STATION config",
        message: "Create the core STATION config.",
        path: "/tmp/station/config.toml",
      },
    ],
    summary: {
      requiredOk: false,
      requiredMissing: 1,
      warnings: 0,
      selectedActions: 2,
      configPath: "/tmp/station/config.toml",
    },
    nextSteps: ["stn setup check"],
  };
}
