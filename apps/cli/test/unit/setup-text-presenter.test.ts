import { readFileSync } from "node:fs";
import type { SetupConfigMutationPlan } from "@station/config";
import type { CliSetupHarnessId } from "@station/contracts";
import {
  type HarnessSelectionFacts,
  planSetup,
  resolveHarnessSelection,
  type SetupPlanningIntent,
  type SetupSessionOperationOutcome,
} from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import { describe, expect, it } from "vitest";
import { normalizeSetupPlanningFacts } from "../../src/commands/setup/adapters/inspection.js";
import type {
  SetupFacts,
  SetupHarnessFact,
} from "../../src/commands/setup/adapters/inspectionTypes.js";
import { createJsonSetupPresenter } from "../../src/commands/setup/presenters/json.js";
import {
  createTextSetupPresenter,
  type TextSetupProjection,
} from "../../src/commands/setup/presenters/text.js";

describe("text setup presenter", () => {
  it("does not derive semantics by slicing check or action IDs", () => {
    const source = readFileSync(
      new URL("../../src/commands/setup/presenters/text.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("ProjectSetupView");
    expect(source).not.toContain("projectSetupActions");
    expect(source).not.toContain("setupViewTypes");
    expect(source).toContain("TextSetupProjection");
  });

  it("renders the semantic plan without machine-only keys or command payloads", () => {
    const projection = buildProjection(
      {
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: false,
            detail: "Codex hooks are missing.",
          },
        ],
      },
      { harnessTrackingSelection: { kind: "explicit", harnessIds: ["codex"] } },
    );
    const output = createTextSetupPresenter().renderPlan(projection);

    expect(output).toContain("Worktrunk automation: preapprove-hooks");
    expect(output).toContain("Install Codex tracking");
    expect(output).not.toContain("automationMode");
    expect(output).not.toContain("selectionSource");
    expect(output).not.toContain("command [");
    expect(output).not.toContain("hooks install codex");
    expect(output).not.toContain("setupRole");
  });

  it("renders a compact successful transcript with prepared agents and runnable next commands", () => {
    const projection = buildProjection({
      harnesses: harnesses(["codex", "opencode"]),
      harnessTracking: [preparedTracking("codex"), preparedTracking("opencode")],
      config: validConfigFact({
        configuredHarnesses: ["codex", "opencode"],
        configuredHookHarnesses: ["codex", "opencode"],
      }),
    });
    const output = createTextSetupPresenter().renderApplyResult(projection);

    expect(output).toContain("Core setup complete. Tracking is prepared for Codex and OpenCode.");
    expect(output).toContain("Codex may require review");
    expect(output).toContain("/hooks");
    expect(output).toContain("  stn doctor\n  stn\n");
    expect(output).not.toContain("Remaining");
    expect(output).not.toContain("Completed Install");
  });

  it("keeps partial-failure evidence and projected tracking recovery", () => {
    const presenter = createTextSetupPresenter();
    const failure = presenter.renderProgressFailure(
      { label: "Install Codex tracking" },
      {
        tag: "ProviderTrackingError",
        code: "HOOK_OWNER_CONFLICT",
        message: "Another Station runtime owns the Codex hook.",
        hint: "stn hooks install codex --yes --takeover",
      },
    );
    const laterSuccess = presenter.renderProgressComplete({ label: "Install OpenCode tracking" });
    const final = presenter.renderApplyResult(
      buildProjection({
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: false,
            detail: "Codex hooks are missing.",
          },
        ],
      }),
    );
    const transcript = `${failure}\n${laterSuccess}\n${final}`;

    expect(transcript).toContain("Another Station runtime owns the Codex hook.");
    expect(transcript).toContain("HOOK_OWNER_CONFLICT");
    expect(transcript).toContain("stn hooks install codex --yes --takeover");
    expect(transcript).toContain("Completed: Install OpenCode tracking");
    expect(transcript).toContain(
      "/tmp/bin/stn --config /tmp/config.toml hooks install codex --yes",
    );
    expect(transcript).not.toMatch(/^\s*[[{]/m);
    expect(transcript).not.toMatch(/"(?:provider|commands|before|after|rawResult|data)"\s*:/);
  });

  it("preserves safely quoted launcher and PATH recovery", () => {
    const bin = "/tmp/station/bin";
    const projection = buildProjection({
      launchers: {
        packageRoot: "/tmp/station",
        station: installedLauncher(`${bin}/stn`),
        ingress: installedLauncher(`${bin}/stn-ingress`),
        tmuxPopup: installedLauncher(`${bin}/stn-tmux-popup`),
      },
    });
    const output = createTextSetupPresenter().renderApplyResult(projection);

    expect(output).toContain(`PATH='/tmp/station/bin'\${PATH:+":$PATH"}`);
    expect(output).toContain("'/tmp/station/bin/stn' doctor");
    expect(output).toContain("Future login shell launcher resolution remains unverified");
    expect(output).not.toContain("\n  stn doctor\n");
  });

  it("styles statuses while preserving visual alignment and disables ANSI on request", () => {
    const projection = buildProjection();
    const checks = [
      {
        id: "git-project",
        tier: "recommended" as const,
        status: "ok" as const,
        label: "Git",
        message: "Git is available.",
      },
      {
        id: "station-launchers",
        tier: "recommended" as const,
        status: "warn" as const,
        label: "STATION launchers",
        message: "These Station launchers are missing: stn.",
      },
    ];
    const focused = { ...projection, plan: { ...projection.plan, checks } };
    const colored = createTextSetupPresenter({ color: true }).renderPlan(focused);
    const plain = createTextSetupPresenter({ color: false }).renderPlan(focused);

    expect(colored).toContain("\u001b[32mOK\u001b[0m");
    expect(colored).toContain("\u001b[33mWARN\u001b[0m");
    const visible = colored
      .replaceAll("\u001b[32m", "")
      .replaceAll("\u001b[33m", "")
      .replaceAll("\u001b[0m", "");
    const rows = visible
      .split("\n")
      .filter(
        (line) => line.includes("Git is available") || line.includes("These Station launchers"),
      );
    expect(rows[0]?.indexOf("Git is available")).toBe(rows[1]?.indexOf("These Station launchers"));
    expect(plain).not.toContain("\u001b[");
  });

  it("dims prompt details and renders compact OSC 8 links", () => {
    const presenter = createTextSetupPresenter({ color: true, hyperlinks: true });
    const prompt = presenter.prompt(setupMessageRef("guided.launcher-link-prompt"));
    const link = presenter.link({
      label: "Official Homebrew formula ↗",
      url: "https://formulae.brew.sh/formula/tmux",
    });

    expect(prompt.startsWith("Link STATION launchers globally?\n\u001b[2mMakes stn")).toBe(true);
    expect(prompt).toContain("\u001b[2mRuns this checkout’s station:link package script.");
    expect(link).toContain(
      "\u001b]8;;https://formulae.brew.sh/formula/tmux\u001b\\Official Homebrew formula ↗\u001b]8;;\u001b\\",
    );
    expect(link).toContain("\u001b[4m");

    const plainLink = createTextSetupPresenter({ color: false, hyperlinks: false }).link({
      label: "Official Homebrew formula ↗",
      url: "https://formulae.brew.sh/formula/tmux",
    });
    expect(plainLink).toBe("Official Homebrew formula ↗ (https://formulae.brew.sh/formula/tmux)");
  });

  it("renders Git-specific and generic blocked results without inspecting check IDs", () => {
    const presenter = createTextSetupPresenter();
    const git = presenter.renderApplyResult(
      buildProjection({
        git: {
          status: "missing",
          reason: "dubious-ownership",
          defaultBranch: "main",
          message: "Repair Git ownership.",
        },
      }),
    );
    const generic = presenter.renderApplyResult(
      buildProjection({
        worktrunk: { status: "missing", command: "wt", message: "Worktrunk missing." },
      }),
    );

    expect(git).toBe("Repair Git ownership.\n");
    expect(generic).toContain("Worktrunk is still missing.");
    expect(generic).toContain("stn setup check");
  });

  it("renders dry-run SKIP statuses and config-write failure results", () => {
    const presenter = createTextSetupPresenter();
    const dryRunProjection = buildProjection(
      {
        harnessTracking: [
          {
            harnessId: "codex",
            capability: "supported",
            requested: true,
            installed: false,
            detail: "Codex hooks are missing.",
          },
        ],
      },
      { harnessTrackingSelection: { kind: "explicit", harnessIds: ["codex"] } },
    );
    const dryRun = presenter.renderPlan(dryRunProjection, { skipSelectedActions: true });
    const configWrite: SetupConfigMutationPlan = {
      operation: "create",
      path: "/tmp/config.toml",
      content: "schema_version = 1\n",
    };
    const failedProjection = buildProjection(
      {
        config: { status: "missing", path: "/tmp/config.toml", message: "Config missing." },
      },
      {},
      configWrite,
    );
    const operation = failedProjection.semanticPlan.operations.find(
      (candidate) => candidate.kind === "write-config",
    );
    if (operation === undefined) throw new Error("Expected a config write operation.");
    const operationOutcomes: readonly SetupSessionOperationOutcome[] = [
      {
        status: "failed",
        operationId: operation.id,
        operation,
        error: {
          tag: "SetupConfigWriteError",
          code: "CONFIG_WRITE_FAILED",
          message: "Config write failed.",
        },
      },
    ];
    const failed = presenter.renderApplyResult({ ...failedProjection, operationOutcomes });

    expect(dryRun).toContain("SKIP      Install Codex tracking");
    expect(failed).toContain("Config write failed. Run: stn setup plan");
  });
});

function buildProjection(
  overrides: Partial<SetupFacts> = {},
  intentOverrides: Partial<SetupPlanningIntent> = {},
  configMutation?: SetupConfigMutationPlan,
): TextSetupProjection {
  const facts = setupFacts(overrides);
  const selection = resolveHarnessSelection(selectionFacts(facts), { kind: "automatic" });
  const semanticPlan = planSetup(normalizeSetupPlanningFacts(facts, selection, configMutation), {
    mode: facts.mode,
    harnessSelection: { kind: "automatic" },
    installBootstrap: false,
    installHarnesses: [],
    linkStationLaunchers: false,
    harnessTrackingSelection: { kind: "automatic" },
    installWorktrunkHooks: false,
    installWorktrunkShell: false,
    configureTmuxPopup: false,
    ...intentOverrides,
  });
  const projectionInput =
    configMutation === undefined
      ? { plan: semanticPlan, facts }
      : { plan: semanticPlan, facts, configMutation };
  return {
    plan: createJsonSetupPresenter().project(projectionInput),
    semanticPlan,
    facts,
    operationOutcomes: [],
  };
}

function selectionFacts(facts: SetupFacts): HarnessSelectionFacts {
  return {
    config:
      facts.config.status === "valid"
        ? { status: "valid", defaultHarness: "codex" }
        : { status: facts.config.status },
    harnesses: facts.harnesses.map((harness) => ({
      id: harness.id,
      availability: harness.status === "ok" ? "available" : "unavailable",
    })),
  };
}

function setupFacts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    generatedAt: "2026-07-31T12:00:00.000Z",
    mode: "apply",
    configPath: "/tmp/config.toml",
    homeDir: "/tmp/home",
    compiled: false,
    stateDir: { status: "ok", path: "/tmp/home/.local/state/station" },
    socketEvidence: { status: "ok", command: "/usr/bin/lsof" },
    worktrunk: { status: "ok", command: "wt", version: "1.0.0" },
    worktrunkAutomation: {
      status: "ok",
      automationMode: "preapprove-hooks",
      flag: "--yes",
      message: "Lifecycle hooks are enabled.",
    },
    worktrunkShellIntegration: {
      status: "warn",
      shell: "zsh",
      rcPath: "/tmp/home/.zshrc",
      message: "Worktrunk shell integration is not installed for zsh.",
    },
    tmux: { status: "ok", command: "tmux", version: "3.5a" },
    bun: { status: "ok", command: "bun", resolvedPath: "/tmp/bin/bun" },
    stationUi: { status: "installed" },
    diffViewer: { status: "ok", command: "hunk", resolvedPath: "/tmp/bin/hunk" },
    brew: { status: "ok", command: "brew", version: "4.0.0" },
    xcode: { status: "ok", applicable: true, path: "/Library/Developer/CommandLineTools" },
    launchers: {
      packageRoot: "/tmp/station",
      station: pathLauncher("stn", "/tmp/bin/stn", "/tmp/station/bin/stn"),
      ingress: pathLauncher("stn-ingress", "/tmp/bin/stn-ingress", "/tmp/station/bin/stn-ingress"),
      tmuxPopup: pathLauncher(
        "stn-tmux-popup",
        "/tmp/bin/stn-tmux-popup",
        "/tmp/station/integrations/terminal/tmux/bin/stn-popup",
      ),
    },
    git: {
      status: "ok",
      repository: "present",
      root: "/tmp/repo",
      defaultBranch: "main",
      repoName: "repo",
    },
    harnesses: harnesses(["codex"]),
    harnessTracking: [preparedTracking("codex")],
    config: validConfigFact(),
    tmuxBinding: {
      status: "missing",
      path: "/tmp/home/.tmux.conf",
      marker: "# >>> station popup binding >>>",
      launcherCommand: "/tmp/bin/stn-tmux-popup",
      runShellCommand: "'/tmp/bin/stn-tmux-popup'",
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
    defaults: { worktreeProvider: "worktrunk", terminal: "tmux", harness: "codex" },
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

function harnesses(available: readonly CliSetupHarnessId[]): SetupHarnessFact[] {
  return (["codex", "cursor", "opencode", "pi", "claude"] as const).map((id) => ({
    id,
    label: id === "opencode" ? "OpenCode" : `${id[0]?.toUpperCase()}${id.slice(1)}`,
    status: available.includes(id) ? "ok" : "missing",
    command: id === "cursor" ? "agent" : id,
  }));
}

function preparedTracking(harnessId: CliSetupHarnessId) {
  return {
    harnessId,
    capability: "supported" as const,
    requested: true,
    installed: true,
    detail: `${harnessId} hooks are installed.`,
  };
}

function pathLauncher(command: string, resolvedPath: string, checkoutPath: string) {
  return { status: "ok" as const, source: "path" as const, command, resolvedPath, checkoutPath };
}

function installedLauncher(resolvedPath: string) {
  return {
    status: "ok" as const,
    source: "installed" as const,
    command: resolvedPath,
    resolvedPath,
    checkoutPath: resolvedPath,
  };
}
