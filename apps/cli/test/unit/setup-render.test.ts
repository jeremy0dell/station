import { describe, expect, it } from "vitest";
import type { SetupAction, SetupPlan } from "../../src/commands/setup/model.js";
import {
  renderActionStart,
  renderSetupApplyResult,
  renderSetupPlan,
} from "../../src/commands/setup/render.js";

describe("setup renderer", () => {
  it("renders a spaced checklist without color by default", () => {
    const output = renderSetupPlan(plan());

    expect(output).toContain("Core\n\n");
    expect(output).toContain("  OK        Worktrunk / wt");
    expect(output).toContain("  MISSING   STATION config");
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

  it("renders prepared artifacts without claiming runtime readiness", () => {
    const output = renderSetupApplyResult({
      ...plan(),
      checks: [
        {
          id: "harness-tracking:codex",
          tier: "required",
          status: "ok",
          label: "Codex tracking",
          message: "Codex Station tracking artifacts are prepared on disk.",
          details: { harness: "codex", state: "prepared" },
        },
      ],
      actions: [],
      summary: {
        ...plan().summary,
        workflowReady: true,
        requiredOk: true,
        requiredMissing: 0,
        selectedActions: 0,
      },
    });

    expect(output).toContain("Station tracking artifacts are prepared for Codex");
    expect(output).toContain("Codex may require review");
    expect(output).toContain("/hooks");
    expect(output).toContain("did not bypass or verify that review");
    expect(output).not.toContain("Codex is Ready");
    expect(output).not.toContain("runtime Ready");
  });

  it("prioritizes unresolved harness selection in apply recovery output", () => {
    const output = renderSetupApplyResult(
      {
        ...plan(),
        checks: [
          {
            id: "worktrunk",
            tier: "required",
            status: "missing",
            label: "Worktrunk / wt",
            message: "Worktrunk is missing.",
          },
          {
            id: "harness",
            tier: "required",
            status: "missing",
            label: "Agent CLI",
            message: "Multiple supported agent CLIs are available; explicit selection is required.",
          },
        ],
        actions: [],
        summary: {
          ...plan().summary,
          selectionSource: "unresolved",
          requiredOk: false,
          requiredMissing: 2,
          selectedActions: 0,
        },
      },
      { selectionRequired: true },
    );

    expect(output).toContain("explicit selection is required");
    expect(output).toContain("Run guided setup and choose an agent CLI");
    expect(output).toContain("stn --config /tmp/station/config.toml setup");
    expect(output).not.toContain("Worktrunk is still missing");
  });

  it("preserves Git remediation in apply output", () => {
    const message =
      "Git is installed but unusable. Run xcode-select --install, then run stn setup check.";
    const output = renderSetupApplyResult({
      ...plan(),
      checks: [
        {
          id: "git-project",
          tier: "required",
          status: "missing",
          label: "Git",
          message,
        },
      ],
      actions: [],
      summary: {
        ...plan().summary,
        requiredMissing: 1,
        selectedActions: 0,
      },
    });

    expect(output).toContain(message);
    expect(output).not.toContain("Core setup is incomplete.");
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
        label: "STATION config",
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
      launchReady: true,
      workflowReady: false,
      requiredOk: false,
      requiredMissing: 1,
      warnings: 0,
      selectedActions: 2,
      selectionSource: "inferred",
      configPath: "/tmp/station/config.toml",
    },
    nextSteps: ["stn setup check"],
  };
}
