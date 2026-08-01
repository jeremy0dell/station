import { describe, expect, it } from "vitest";
import { normalizeSetupPlanningFacts } from "../../src/commands/setup/adapters/inspection.js";
import type { SetupFacts } from "../../src/commands/setup/adapters/inspectionTypes.js";
import type { SetupHarnessSelection } from "../../src/commands/setup/harnessSelection.js";

describe("setup inspection adapter", () => {
  it("normalizes machine facts without exposing config source or provider payloads to core", () => {
    const planning = normalizeSetupPlanningFacts(facts(), selection(), {
      operation: "update",
      path: "/tmp/config.toml",
      content: "private TOML",
    });

    expect(planning.config).toEqual({ state: "valid", write: "update", diagnostics: [] });
    expect(JSON.stringify(planning)).not.toContain("private TOML");
    expect(JSON.stringify(planning)).not.toContain("/tmp/config.toml");
    expect(planning.harnessTracking).toEqual([
      expect.objectContaining({
        harnessId: "codex",
        assessment: expect.objectContaining({ state: "prepared" }),
      }),
    ]);
  });
});

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
