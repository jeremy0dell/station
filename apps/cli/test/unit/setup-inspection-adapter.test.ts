import { describe, expect, it } from "vitest";
import {
  createSetupInspectionAdapter,
  normalizeSetupPlanningFacts,
} from "../../src/commands/setup/adapters/inspection.js";
import type { SetupFacts } from "../../src/commands/setup/adapters/inspectionTypes.js";
import { createSetupOperationAdapter } from "../../src/commands/setup/adapters/operations.js";
import type { SetupHarnessSelection } from "../../src/commands/setup/harnessSelection.js";
import type { SetupCommandDeps } from "../../src/commands/setup/types.js";

describe("setup inspection adapter", () => {
  it("normalizes machine facts without exposing config source or provider payloads to core", () => {
    const planning = normalizeSetupPlanningFacts(facts(), selection(), {
      operation: "update",
      path: "/tmp/config.toml",
      content: "private TOML",
    });

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
    let currentDeps = operationDeps("/first/bin", calls);
    const execute = createSetupOperationAdapter({
      facts: facts(),
      deps: () => currentDeps,
    });

    await execute({
      id: "install:diffnav",
      kind: "install-tool",
      tier: "recommended",
      selected: true,
      tool: "diffnav",
    });
    currentDeps = operationDeps("/refreshed/bin", calls);
    await execute({
      id: "install:git-delta",
      kind: "install-tool",
      tier: "recommended",
      selected: true,
      tool: "git-delta",
    });

    expect(calls).toEqual([
      { command: "brew install diffnav", path: "/first/bin" },
      { command: "brew install git-delta", path: "/refreshed/bin" },
    ]);
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

function selection(): SetupHarnessSelection {
  return {
    selected: [{ id: "codex", label: "Codex", status: "ok", command: "codex" }],
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
    diffnav: { status: "ok", command: "diffnav" },
    gitDelta: { status: "ok", command: "delta" },
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
