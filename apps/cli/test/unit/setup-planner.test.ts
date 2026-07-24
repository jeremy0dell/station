import { describe, expect, it } from "vitest";
import { resolveSetupHarnessSelection } from "../../src/commands/setup/harnessSelection.js";
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
    });
    expect(plan.checks.map((check) => [check.id, check.status])).toEqual([
      ["state-dir", "ok"],
      ["observer-socket-evidence", "ok"],
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
      ["harness-tracking:codex", "ok"],
      ["diffnav", "ok"],
      ["git-delta", "ok"],
      ["doctor", "warning"],
    ]);
  });

  it.each([
    {
      name: "disabled config intent",
      configHooks: [] as string[],
      tracking: { requested: false },
      state: "disabled",
    },
    {
      name: "missing or drifted artifact",
      configHooks: ["codex"],
      tracking: { requested: true, installed: false },
      state: "artifact-missing-or-drifted",
    },
    {
      name: "status probe failure",
      configHooks: ["codex"],
      tracking: { probeFailed: true, detail: "Probe failed." },
      state: "probe-failed",
    },
  ])("requires tracking preparation for $name", ({ configHooks, tracking, state }) => {
    const plan = buildSetupPlan(
      facts({
        config: validConfigFact({ configuredHookHarnesses: configHooks }),
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            ...tracking,
          },
        ],
      }),
    );

    expect(plan.checks.find((check) => check.id === "harness-tracking:codex")).toMatchObject({
      tier: "required",
      status: "missing",
      details: { state },
    });
    expect(plan.actions.find((action) => action.id === "codex-hooks")).toMatchObject({
      tier: "required",
      selected: true,
    });
    expect(plan.summary.requiredOk).toBe(false);
  });

  it("keeps providers without managed artifacts non-blocking", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses(["pi"]),
        harnessTracking: [{ harnessId: "pi", capability: "unsupported" }],
        config: validConfigFact({
          configuredHarnesses: ["pi"],
          configuredHookHarnesses: [],
          defaults: {
            worktreeProvider: "worktrunk",
            terminal: "tmux",
            harness: "pi",
          },
        }),
      }),
    );

    expect(plan.checks.find((check) => check.id === "harness-tracking:pi")).toMatchObject({
      tier: "required",
      status: "ok",
      details: { state: "not-applicable" },
    });
    expect(plan.summary.requiredOk).toBe(true);
    expect(plan.actions.some((action) => action.id === "pi-hooks")).toBe(false);
  });

  it("warns without socket evidence without blocking fresh setup", () => {
    const plan = buildSetupPlan(
      facts({
        socketEvidence: { status: "missing", command: "/usr/bin/lsof" },
      }),
    );

    expect(plan.checks.find((check) => check.id === "observer-socket-evidence")).toMatchObject({
      tier: "recommended",
      status: "warning",
      message: expect.stringContaining("Fresh Observer startup can continue"),
    });
    expect(plan.summary).toMatchObject({ workflowReady: true, requiredOk: true });
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
      command: ["brew", "install", "diffnav"],
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

  it("requires explicit selection when several harnesses are available", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses(["cursor", "opencode", "pi"]),
        config: {
          status: "missing",
          path: "/tmp/config.toml",
          message: "Config missing.",
        },
      }),
    );

    expect(plan.summary).toMatchObject({ selectionSource: "unresolved", requiredOk: false });
    expect(plan.summary.selectedHarness).toBeUndefined();
  });

  it("respects an explicit selected harness when multiple are available", () => {
    const input = facts({
      harnesses: harnesses(["codex", "opencode"]),
      config: {
        status: "missing",
        path: "/tmp/config.toml",
        message: "Config missing.",
      },
    });
    const plan = buildSetupPlan(input, {
      harnessSelection: {
        defaultHarness: "opencode",
        selected: input.harnesses.filter((harness) => harness.id === "opencode"),
        requiredHarnessIds: ["opencode"],
        source: "explicit",
      },
    });

    expect(plan.summary.selectedHarness).toBe("opencode");
    expect(plan.checks.find((check) => check.id === "harness")?.details).toMatchObject({
      default: "opencode",
    });
  });

  it("does not let explicit selection replace an unsupported configured default", () => {
    const input = facts({
      harnesses: harnesses(["codex", "opencode"]),
      config: validConfigFact({
        defaults: {
          worktreeProvider: "worktrunk",
          terminal: "tmux",
          harness: "custom-provider",
        },
      }),
    });

    expect(resolveSetupHarnessSelection(input, ["codex"])).toEqual({
      selected: [],
      requiredHarnessIds: [],
      source: "unresolved",
    });
  });

  it("keeps the first selected harness as default while planning each supported hook", () => {
    const input = facts({
      harnesses: harnesses(["codex", "opencode", "pi"]),
      harnessTracking: [
        {
          harnessId: "codex",
          capability: "supported",
          requested: true,
          installed: false,
        },
      ],
    });
    const plan = buildSetupPlan(input, {
      harnessSelection: {
        defaultHarness: "codex",
        selected: input.harnesses.filter((harness) => harness.status === "ok"),
        requiredHarnessIds: ["codex", "opencode", "pi"],
        source: "explicit",
      },
    });

    expect(plan.summary.selectedHarness).toBe("codex");
    expect(plan.checks.find((check) => check.id === "harness")?.details).toMatchObject({
      default: "codex",
      enabled: "codex,opencode,pi",
    });
    expect(
      plan.actions
        .filter((action) => action.data?.setupRole === "hook" && action.data.harness !== undefined)
        .map((action) => [action.id, action.selected]),
    ).toEqual([
      ["codex-hooks", true],
      ["opencode-hooks", true],
    ]);
    expect(plan.actions.some((action) => action.id === "pi-hooks")).toBe(false);
  });

  it("derives every configured harness and hook after setup selection facts are gone", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses(["codex", "opencode", "pi"]),
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: true,
          },
          {
            harnessId: "opencode",
            capability: "supported",
            requested: true,
            installed: true,
          },
          { harnessId: "pi", capability: "unsupported" },
        ],
        config: validConfigFact({
          configuredHarnesses: ["codex", "opencode", "pi"],
          configuredHookHarnesses: ["codex", "opencode"],
        }),
      }),
    );

    expect(plan.checks.find((check) => check.id === "harness")?.details).toMatchObject({
      default: "codex",
      enabled: "codex",
    });
    expect(plan.checks.find((check) => check.id === "harness-tracking:opencode")).toMatchObject({
      tier: "recommended",
      status: "ok",
      details: { state: "prepared" },
    });
    expect(plan.checks.find((check) => check.id === "harness-tracking:pi")).toMatchObject({
      tier: "recommended",
      status: "skipped",
      details: { state: "not-applicable" },
    });
    expect(plan.actions.filter((action) => action.data?.harness !== undefined)).toEqual([]);
  });

  it("repairs persisted tracking intent for a configured secondary harness", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses(["codex", "opencode"]),
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: true,
          },
          {
            harnessId: "opencode",
            capability: "supported",
            requested: true,
            installed: false,
          },
        ],
        config: validConfigFact({
          configuredHarnesses: ["codex", "opencode"],
          configuredHookHarnesses: ["codex", "opencode"],
        }),
      }),
    );

    expect(plan.actions.find((action) => action.id === "opencode-hooks")).toMatchObject({
      tier: "recommended",
      selected: true,
      data: { setupRole: "hook", harness: "opencode" },
    });
  });

  it("does not repair tracking for a configured secondary harness without persisted intent", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses(["codex", "opencode"]),
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: true,
          },
          {
            harnessId: "opencode",
            capability: "supported",
            requested: false,
          },
        ],
        config: validConfigFact({
          configuredHarnesses: ["codex", "opencode"],
          configuredHookHarnesses: ["codex"],
        }),
      }),
    );

    expect(plan.actions.some((action) => action.id === "opencode-hooks")).toBe(false);
  });

  it("reports an unavailable persisted default without substituting an available provider", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses(["opencode"]),
        config: validConfigFact({
          configuredHarnesses: ["codex", "opencode"],
          configuredHookHarnesses: ["opencode"],
        }),
      }),
    );

    expect(plan.summary.selectedHarness).toBe("codex");
    expect(plan.checks.find((check) => check.id === "harness")).toMatchObject({
      status: "missing",
      message: expect.stringContaining("another agent CLI cannot satisfy that default"),
      details: {
        default: "codex",
        defaultStatus: "unavailable",
        enabled: "codex",
        available: "opencode",
      },
    });
    expect(plan.checks.find((check) => check.id === "config")).toMatchObject({
      status: "ok",
      details: {
        harness: "codex",
        configuredHarnesses: "codex,opencode",
      },
    });
  });

  it("does not report an unconfigured available CLI as enabled", () => {
    const plan = buildSetupPlan(
      facts({
        harnesses: harnesses(["opencode"]),
        config: validConfigFact({
          configuredHarnesses: ["codex"],
          configuredHookHarnesses: [],
        }),
      }),
    );

    expect(plan.summary.selectedHarness).toBe("codex");
    expect(plan.checks.find((check) => check.id === "harness")).toMatchObject({
      status: "missing",
      message: expect.stringContaining("another agent CLI cannot satisfy that default"),
      details: {
        default: "codex",
        defaultStatus: "unavailable",
        enabled: "codex",
        available: "opencode",
      },
    });
    expect(plan.checks.find((check) => check.id === "harness-tracking:codex")).toMatchObject({
      tier: "required",
      status: "missing",
    });
    expect(plan.summary.requiredOk).toBe(false);
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

  it("treats Git outside a repository as ready for first-project selection", () => {
    const config = validConfigFact({ hasProjectForRoot: false });
    delete config.matchedProject;

    const plan = buildSetupPlan(
      facts({
        git: {
          status: "missing",
          reason: "not-a-repo",
          defaultBranch: "main",
          message: "Choose a project after setup.",
        },
        config,
      }),
    );

    expect(plan.checks.find((check) => check.id === "git-project")).toMatchObject({
      status: "ok",
      label: "Git",
      message: expect.stringContaining("choose a project"),
    });
    expect(plan.checks.find((check) => check.id === "config")).toMatchObject({
      status: "ok",
    });
    expect(plan.summary.requiredOk).toBe(true);
    expect(plan.nextSteps).toEqual(["stn doctor", "stn"]);
  });

  it("plans the optional tmux popup binding with the preserved key and exact command", () => {
    const plan = buildSetupPlan(
      facts({
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: false,
          },
        ],
        tmuxBinding: {
          status: "missing",
          path: "/tmp/home/.tmux.conf",
          marker: "# >>> station popup binding >>>",
          launcherCommand: "/tmp/bin/stn-tmux-popup",
          runShellCommand: "managed-fast-command",
          bindingKey: "C-s",
          insideTmux: false,
          liveStatus: "unknown",
          message: "Optional tmux popup binding is not installed.",
        },
      }),
    );

    expect(plan.actions.find((action) => action.id === "tmux-popup-binding")).toMatchObject({
      kind: "append-file",
      tier: "recommended",
      selected: false,
      path: "/tmp/home/.tmux.conf",
      data: {
        marker: "# >>> station popup binding >>>",
        appendedText: expect.stringContaining(
          "# Change Space to any tmux key; stn setup preserves it.\nbind-key C-s run-shell -b 'managed-fast-command'",
        ),
      },
    });
    expect(plan.actions.find((action) => action.id === "worktrunk-hooks")?.command).toEqual([
      "/tmp/bin/stn",
      "--config",
      "/tmp/config.toml",
      "hooks",
      "install",
      "worktrunk",
      "--yes",
    ]);
    expect(plan.actions.find((action) => action.id === "codex-hooks")?.command).toEqual([
      "/tmp/bin/stn",
      "--config",
      "/tmp/config.toml",
      "hooks",
      "install",
      "codex",
      "--yes",
      "--hook-bin",
      "/tmp/bin/stn-ingress",
    ]);
  });

  it("omits hook installation when the active runtime ingress sibling is missing", () => {
    const base = facts();
    const plan = buildSetupPlan(
      facts({
        launchers: {
          ...base.launchers,
          ingress: {
            status: "missing",
            source: "missing",
            command: "/runtime/bin/stn-ingress",
            checkoutPath: "/tmp/station/bin/stn-ingress",
            message: "The active runtime ingress launcher is missing.",
          },
        },
      }),
    );

    expect(plan.checks.find((check) => check.id === "station-launchers")).toMatchObject({
      status: "warning",
    });
    expect(plan.actions.find((action) => action.id === "worktrunk-hooks")).toBeUndefined();
  });

  it("warns when setup can use installed launchers that are not on PATH", () => {
    const base = facts();
    const installedRoot = "/tmp/home/.local/bin";
    const plan = buildSetupPlan(
      facts({
        launchers: {
          ...base.launchers,
          station: {
            ...base.launchers.station,
            source: "installed",
            resolvedPath: `${installedRoot}/stn`,
          },
          ingress: {
            ...base.launchers.ingress,
            source: "installed",
            resolvedPath: `${installedRoot}/stn-ingress`,
          },
          tmuxPopup: {
            ...base.launchers.tmuxPopup,
            source: "installed",
            resolvedPath: `${installedRoot}/stn-tmux-popup`,
          },
        },
      }),
    );

    expect(plan.checks.find((check) => check.id === "station-launchers")).toMatchObject({
      status: "warning",
      message:
        "STATION is installed, but these bare launchers do not resolve to this installation on PATH: stn, stn-ingress, stn-tmux-popup.",
    });
  });

  it("plans the exact popup command and preserved key for a reachable tmux server", () => {
    const plan = buildSetupPlan(
      facts({
        tmuxBinding: {
          status: "ok",
          path: "/tmp/home/.tmux.conf",
          marker: "# >>> station popup binding >>>",
          launcherCommand: "/tmp/bin/stn-tmux-popup",
          runShellCommand: "managed-fast-command",
          bindingKey: "M-p",
          insideTmux: true,
          liveStatus: "missing",
        },
      }),
    );

    expect(plan.actions.find((action) => action.id === "tmux-live-popup-binding")).toMatchObject({
      command: ["tmux", "bind-key", "M-p", "run-shell", "-b", "managed-fast-command"],
    });
    expect(plan.actions.some((action) => action.id === "tmux-popup-binding")).toBe(false);
    expect(plan.checks.find((check) => check.id === "tmux-popup-binding")).toMatchObject({
      status: "warning",
      message: expect.stringContaining("persisted"),
    });
  });

  it("warns on an owned-block conflict without planning persisted or live actions", () => {
    const plan = buildSetupPlan(
      facts({
        tmux: { status: "missing", command: "tmux", message: "tmux missing." },
        tmuxBinding: {
          status: "conflict",
          path: "/tmp/home/.tmux.conf",
          marker: "# >>> station popup binding >>>",
          launcherCommand: "/tmp/bin/stn-tmux-popup",
          runShellCommand: "managed-fast-command",
          insideTmux: true,
          liveStatus: "unknown",
          message: "tmux popup binding markers are duplicated.",
        },
      }),
    );

    expect(plan.checks.find((check) => check.id === "tmux-popup-binding")).toMatchObject({
      status: "warning",
      message: "tmux popup binding markers are duplicated.",
    });
    expect(
      plan.actions.some(
        (action) => action.id === "tmux-popup-binding" || action.id === "tmux-live-popup-binding",
      ),
    ).toBe(false);
  });

  it("does not plan popup bindings until the launcher is usable", () => {
    const base = facts();
    const plan = buildSetupPlan(
      facts({
        launchers: {
          ...base.launchers,
          tmuxPopup: {
            status: "missing",
            source: "missing",
            command: "stn-tmux-popup",
            checkoutPath: "/tmp/station/integrations/terminal/tmux/bin/stn-popup",
            message: "missing",
          },
        },
        tmuxBinding: { ...base.tmuxBinding, insideTmux: true, liveStatus: "unknown" },
      }),
    );

    expect(
      plan.actions.some(
        (action) => action.id === "tmux-popup-binding" || action.id === "tmux-live-popup-binding",
      ),
    ).toBe(false);
  });

  it("plans Worktrunk shell integration with Worktrunk's approval prompt disabled", () => {
    const plan = buildSetupPlan(
      facts({
        worktrunk: {
          status: "ok",
          command: "wt",
          resolvedPath: "/opt/homebrew/bin/wt",
        },
      }),
    );

    expect(
      plan.actions.find((action) => action.id === "worktrunk-shell-integration"),
    ).toMatchObject({
      kind: "run-command",
      selected: false,
      command: ["/opt/homebrew/bin/wt", "-y", "config", "shell", "install"],
    });
  });

  it("does not offer a broad Worktrunk shell install when the active shell is unsupported", () => {
    const plan = buildSetupPlan(
      facts({
        worktrunkShellIntegration: {
          status: "warning",
          message: "Could not determine an active bash or zsh shell for Worktrunk integration.",
        },
      }),
    );

    expect(plan.checks.find((check) => check.id === "worktrunk-shell-integration")).toMatchObject({
      status: "warning",
    });
    expect(
      plan.actions.find((action) => action.id === "worktrunk-shell-integration"),
    ).toBeUndefined();
  });

  it("installs checkout launchers through the pnpm 11-compatible package script", () => {
    const base = facts();
    const plan = buildSetupPlan(
      facts({
        launchers: {
          ...base.launchers,
          station: {
            status: "ok",
            source: "checkout",
            command: base.launchers.station.checkoutPath,
            checkoutPath: base.launchers.station.checkoutPath,
          },
          ingress: {
            status: "ok",
            source: "checkout",
            command: base.launchers.ingress.checkoutPath,
            checkoutPath: base.launchers.ingress.checkoutPath,
          },
          tmuxPopup: {
            status: "ok",
            source: "checkout",
            command: base.launchers.tmuxPopup.checkoutPath,
            checkoutPath: base.launchers.tmuxPopup.checkoutPath,
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

  it("plans a safe update for an existing config", () => {
    const plan = buildSetupPlan(facts(), {
      configWrite: {
        operation: "update",
        path: "/tmp/config.toml",
        content: "schema_version = 1\n",
      },
    });

    expect(plan.actions.find((action) => action.id === "update-config")).toMatchObject({
      kind: "write-config",
      selected: true,
      data: {
        operation: "update",
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

  it("checks global setup defaults without adopting the current repository", () => {
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

    expect(plan.summary.requiredOk).toBe(true);
    expect(plan.checks.find((check) => check.id === "config")).toMatchObject({
      status: "ok",
      message: "Core STATION config is ready; projects are added explicitly in STATION.",
    });
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
    socketEvidence: { status: "ok", command: "/usr/bin/lsof" },
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
    worktrunkShellIntegration: {
      status: "warning",
      shell: "zsh",
      rcPath: "/tmp/home/.zshrc",
      message: "Worktrunk shell integration is not installed for zsh.",
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
    harnessTracking: [
      {
        harnessId: "codex",
        capability: "supported",
        requested: true,
        installed: true,
        detail: "Codex hooks are installed.",
      },
    ],
    config: {
      ...validConfigFact(),
    },
    tmuxBinding: {
      status: "missing",
      path: "/tmp/home/.tmux.conf",
      marker: "# >>> station popup binding >>>",
      launcherCommand: "/tmp/bin/stn-tmux-popup",
      runShellCommand:
        "env STATION_FOCUS_PROVIDER=tmux STATION_FOCUS_CLIENT_ID=#{q:client_name} '/tmp/bin/stn-tmux-popup'",
      bindingKey: "Space",
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
    configuredHookHarnesses: ["codex"],
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
