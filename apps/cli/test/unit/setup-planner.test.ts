import { describe, expect, it } from "vitest";
import type {
  ConfigWritePlan,
  SetupFacts,
  SetupHarnessFact,
  SupportedHarnessId,
} from "../../src/commands/setup/model.js";
import { buildSetupPlan } from "../../src/commands/setup/planner.js";

describe("setup planner", () => {
  it("reports all core checks ready and no selected actions", () => {
    const plan = buildSetupPlan(facts());

    expect(plan.summary).toMatchObject({
      launchReady: true,
      workflowReady: true,
      requiredOk: true,
      requiredMissing: 0,
      selectedActions: 0,
      selectedHarness: "codex",
    });
    expect(plan.checks.map((check) => [check.id, check.status])).toEqual([
      ["state-dir", "ok"],
      ["worktrunk", "ok"],
      ["tmux", "ok"],
      ["bun", "ok"],
      ["git-project", "ok"],
      ["harness", "ok"],
      ["config", "ok"],
      ["station-launchers", "ok"],
      ["station-ui", "ok"],
      ["worktrunk-shell-integration", "warning"],
      ["tmux-popup-binding", "warning"],
      ["worktrunk-hooks", "ok"],
      ["harness-hooks", "warning"],
      ["diffnav", "ok"],
      ["git-delta", "ok"],
      ["doctor", "warning"],
    ]);
  });

  it("plans Homebrew installs for missing required tools", () => {
    const plan = buildSetupPlan(
      facts({
        worktrunk: {
          status: "missing",
          command: "wt",
          message: "Worktrunk missing.",
        },
        tmux: {
          status: "missing",
          command: "tmux",
          message: "tmux missing.",
        },
      }),
    );

    expect(plan.summary.requiredMissing).toBe(2);
    expect(plan.actions.filter((action) => action.selected)).toMatchObject([
      {
        id: "install-worktrunk",
        kind: "brew-install",
        command: ["brew", "install", "worktrunk"],
      },
      {
        id: "install-tmux",
        kind: "brew-install",
        command: ["brew", "install", "tmux"],
      },
    ]);
  });

  it("plans a Homebrew install for missing Bun", () => {
    const plan = buildSetupPlan(
      facts({
        bun: { status: "missing", command: "bun", message: "Bun missing." },
      }),
    );

    expect(plan.summary.requiredMissing).toBe(1);
    expect(plan.actions.find((action) => action.id === "install-bun")).toMatchObject({
      kind: "brew-install",
      tier: "required",
      selected: true,
      command: ["brew", "install", "bun"],
    });
  });

  it("keeps compiled launch ready without source Bun or Station UI rows", () => {
    const plan = buildSetupPlan(
      facts({
        compiled: true,
        bun: { status: "missing", command: "bun", message: "Bun missing." },
        stationUi: { status: "missing" },
        xcode: {
          status: "missing",
          applicable: true,
          message: "Command Line Tools missing.",
        },
      }),
    );

    expect(plan.summary).toMatchObject({
      launchReady: true,
      workflowReady: true,
      requiredOk: true,
    });
    expect(plan.checks.some((check) => check.id === "bun")).toBe(false);
    expect(plan.checks.some((check) => check.id === "station-ui")).toBe(false);
    expect(plan.checks.some((check) => check.id === "command-line-tools")).toBe(false);
    expect(plan.actions.some((action) => action.id === "install-bun")).toBe(false);
  });

  it("separates launch readiness from workflow readiness", () => {
    const workflowIncomplete = buildSetupPlan(
      facts({ worktrunk: { status: "missing", command: "wt", message: "Missing." } }),
    );
    expect(workflowIncomplete.summary).toMatchObject({
      launchReady: true,
      workflowReady: false,
      requiredOk: false,
    });

    const launchBlocked = buildSetupPlan(
      facts({
        stateDir: {
          status: "missing",
          path: "/readonly/state",
          message: "State directory is not writable.",
        },
      }),
    );
    expect(launchBlocked.summary).toMatchObject({
      launchReady: false,
      workflowReady: false,
      requiredOk: false,
    });
  });

  it("plans required Homebrew installs for missing diffnav and git-delta", () => {
    const plan = buildSetupPlan(
      facts({
        diffnav: { status: "missing", command: "diffnav", message: "diffnav missing." },
        gitDelta: { status: "missing", command: "delta", message: "git-delta missing." },
      }),
    );

    expect(plan.summary.requiredMissing).toBe(2);
    // Both checks stay required+missing (guards a silent tier demotion to optional).
    expect(plan.checks.find((check) => check.id === "diffnav")).toMatchObject({
      tier: "required",
      status: "missing",
    });
    expect(plan.checks.find((check) => check.id === "git-delta")).toMatchObject({
      tier: "required",
      status: "missing",
    });
    expect(plan.actions.find((action) => action.id === "install-diffnav")).toMatchObject({
      kind: "brew-install",
      tier: "required",
      selected: true,
      command: ["brew", "install", "dlvhdr/formulae/diffnav"],
    });
    expect(plan.actions.find((action) => action.id === "install-git-delta")).toMatchObject({
      kind: "brew-install",
      tier: "required",
      selected: true,
      command: ["brew", "install", "git-delta"],
    });
  });

  it("blocks config writes when no harness is available", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses([]),
        config: {
          status: "missing",
          path: "/tmp/config.toml",
          message: "Config missing.",
        },
      }),
      {
        configWrite: createConfigWrite(),
      },
    );

    expect(plan.checks.find((check) => check.id === "harness")).toMatchObject({
      status: "missing",
    });
    expect(plan.actions.some((action) => action.kind === "write-config")).toBe(false);
  });

  it("selects the first available harness in stable detection order", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses(["cursor", "opencode", "pi"]),
      }),
    );

    expect(plan.summary.selectedHarness).toBe("cursor");
  });

  it("respects an explicit selected harness when multiple are available", () => {
    const plan = buildSetupPlan(
      facts({
        selectedHarness: "opencode",
        harnesses: harnesses(["codex", "opencode"]),
      }),
    );

    expect(plan.summary.selectedHarness).toBe("opencode");
    expect(plan.checks.find((check) => check.id === "harness")?.details).toMatchObject({
      selected: "opencode",
    });
  });

  it("plans config creation for a new config", () => {
    const plan = buildSetupPlan(
      facts({
        config: {
          status: "missing",
          path: "/tmp/config.toml",
          message: "Config missing.",
        },
      }),
      {
        configWrite: createConfigWrite(),
      },
    );

    expect(plan.actions.filter((action) => action.selected).map((action) => action.id)).toEqual([
      "mkdir-config-dir",
      "write-config",
    ]);
  });

  it("plans the optional tmux popup binding when it is missing", () => {
    const plan = buildSetupPlan(facts());

    expect(plan.actions.find((action) => action.id === "tmux-popup-binding")).toMatchObject({
      kind: "append-file",
      tier: "recommended",
      selected: false,
      path: "/tmp/home/.tmux.conf",
      data: {
        marker: "# >>> station popup binding >>>",
      },
    });
  });

  it("plans Worktrunk shell integration with Worktrunk's approval prompt disabled", () => {
    const plan = buildSetupPlan(facts());

    expect(
      plan.actions.find((action) => action.id === "worktrunk-shell-integration"),
    ).toMatchObject({
      kind: "run-command",
      selected: false,
      command: ["wt", "-y", "config", "shell", "install"],
    });
  });

  it("installs checkout launchers through the pnpm 11-compatible package script", () => {
    const base = facts();
    const plan = buildSetupPlan(
      facts({
        launchers: {
          ...base.launchers,
          station: {
            ...base.launchers.station,
            source: "checkout",
            command: base.launchers.station.checkoutPath,
          },
          ingress: {
            ...base.launchers.ingress,
            source: "checkout",
            command: base.launchers.ingress.checkoutPath,
          },
          tmuxPopup: {
            ...base.launchers.tmuxPopup,
            source: "checkout",
            command: base.launchers.tmuxPopup.checkoutPath,
          },
        },
      }),
    );

    expect(plan.checks.find((check) => check.id === "station-launchers")).toMatchObject({
      status: "warning",
      details: {
        station: "/tmp/station/bin/stn",
        ingress: "/tmp/station/bin/stn-ingress",
        tmuxPopup: "/tmp/station/integrations/terminal/tmux/bin/stn-popup",
      },
    });
    expect(plan.actions.find((action) => action.id === "link-station-launchers")).toMatchObject({
      kind: "run-command",
      selected: false,
      command: ["pnpm", "--dir", "/tmp/station", "station:link"],
    });
  });

  it("plans a safe append for an existing config", () => {
    const plan = buildSetupPlan(facts(), {
      configWrite: {
        operation: "append",
        path: "/tmp/config.toml",
        content: "schema_version = 1\n",
        appendedText: "\n[[projects]]\n",
      },
    });

    expect(plan.actions.find((action) => action.id === "append-config")).toMatchObject({
      kind: "write-config",
      selected: true,
      data: {
        operation: "append",
        appendedText: "\n[[projects]]\n",
      },
    });
  });

  it("uses a noop action for invalid existing config", () => {
    const plan = buildSetupPlan(facts(), {
      configWrite: {
        operation: "blocked",
        path: "/tmp/config.toml",
        reason: "Config is invalid.",
      },
    });

    expect(plan.actions.find((action) => action.id === "config-blocked")).toMatchObject({
      kind: "noop",
      selected: false,
    });
  });

  it("does not report ready when a required check is a warning", () => {
    const plan = buildSetupPlan({
      ...facts(),
      config: {
        status: "invalid",
        path: "/tmp/config.toml",
        source: "schema_version = 1\n[defaults\n",
        message: "STATION config is not safe to update.",
      },
    });

    expect(plan.summary.requiredOk).toBe(false);
    expect(plan.checks.find((check) => check.id === "config")).toMatchObject({
      tier: "required",
      status: "missing",
    });
  });

  it("keeps valid config diagnostics visible without failing required readiness", () => {
    const plan = buildSetupPlan(
      facts({
        config: validConfigFact({
          diagnostics: [
            {
              code: "CONFIG_WORKSPACE_SECTION_INVALID",
              severity: "warn",
              message: "Ignoring invalid [workspace] section.",
            },
          ],
        }),
      }),
    );

    const warningIds = plan.checks
      .filter((check) => check.status === "warning")
      .map((check) => check.id);

    expect(plan.checks.find((check) => check.id === "config")).toMatchObject({
      tier: "required",
      status: "ok",
    });
    expect(plan.checks.find((check) => check.id === "config-diagnostics")).toMatchObject({
      tier: "recommended",
      status: "warning",
      message: expect.stringContaining("Ignoring invalid [workspace] section."),
      details: { path: "/tmp/config.toml", project: "repo" },
    });
    expect(plan.summary.requiredOk).toBe(true);
    expect(plan.summary.requiredMissing).toBe(0);
    expect(plan.summary.warnings).toBe(warningIds.length);
    expect(warningIds).toContain("config-diagnostics");
    expect(plan.nextSteps).toEqual(["stn doctor", "stn"]);
  });

  it("fails readiness for existing projects outside the core setup path", () => {
    const plan = buildSetupPlan(
      facts({
        config: validConfigFact({
          matchedProject: {
            id: "repo",
            worktreeProvider: "worktrunk",
            worktrunkEnabled: true,
            terminal: "noop-terminal",
            harness: "codex",
          },
        }),
      }),
    );

    expect(plan.summary.requiredOk).toBe(false);
    expect(plan.checks.find((check) => check.id === "config")?.message).toContain(
      "uses terminal noop-terminal",
    );
  });
});

function facts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    generatedAt: "2026-06-08T12:00:00.000Z",
    mode: "plan",
    configPath: "/tmp/config.toml",
    homeDir: "/tmp/home",
    compiled: false,
    stateDir: { status: "ok", path: "/tmp/home/.local/state/station" },
    worktrunk: {
      status: "ok",
      command: "wt",
      version: "1.0.0",
    },
    worktrunkAutomation: {
      status: "ok",
      automationMode: "preapprove-hooks",
      flag: "--yes",
      message:
        "Lifecycle hooks are enabled; automated Worktrunk mutations pass --yes to pre-approve prompts.",
    },
    tmux: {
      status: "ok",
      command: "tmux",
      version: "3.5a",
    },
    bun: {
      status: "ok",
      command: "bun",
      resolvedPath: "/tmp/bin/bun",
    },
    stationUi: { status: "installed" },
    diffnav: {
      status: "ok",
      command: "diffnav",
      resolvedPath: "/tmp/bin/diffnav",
    },
    gitDelta: {
      status: "ok",
      command: "delta",
      resolvedPath: "/tmp/bin/delta",
    },
    brew: {
      status: "ok",
      command: "brew",
      version: "4.0.0",
    },
    xcode: {
      status: "ok",
      applicable: true,
      path: "/Library/Developer/CommandLineTools",
    },
    launchers: {
      packageRoot: "/tmp/station",
      station: {
        status: "ok",
        source: "path",
        command: "stn",
        resolvedPath: "/tmp/bin/stn",
        checkoutPath: "/tmp/station/bin/stn",
      },
      ingress: {
        status: "ok",
        source: "path",
        command: "stn-ingress",
        resolvedPath: "/tmp/bin/stn-ingress",
        checkoutPath: "/tmp/station/bin/stn-ingress",
      },
      tmuxPopup: {
        status: "ok",
        source: "path",
        command: "stn-tmux-popup",
        resolvedPath: "/tmp/bin/stn-tmux-popup",
        checkoutPath: "/tmp/station/integrations/terminal/tmux/bin/stn-popup",
      },
    },
    git: {
      status: "ok",
      root: "/tmp/repo",
      defaultBranch: "main",
      repoName: "repo",
    },
    harnesses: harnesses(["codex"]),
    config: {
      ...validConfigFact(),
    },
    tmuxBinding: {
      status: "missing",
      path: "/tmp/home/.tmux.conf",
      marker: "# >>> station popup binding >>>",
      launcherCommand: "stn-tmux-popup",
      runShellCommand:
        "env STATION_FOCUS_PROVIDER=tmux STATION_FOCUS_CLIENT_ID=#{q:client_name} 'stn-tmux-popup'",
      insideTmux: false,
      liveStatus: "unknown",
      message: "Optional tmux popup binding is not installed.",
    },
    ...overrides,
  };
}

function validConfigFact(
  overrides: Partial<Extract<SetupFacts["config"], { status: "valid" }>> = {},
): Extract<SetupFacts["config"], { status: "valid" }> {
  return {
    status: "valid",
    path: "/tmp/config.toml",
    source: "schema_version = 1\n",
    observerStateDir: "/tmp/home/.local/state/station",
    hasProjectForRoot: true,
    configuredHarnesses: ["codex"],
    configuredHookHarnesses: [],
    defaults: {
      worktreeProvider: "worktrunk",
      terminal: "tmux",
      harness: "codex",
    },
    worktrunkUseLifecycleHooks: true,
    matchedProject: {
      id: "repo",
      worktreeProvider: "worktrunk",
      worktrunkEnabled: true,
      terminal: "tmux",
      harness: "codex",
    },
    ...overrides,
  };
}

function harnesses(available: readonly SupportedHarnessId[]): SetupHarnessFact[] {
  return (["codex", "cursor", "opencode", "pi"] as const).map((id) => ({
    id,
    label: id,
    status: available.includes(id) ? "ok" : "missing",
    command: id === "cursor" ? "agent" : id,
  }));
}

function createConfigWrite(): ConfigWritePlan {
  return {
    operation: "create",
    path: "/tmp/config.toml",
    content: "schema_version = 1\n",
  };
}
