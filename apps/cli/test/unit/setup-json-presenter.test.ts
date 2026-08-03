import { readFileSync } from "node:fs";
import type { SetupConfigMutationPlan as ConfigWritePlan } from "@station/config";
import {
  type HarnessSelectionFacts,
  type HarnessSelectionResolution,
  planSetup,
  resolveHarnessSelection,
  type SetupPlanningIntent,
  type SupportedHarnessId,
} from "@station/setup-core";
import { resolveSetupMessage } from "@station/setup-messages";
import { describe, expect, it } from "vitest";
import { normalizeSetupPlanningFacts } from "../../src/commands/setup/adapters/inspection.js";
import type {
  SetupFacts,
  SetupHarnessFact,
} from "../../src/commands/setup/adapters/inspectionTypes.js";
import { projectSetupView } from "../../src/commands/setup/presentation/projectSetupView.js";
import { createJsonSetupPresenter } from "../../src/commands/setup/presenters/json.js";

type BuildSetupPlanOptions = {
  readonly configWrite?: ConfigWritePlan;
  readonly harnessSelection?: HarnessSelectionResolution;
  readonly harnessTrackingSelection?: SetupPlanningIntent["harnessTrackingSelection"];
  readonly linkStationLaunchers?: boolean;
  readonly installWorktrunkHooks?: boolean;
  readonly installWorktrunkShell?: boolean;
  readonly configureTmuxPopup?: boolean;
};

function buildSetupPlan(
  ...arguments_: [SetupFacts, BuildSetupPlanOptions?]
): ReturnType<ReturnType<typeof createJsonSetupPresenter>["project"]> {
  return buildSetupPlans(...arguments_).jsonPlan;
}

function buildSetupPlans(...arguments_: [SetupFacts, BuildSetupPlanOptions?]) {
  const [setupFacts, options = {}] = arguments_;
  const selection =
    options.harnessSelection ??
    resolveHarnessSelection(coreSelectionFacts(setupFacts), { kind: "automatic" });
  const evidence = normalizeSetupPlanningFacts(setupFacts, selection, options.configWrite);
  const harnessSelection: SetupPlanningIntent["harnessSelection"] =
    selection.outcome === "selected" && selection.source === "explicit"
      ? { kind: "explicit", harnessIds: selection.requiredHarnessIds }
      : { kind: "automatic" };
  const semanticPlan = planSetup(evidence, {
    mode: setupFacts.mode,
    harnessSelection,
    installBootstrap: false,
    installHarnesses: [],
    linkStationLaunchers: options.linkStationLaunchers === true,
    harnessTrackingSelection: options.harnessTrackingSelection ?? { kind: "automatic" },
    installWorktrunkHooks: options.installWorktrunkHooks === true,
    installWorktrunkShell: options.installWorktrunkShell === true,
    configureTmuxPopup: options.configureTmuxPopup === true,
  });
  const projectionInput =
    options.configWrite === undefined
      ? { plan: semanticPlan, facts: setupFacts }
      : { plan: semanticPlan, facts: setupFacts, configMutation: options.configWrite };
  return {
    semanticPlan,
    presentationView: projectSetupView(projectionInput),
    jsonPlan: createJsonSetupPresenter().project(projectionInput),
  };
}

function resolveSetupHarnessSelection(
  ...arguments_: [setupFacts: SetupFacts, selectedIds?: readonly SupportedHarnessId[]]
): HarnessSelectionResolution {
  const [setupFacts, selectedIds] = arguments_;
  return resolveHarnessSelection(
    coreSelectionFacts(setupFacts),
    selectedIds === undefined
      ? { kind: "automatic" }
      : { kind: "explicit", harnessIds: selectedIds },
  );
}

function coreSelectionFacts(setupFacts: SetupFacts): HarnessSelectionFacts {
  const config: HarnessSelectionFacts["config"] =
    setupFacts.config.status === "valid"
      ? { status: "valid", defaultHarness: setupFacts.config.defaults.harness }
      : { status: setupFacts.config.status };
  return {
    config,
    harnesses: setupFacts.harnesses.map((harness) => ({
      id: harness.id,
      availability: harness.status === "ok" ? "available" : "unavailable",
    })),
  };
}

describe("setup plan projection", () => {
  it("keeps the machine projector independent from human message resolution", () => {
    const source = readFileSync(
      new URL("../../src/commands/setup/presenters/json.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("@station/setup-messages");
    expect(source).not.toContain("resolveSetupMessage");
    expect(source).not.toContain("ProjectSetupView");
  });

  it("keeps the session JSON presenter independent from retired and human projectors", () => {
    const source = readFileSync(
      new URL("../../src/commands/setup/presenters/json.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("CliSetupPlanSchema");
    expect(source).not.toContain("@station/setup-messages");
    expect(source).not.toContain("ProjectSetupView");
    expect(source).not.toContain("projectCliSetupPlan");
  });

  it("binds every projected production mutation to semantic execution authority", () => {
    const currentFacts = facts({
      config: {
        status: "missing",
        path: "/tmp/config.toml",
        message: "missing",
      },
    });
    const built = buildSetupPlans(currentFacts, {
      configWrite: {
        operation: "create",
        path: "/tmp/config.toml",
        content: "schema_version = 1\n",
      },
    });
    const mutatingActions = built.jsonPlan.actions.filter((action) => action.kind !== "noop");

    expect(mutatingActions.length).toBeGreaterThan(0);
    expect(built.jsonPlan.actions.some((action) => action.id === "activate-observer-config")).toBe(
      false,
    );
    expect(
      built.semanticPlan.operations.some(
        (operation) => operation.kind === "activate-observer-config",
      ),
    ).toBe(true);
    expect(built.presentationView.checks.find((check) => check.id === "harness")).toMatchObject({
      label: { id: "label.agent-cli" },
      explanation: { id: "check.harness-inferred" },
    });
    expect(
      built.presentationView.checks
        .flatMap((check) => check.details)
        .some((detail) => detail.label.id === "detail.default-agent"),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(built.jsonPlan))).toEqual(built.jsonPlan);
  });
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
    expect(
      plan.checks.find((check) => check.id === "harness-tracking:pi")?.details,
    ).not.toHaveProperty("requested");
    expect(plan.summary.requiredOk).toBe(true);
    expect(plan.actions.some((action) => action.id === "pi-hooks")).toBe(false);
  });

  it("reports hook ownership provenance in tracking details", () => {
    const requested = {
      schemaVersion: 1 as const,
      launcher: "/source/bin/stn-ingress",
      runtimeKind: "source" as const,
      version: "0.0.0-pre-alpha.4",
      buildIdentity: "a".repeat(64),
    };
    const current = {
      schemaVersion: 1 as const,
      launcher: "/installed/stn-ingress",
      runtimeKind: "compiled" as const,
      version: "0.7.1",
      buildIdentity: "b".repeat(64),
    };
    const plan = buildSetupPlan(
      facts({
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: false,
            ownership: {
              status: "different-owner",
              requested,
              currentLauncher: current.launcher,
              current,
            },
          },
        ],
      }),
    );

    expect(plan.checks.find((check) => check.id === "harness-tracking:codex")?.details).toEqual(
      expect.objectContaining({
        ownership: "different-owner",
        requestedLauncher: requested.launcher,
        requestedRuntimeKind: requested.runtimeKind,
        requestedRuntimeVersion: requested.version,
        requestedBuildIdentity: requested.buildIdentity,
        currentLauncher: current.launcher,
        currentRuntimeKind: current.runtimeKind,
        currentRuntimeVersion: current.version,
        currentBuildIdentity: current.buildIdentity,
      }),
    );
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

  it("preserves semantic operation selection in machine actions", () => {
    const baseFacts = facts();
    const optional = buildSetupPlan(
      facts({
        launchers: {
          ...baseFacts.launchers,
          station: { ...baseFacts.launchers.station, source: "checkout" },
        },
        tmuxBinding: { ...baseFacts.tmuxBinding, insideTmux: true },
      }),
      {
        linkStationLaunchers: true,
        installWorktrunkShell: true,
        configureTmuxPopup: true,
      },
    );
    expect(optional.actions.filter((action) => action.selected).map((action) => action.id)).toEqual(
      expect.arrayContaining([
        "link-station-launchers",
        "worktrunk-shell-integration",
        "tmux-popup-binding",
        "tmux-live-popup-binding",
      ]),
    );

    const gated = buildSetupPlans(
      facts({
        worktrunk: { status: "missing", command: "wt", message: "Worktrunk missing." },
        xcode: {
          status: "missing",
          applicable: true,
          message: "Command Line Tools missing.",
        },
      }),
    );
    expect([
      gated.semanticPlan.operations.find((operation) => operation.id === "install:worktrunk")
        ?.selected,
      gated.jsonPlan.actions.find((action) => action.id === "install-worktrunk")?.selected,
    ]).toEqual([false, false]);

    const declined = buildSetupPlans(
      facts({
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: false,
            detail: "Codex hooks are absent.",
          },
        ],
      }),
      { harnessTrackingSelection: { kind: "explicit", harnessIds: [] } },
    );
    expect([
      declined.semanticPlan.operations.find(
        (operation) => operation.id === "prepare-harness-tracking:codex",
      )?.selected,
      declined.jsonPlan.actions.find((action) => action.id === "codex-hooks")?.selected,
    ]).toEqual([false, false]);
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
    expect("selectedHarness" in plan.summary).toBe(false);
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
        outcome: "selected",
        defaultHarness: "opencode",
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
      outcome: "invalid",
      reason: "unsupported-configured-default",
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
        outcome: "selected",
        defaultHarness: "codex",
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
            requested: false,
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
            probeFailed: true,
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

  it("keeps working Git outside a repository green for first-project selection", () => {
    const config = validConfigFact({ hasProjectForRoot: false });
    delete config.matchedProject;

    const plan = buildSetupPlan(
      facts({
        git: {
          status: "ok",
          repository: "absent",
          defaultBranch: "main",
          message: "Git is available; choose a project explicitly in STATION.",
        },
        config,
      }),
    );

    expect(plan.checks.find((check) => check.id === "git-project")).toEqual({
      id: "git-project",
      tier: "required",
      status: "ok",
      label: "Git",
      message: "Git is available; choose a project explicitly in STATION.",
      details: { defaultBranch: "main" },
    });
    expect(plan.checks.find((check) => check.id === "config")).toMatchObject({
      status: "ok",
    });
    expect(plan.summary.requiredOk).toBe(true);
    expect(plan.nextSteps).toEqual(["stn doctor", "stn"]);
  });

  it.each([
    { name: "absent Git", reason: "git-absent" as const },
    { name: "unusable Git", reason: "git-unusable" as const },
    { name: "dubious ownership", reason: "dubious-ownership" as const },
    { name: "corrupt repository metadata", reason: "repository-unusable" as const },
  ])("keeps $name red and uses its remediation as the next step", ({ name, reason }) => {
    const message = `${name} remediation.`;
    const plan = buildSetupPlan(
      facts({
        git: {
          status: "missing",
          reason,
          defaultBranch: "main",
          message,
        },
      }),
    );

    expect(plan.checks.find((check) => check.id === "git-project")).toMatchObject({
      tier: "required",
      status: "missing",
      message,
      details: { defaultBranch: "main", reason },
    });
    expect(plan.summary).toMatchObject({
      workflowReady: false,
      requiredOk: false,
      requiredMissing: 1,
    });
    expect(plan.nextSteps).toEqual([message]);
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
    expect(plan.actions.find((action) => action.id === "link-station-launchers")).toBeUndefined();
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
      tier: "recommended",
      status: "warning",
      message:
        "STATION is installed, but these bare launchers do not resolve to this installation on PATH: stn, stn-ingress, stn-tmux-popup. Use the installer's PATH guidance to repair bare launcher resolution.",
      details: {
        station: `${installedRoot}/stn`,
        ingress: `${installedRoot}/stn-ingress`,
        tmuxPopup: `${installedRoot}/stn-tmux-popup`,
        pathDirectory: installedRoot,
      },
    });
    expect(plan.summary).toMatchObject({ workflowReady: true, requiredOk: true });
    expect(plan.actions.find((action) => action.id === "link-station-launchers")).toBeUndefined();
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
        before: "schema_version = 1\n",
        content: "schema_version = 1\n",
      },
    });

    const updateAction = plan.actions.find((action) => action.id === "update-config");
    expect(updateAction).toMatchObject({
      kind: "write-config",
      selected: true,
      data: {
        operation: "update",
      },
    });
    expect(updateAction?.data).not.toHaveProperty("backupPath");
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

  it("uses human agent wording without changing the frozen machine message", () => {
    const built = buildSetupPlans(
      facts({
        harnesses: harnesses([]),
        config: { status: "missing", path: "/tmp/config.toml", message: "Config missing." },
      }),
    );
    const machine = built.jsonPlan.checks.find((check) => check.id === "harness");
    const human = built.presentationView.checks.find((check) => check.id === "harness");

    expect(machine?.message).toContain("supported harness CLI");
    expect(
      resolveSetupMessage(human?.explanation ?? { id: "check.harness-none-available" }),
    ).toContain("supported agent CLI");
  });

  const base = facts();
  it.each([
    ["ready configured setup", facts()],
    [
      "missing required tools",
      facts({
        worktrunk: { status: "missing", command: "wt", message: "Worktrunk missing." },
        tmux: { status: "missing", command: "tmux", message: "tmux missing." },
      }),
    ],
    [
      "ambiguous agents",
      facts({
        harnesses: harnesses(["codex", "opencode"]),
        config: { status: "missing", path: "/tmp/config.toml", message: "Config missing." },
      }),
    ],
    [
      "unavailable configured default",
      facts({
        harnesses: harnesses(["opencode"]),
        config: validConfigFact({
          configuredHarnesses: ["codex", "opencode"],
          configuredHookHarnesses: ["opencode"],
        }),
      }),
    ],
    [
      "missing socket evidence",
      facts({ socketEvidence: { status: "missing", command: "/usr/bin/lsof" } }),
    ],
    [
      "launcher PATH mismatch",
      facts({
        launchers: {
          ...base.launchers,
          station: {
            ...base.launchers.station,
            source: "installed",
            resolvedPath: "/opt/station/stn",
          },
          ingress: {
            ...base.launchers.ingress,
            source: "installed",
            resolvedPath: "/opt/station/stn-ingress",
          },
          tmuxPopup: {
            ...base.launchers.tmuxPopup,
            source: "installed",
            resolvedPath: "/opt/station/stn-tmux-popup",
          },
        },
      }),
    ],
    [
      "harness tracking drift",
      facts({
        harnessTracking: [
          { harnessId: "codex", capability: "supported", requested: true, installed: false },
        ],
      }),
    ],
    [
      "invalid config",
      facts({
        config: {
          status: "invalid",
          path: "/tmp/config.toml",
          source: "schema_version = 1\n[defaults\n",
          message: "STATION config is not safe to update.",
        },
      }),
    ],
  ] as const)("preserves the exact main JSON fixture for %s", (_name, input) => {
    expect(JSON.stringify(buildSetupPlan(input))).toMatchSnapshot();
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
      repository: "present",
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
        "env STATION_FOCUS_PROVIDER=tmux STATION_FOCUS_CLIENT_ID=#{?#{@station_popup_ui_owner_client},#{q:@station_popup_ui_owner_client},#{q:client_name}} '/tmp/bin/stn-tmux-popup'",
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
