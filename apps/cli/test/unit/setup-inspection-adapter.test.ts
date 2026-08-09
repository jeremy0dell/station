import type { HarnessSelectionResolution } from "@station/setup-core";
import { describe, expect, it } from "vitest";
import { planSetupConfigMutationForInspection } from "../../src/commands/setup/adapters/config.js";
import {
  createSetupInspectionAdapter,
  normalizeSetupPlanningFacts,
} from "../../src/commands/setup/adapters/inspection.js";
import {
  type SetupFacts,
  SetupHarnessTrackingFactSchema,
} from "../../src/commands/setup/adapters/inspectionTypes.js";
import { createSetupOperationAdapter } from "../../src/commands/setup/adapters/operations.js";
import type { SetupCommandDeps } from "../../src/commands/setup/types.js";

describe("setup inspection adapter", () => {
  it("normalizes machine facts without exposing config source or provider payloads to core", () => {
    const input = facts();
    const planning = normalizeSetupPlanningFacts(
      {
        ...input,
        worktrunk: { status: "missing", command: "wt", message: "missing Worktrunk" },
        tmux: { status: "ok", command: "tmux" },
        bun: { status: "missing", command: "bun", message: "missing Bun" },
        diffViewer: { status: "ok", command: "hunk" },
      },
      selection(),
      {
        operation: "update",
        path: "/tmp/config.toml",
        before: "private TOML",
        content: "private TOML",
      },
    );

    expect(planning.tools).toEqual([
      { id: "worktrunk", available: false, installerAvailable: true },
      { id: "tmux", available: true, installerAvailable: true },
      { id: "bun", available: false, installerAvailable: true },
      { id: "diff-viewer", available: true, installerAvailable: true },
    ]);
    expect(planning.config).toEqual({ state: "valid", write: "update", diagnostics: [] });
    expect(planning.homebrew).toBe("available");
    expect(planning.installableHarnessIds).toEqual(["codex"]);
    expect(JSON.stringify(planning)).not.toContain("private TOML");
    expect(JSON.stringify(planning)).not.toContain("/tmp/config.toml");
    expect(planning.harnessTracking).toEqual([
      expect.objectContaining({
        harnessId: "codex",
        assessment: expect.objectContaining({ state: "prepared" }),
      }),
    ]);
  });

  it("plans config previews with selected tracking and detected custom commands", async () => {
    const input = facts();
    const plan = await planSetupConfigMutationForInspection({
      facts: {
        ...input,
        worktrunk: {
          ...input.worktrunk,
          command: "/custom/bin/wt",
          resolvedPath: "/custom/bin/wt",
        },
        tmux: {
          ...input.tmux,
          command: "/custom/bin/tmux",
          resolvedPath: "/custom/bin/tmux",
        },
        config: {
          status: "missing",
          path: "/tmp/new-config.toml",
          message: "missing",
        },
      },
      selection: {
        outcome: "selected",
        source: "explicit",
        requiredHarnessIds: ["codex"],
        defaultHarness: "codex",
      },
      trackingIntent: { harnessIds: ["codex"], installWorktrunkHooks: true },
    });

    expect(plan.operation).toBe("create");
    if (plan.operation !== "create") throw new Error("expected create plan");
    expect(plan.content).toContain('command = "/custom/bin/wt"');
    expect(plan.content).toContain('[terminal.tmux]\ncommand = "/custom/bin/tmux"');
    expect(plan.content).toContain("install_hooks = true");
    expect(plan.content).toContain("use_lifecycle_hooks = true");
  });

  it("preserves config preview blocking for invalid config and unresolved selection", async () => {
    const input = facts();
    const invalid = await planSetupConfigMutationForInspection({
      facts: {
        ...input,
        config: {
          status: "invalid",
          path: "/tmp/config.toml",
          source: "private invalid TOML",
          message: "Config is invalid.",
        },
      },
      selection: { outcome: "invalid", reason: "invalid-config" },
      trackingIntent: { harnessIds: [], installWorktrunkHooks: false },
    });
    const unresolved = await planSetupConfigMutationForInspection({
      facts: input,
      selection: { outcome: "ambiguous", candidateHarnessIds: ["codex", "pi"] },
      trackingIntent: { harnessIds: [], installWorktrunkHooks: false },
    });

    expect(invalid).toEqual({
      operation: "blocked",
      path: "/tmp/config.toml",
      reason: "Config is invalid.",
    });
    expect(unresolved).toEqual({
      operation: "blocked",
      path: "/tmp/config.toml",
      reason: "Multiple supported harness CLIs are available; explicit selection is required.",
    });
  });

  it("strictly validates tracking facts at the inspection boundary", () => {
    expect(
      SetupHarnessTrackingFactSchema.parse({
        harnessId: "codex",
        capability: "supported",
        requested: true,
      }),
    ).toMatchObject({ harnessId: "codex", requested: true });
    expect(() =>
      SetupHarnessTrackingFactSchema.parse({
        harnessId: "codex",
        capability: "supported",
        providerPayload: "private",
      }),
    ).toThrow();
  });

  it("refreshes invocation dependencies after a completed package install", () => {
    const deps = { env: { PATH: "/fake/bin" } };
    const inspection = createSetupInspectionAdapter({
      mode: "check",
      options: {},
      deps,
      noBrew: false,
      planConfigWrite: false,
    });

    inspection.recordOperationOutcome({
      status: "completed",
      operationId: "install:worktrunk",
      commit: { kind: "package-installer", target: { kind: "tool", id: "worktrunk" } },
    });

    expect(deps.env.PATH).toBe("/fake/bin");
    expect(inspection.currentDeps().env?.PATH).toContain("/opt/homebrew/bin");
    expect(inspection.currentDeps().env?.PATH).toContain("/usr/local/bin");
  });

  it("resolves operation dependencies at execution time", async () => {
    const calls: Array<{ readonly command: string; readonly path: string | undefined }> = [];
    const currentDeps = operationDeps("/first/bin", calls);
    const execute = createSetupOperationAdapter({
      facts: facts(),
      deps: () => currentDeps,
    });

    await execute({
      id: "install:diff-viewer",
      kind: "install-tool",
      tier: "recommended",
      selected: true,
      tool: "diff-viewer",
    });

    expect(calls).toEqual([{ command: "brew install hunk", path: "/first/bin" }]);
  });
});

function operationDeps(
  path: string,
  calls: Array<{ readonly command: string; readonly path: string | undefined }>,
): SetupCommandDeps {
  return {
    env: { PATH: path },
    runner: async (input) => {
      calls.push({
        command: `${input.command} ${(input.args ?? []).join(" ")}`,
        path: input.env?.PATH,
      });
      return {
        command: input.command,
        args: input.args ?? [],
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    },
  };
}

function selection(): HarnessSelectionResolution {
  return {
    outcome: "selected",
    requiredHarnessIds: ["codex"],
    source: "configured",
    defaultHarness: "codex",
  };
}

function facts(): SetupFacts {
  return {
    generatedAt: "2026-08-01T00:00:00.000Z",
    mode: "plan",
    configPath: "/tmp/config.toml",
    homeDir: "/tmp/home",
    compiled: true,
    stateDir: { status: "ok", path: "/tmp/state" },
    socketEvidence: { status: "ok", command: "/usr/bin/lsof" },
    worktrunk: { status: "ok", command: "wt" },
    worktrunkAutomation: {
      status: "ok",
      automationMode: "worktrunk-default",
      message: "ready",
    },
    worktrunkShellIntegration: { status: "ok", message: "ready" },
    tmux: { status: "ok", command: "tmux" },
    bun: { status: "ok", command: "bun" },
    stationUi: { status: "skipped" },
    diffViewer: { status: "ok", command: "hunk" },
    brew: { status: "ok", command: "brew" },
    xcode: { status: "ok", applicable: false },
    launchers: {
      packageRoot: "/tmp/package",
      station: launcher("stn"),
      ingress: launcher("stn-ingress"),
      tmuxPopup: launcher("stn-tmux-popup"),
    },
    git: { status: "ok", repository: "absent", defaultBranch: "main", message: "outside" },
    harnesses: [{ id: "codex", label: "Codex", status: "ok", command: "codex" }],
    harnessTracking: [
      { harnessId: "codex", capability: "supported", requested: true, installed: true },
    ],
    config: {
      status: "valid",
      path: "/tmp/config.toml",
      source: "private TOML",
      observerStateDir: "/tmp/state",
      hasProjectForRoot: false,
      configuredHarnesses: ["codex"],
      configuredHookHarnesses: ["codex"],
      defaults: { worktreeProvider: "worktrunk", terminal: "tmux", harness: "codex" },
    },
    tmuxBinding: {
      status: "ok",
      path: "/tmp/home/.tmux.conf",
      marker: "marker",
      launcherCommand: "stn-tmux-popup",
      runShellCommand: "stn-tmux-popup",
      bindingKey: "Space",
      insideTmux: false,
      liveStatus: "missing",
    },
  };
}

function launcher(command: string) {
  return {
    status: "ok" as const,
    source: "path" as const,
    command,
    checkoutPath: `/tmp/${command}`,
  };
}
