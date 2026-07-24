import { stationUiInstallHint } from "../../stationWorkspace.js";
import { setupLauncherExecutable } from "./checks/launchers.js";
import { tmuxPopupBindingBlock, tmuxPopupBindingEndMarker } from "./checks/tmuxBinding.js";
import {
  harnessSupportsSetupHooks,
  isSupportedHarnessId,
  relevantHarnessTrackingIds,
  resolveSetupHarnessSelection,
  type SetupHarnessSelection,
} from "./harnessSelection.js";
import type {
  ConfigWritePlan,
  SetupAction,
  SetupCheck,
  SetupFacts,
  SetupPlan,
  SupportedHarnessId,
} from "./model.js";
import { SetupHarnessTrackingFactSchema, SetupPlanSchema } from "./model.js";

export type BuildSetupPlanOptions = {
  configWrite?: ConfigWritePlan;
  harnessSelection?: SetupHarnessSelection;
  installWorktrunkHooks?: boolean;
};

export function buildSetupPlan(facts: SetupFacts, options: BuildSetupPlanOptions = {}): SetupPlan {
  SetupHarnessTrackingFactSchema.array().parse(facts.harnessTracking);
  const harnessSelection = options.harnessSelection ?? resolveSetupHarnessSelection(facts);
  const checks = setupChecks(facts, harnessSelection);
  const actions = setupActions(facts, harnessSelection, options.configWrite, options);
  const requiredMissing = checks.filter(
    (check) => check.tier === "required" && check.status !== "ok",
  ).length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const workflowReady = checks.every((check) => check.tier !== "required" || check.status === "ok");
  const summary = {
    launchReady:
      facts.stateDir.status === "ok" &&
      (facts.compiled || (facts.bun.status === "ok" && facts.stationUi.status !== "missing")),
    workflowReady,
    requiredOk: workflowReady,
    requiredMissing,
    warnings,
    selectedActions: actions.filter((action) => action.selected).length,
    selectionSource: harnessSelection.source,
    configPath: facts.configPath,
    ...(harnessSelection.defaultHarness === undefined
      ? {}
      : { selectedHarness: harnessSelection.defaultHarness }),
  };
  const plan = {
    generatedAt: facts.generatedAt,
    mode: facts.mode,
    checks,
    actions,
    summary,
    nextSteps: nextSteps(requiredMissing, facts),
  };
  return SetupPlanSchema.parse(plan);
}

function setupChecks(facts: SetupFacts, harnessSelection: SetupHarnessSelection): SetupCheck[] {
  return [
    stateDirCheck(facts),
    socketEvidenceCheck(facts),
    ...(facts.compiled ? [] : xcodeChecks(facts)),
    dependencyCheck({
      id: "worktrunk",
      label: "Worktrunk / wt",
      missingMessage: facts.worktrunk.message ?? "Worktrunk is required for core worktree setup.",
      dependency: facts.worktrunk,
    }),
    dependencyCheck({
      id: "tmux",
      label: "tmux",
      missingMessage: facts.tmux.message ?? "tmux is required for the reference terminal workflow.",
      dependency: facts.tmux,
    }),
    ...(facts.compiled
      ? []
      : [
          dependencyCheck({
            id: "bun",
            label: "Bun",
            missingMessage:
              facts.bun.message ?? "Bun is required to run the STATION terminal UI (bare stn).",
            dependency: facts.bun,
          }),
        ]),
    gitCheck(facts),
    harnessCheck(facts, harnessSelection),
    configCheck(facts),
    ...configDiagnosticsChecks(facts),
    launcherCheck(facts),
    ...(facts.compiled ? [] : [stationUiCheck(facts)]),
    worktrunkShellIntegrationCheck(facts),
    tmuxPopupBindingCheck(facts),
    worktrunkHooksCheck(facts),
    ...harnessTrackingChecks(facts, harnessSelection),
    diffnavCheck(facts),
    gitDeltaCheck(facts),
    {
      id: "doctor",
      tier: "recommended",
      status: "warning",
      label: "stn doctor",
      message: "Run stn doctor after setup to validate the observer runtime.",
    },
  ];
}

function socketEvidenceCheck(facts: SetupFacts): SetupCheck {
  const details = { command: facts.socketEvidence.command };
  if (facts.socketEvidence.status === "ok") {
    return {
      id: "observer-socket-evidence",
      tier: "recommended",
      status: "ok",
      label: "Observer socket evidence",
      message: "lsof is available for safe Observer socket recovery and build handoff.",
      details,
    };
  }
  return {
    id: "observer-socket-evidence",
    tier: "recommended",
    status: "warning",
    label: "Observer socket evidence",
    message: `Fresh Observer startup can continue, but stale-socket recovery and build handoff are blocked until lsof is executable at ${facts.socketEvidence.command}. Install lsof, then rerun stn setup check (Debian/Ubuntu: sudo apt-get install lsof; Fedora/RHEL: sudo dnf install lsof).`,
    details,
  };
}

function tmuxPopupBindingCheck(facts: SetupFacts): SetupCheck {
  const base = {
    id: "tmux-popup-binding",
    tier: "recommended",
    label: "tmux popup binding",
    details: {
      path: facts.tmuxBinding.path,
      launcherCommand: facts.tmuxBinding.launcherCommand,
      liveStatus: facts.tmuxBinding.liveStatus,
      ...(facts.tmuxBinding.status === "conflict"
        ? {}
        : { bindingKey: facts.tmuxBinding.bindingKey }),
    },
  } as const;
  if (facts.tmuxBinding.status === "conflict") {
    return {
      ...base,
      status: "warning",
      message: facts.tmuxBinding.message,
    };
  }
  if (facts.tmux.status !== "ok") {
    return {
      ...base,
      status: "skipped",
      message: "Skipped until tmux is available.",
    };
  }
  if (facts.launchers.tmuxPopup.status !== "ok") {
    return {
      ...base,
      status: "warning",
      message: "Resolve the stn-tmux-popup launcher, then rerun stn setup to install the binding.",
    };
  }
  if (facts.tmuxBinding.status === "missing") {
    return {
      ...base,
      status: "warning",
      message: facts.tmuxBinding.message,
    };
  }
  if (facts.tmuxBinding.insideTmux && facts.tmuxBinding.liveStatus !== "loaded") {
    const liveMessage =
      facts.tmuxBinding.liveStatus === "missing"
        ? "is not loaded with that executable launcher"
        : "could not be verified in the current tmux server";
    return {
      ...base,
      status: "warning",
      message: `tmux popup binding is persisted but ${liveMessage}; rerun stn setup to repair it.`,
    };
  }
  return {
    ...base,
    status: "ok",
    message: "tmux popup binding is installed.",
  };
}

function stateDirCheck(facts: SetupFacts): SetupCheck {
  return {
    id: "state-dir",
    tier: "required",
    status: facts.stateDir.status === "ok" ? "ok" : "missing",
    label: "STATION state directory",
    message:
      facts.stateDir.status === "ok"
        ? "STATION state directory is writable."
        : facts.stateDir.message,
    details: { path: facts.stateDir.path },
  };
}

function launcherCheck(facts: SetupFacts): SetupCheck {
  const launchers = [facts.launchers.station, facts.launchers.ingress, facts.launchers.tmuxPopup];
  const missing = launchers.filter((launcher) => launcher.status === "missing");
  const launcherEntries = [
    ["stn", facts.launchers.station],
    ["stn-ingress", facts.launchers.ingress],
    ["stn-tmux-popup", facts.launchers.tmuxPopup],
  ] as const;
  const checkoutOutsidePath = launcherEntries.flatMap((entry) =>
    entry[1].source === "checkout" ? [entry[0]] : [],
  );
  const installedOutsidePath = launcherEntries.flatMap((entry) =>
    entry[1].source === "installed" ? [entry[0]] : [],
  );
  const details = {
    station: setupLauncherExecutable(facts.launchers.station),
    ingress: setupLauncherExecutable(facts.launchers.ingress),
    tmuxPopup: setupLauncherExecutable(facts.launchers.tmuxPopup),
  };
  let warningMessage: string | undefined;
  if (missing.length > 0) {
    warningMessage = `Some STATION launchers are missing: ${missing.map((launcher) => launcher.command).join(", ")}.`;
  } else if (checkoutOutsidePath.length > 0 && installedOutsidePath.length > 0) {
    warningMessage = `These bare STATION launchers do not resolve to setup's selected executables on PATH: ${[...checkoutOutsidePath, ...installedOutsidePath].join(", ")}.`;
  } else if (checkoutOutsidePath.length > 0) {
    warningMessage = `These bare launchers do not resolve to this checkout on PATH: ${checkoutOutsidePath.join(", ")}; setup will use their current-checkout paths.`;
  } else if (installedOutsidePath.length > 0) {
    warningMessage = `STATION is installed, but these bare launchers do not resolve to this installation on PATH: ${installedOutsidePath.join(", ")}.`;
  }
  if (warningMessage !== undefined) {
    return {
      id: "station-launchers",
      tier: "recommended",
      status: "warning",
      label: "STATION launchers",
      message: warningMessage,
      details,
    };
  }
  return {
    id: "station-launchers",
    tier: "recommended",
    status: "ok",
    label: "STATION launchers",
    message: "stn, stn-ingress, and stn-tmux-popup are available on PATH.",
    details,
  };
}

function worktrunkShellIntegrationCheck(facts: SetupFacts): SetupCheck {
  const integration = facts.worktrunkShellIntegration;
  const details: Record<string, string> = {};
  if (integration.shell !== undefined) details.shell = integration.shell;
  if (integration.rcPath !== undefined) details.rcPath = integration.rcPath;
  const check: SetupCheck = {
    id: "worktrunk-shell-integration",
    tier: "recommended",
    status: integration.status,
    label: "Worktrunk shell integration",
    message: integration.message,
  };
  if (integration.shell !== undefined || integration.rcPath !== undefined) check.details = details;
  return check;
}

function stationUiCheck(facts: SetupFacts): SetupCheck {
  if (facts.stationUi.status === "installed") {
    return {
      id: "station-ui",
      tier: "recommended",
      status: "ok",
      label: "STATION UI dependencies",
      message: "The station/ Bun UI lane is installed.",
    };
  }
  if (facts.stationUi.status === "missing") {
    return {
      id: "station-ui",
      tier: "recommended",
      status: "warning",
      label: "STATION UI dependencies",
      message: `${stationUiInstallHint} Until then bare stn cannot render the terminal UI (stn doctor reports this as STATION_UI_NOT_INSTALLED).`,
    };
  }
  return {
    id: "station-ui",
    tier: "recommended",
    status: "skipped",
    label: "STATION UI dependencies",
    message: "Skipped until Bun is available (or a STATION_DASHBOARD_COMMAND override is set).",
  };
}

function worktrunkHooksCheck(facts: SetupFacts): SetupCheck {
  if (facts.worktrunk.status !== "ok") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: "skipped",
      label: "Worktrunk hooks",
      message: "Skipped until Worktrunk is available.",
    };
  }
  if (facts.config.status !== "valid") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: "warning",
      label: "Worktrunk hooks",
      message: "Recommended: install Worktrunk lifecycle hooks during setup.",
    };
  }
  if (facts.worktrunkAutomation.status !== "skipped") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: facts.worktrunkAutomation.status,
      label: "Worktrunk hooks",
      message: facts.worktrunkAutomation.message,
      details: worktrunkAutomationDetails(facts.worktrunkAutomation),
    };
  }
  return {
    id: "worktrunk-hooks",
    tier: "recommended",
    status: "ok",
    label: "Worktrunk hooks",
    message: "Lifecycle hook automation uses Worktrunk defaults; no prompt flags are configured.",
    details: { automationMode: "worktrunk-default" },
  };
}

function worktrunkAutomationDetails(
  automation: SetupFacts["worktrunkAutomation"],
): Record<string, string> {
  const details: Record<string, string> = {
    automationMode: automation.automationMode,
  };
  if (automation.flag !== undefined) details.flag = automation.flag;
  if (automation.missingSubcommands !== undefined && automation.missingSubcommands.length > 0) {
    details.missingSubcommands = automation.missingSubcommands.join(", ");
  }
  return details;
}

function harnessTrackingChecks(
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
): SetupCheck[] {
  const harnessIds = relevantHarnessTrackingIds(facts, harnessSelection);
  const required = new Set(harnessSelection.requiredHarnessIds);
  return harnessIds.map((harnessId) =>
    harnessTrackingCheck(facts, harnessId, required.has(harnessId), harnessSelection.source),
  );
}

type HarnessTrackingAssessmentResult = {
  status: SetupCheck["status"];
  message: string;
};

type NoExternalTrackingAssessment = HarnessTrackingAssessmentResult & {
  capability: "unsupported";
  state: "not-applicable";
};

type ExternalTrackingAssessment = HarnessTrackingAssessmentResult & {
  capability: "supported";
  state: "probe-failed" | "disabled" | "artifact-missing-or-drifted" | "prepared";
  requested: boolean | undefined;
  installed: boolean | undefined;
};

// The capability discriminant keeps no-artifact outcomes distinct from incomplete external evidence.
type HarnessTrackingAssessment = NoExternalTrackingAssessment | ExternalTrackingAssessment;

function harnessTrackingCheck(
  facts: SetupFacts,
  harnessId: SupportedHarnessId,
  required: boolean,
  selectionSource: SetupHarnessSelection["source"],
): SetupCheck {
  const harnessLabel =
    facts.harnesses.find((candidate) => candidate.id === harnessId)?.label ?? harnessId;
  const assessment = assessHarnessTracking(facts, harnessId, harnessLabel, required);
  const details: Record<string, string> = {
    harness: harnessId,
    selectionSource,
    capability: assessment.capability,
    state: assessment.state,
  };
  if (assessment.capability === "supported") {
    if (assessment.requested !== undefined) details.requested = String(assessment.requested);
    if (assessment.installed !== undefined) details.installed = String(assessment.installed);
  }
  return {
    id: `harness-tracking:${harnessId}`,
    tier: required ? "required" : "recommended",
    status: assessment.status,
    label: `${harnessLabel} tracking`,
    message: assessment.message,
    details,
  };
}

function assessHarnessTracking(
  facts: SetupFacts,
  harnessId: SupportedHarnessId,
  harnessLabel: string,
  required: boolean,
): HarnessTrackingAssessment {
  if (!harnessSupportsSetupHooks(harnessId)) {
    return {
      capability: "unsupported",
      state: "not-applicable",
      status: required ? "ok" : "skipped",
      message: `${harnessLabel} has no Station-managed external tracking artifact.`,
    };
  }

  const fact = facts.harnessTracking.find((candidate) => candidate.harnessId === harnessId);
  const configRequested =
    facts.config.status === "valid" && facts.config.configuredHookHarnesses.includes(harnessId);
  return assessSupportedHarnessTracking({
    fact,
    harnessId,
    harnessLabel,
    configRequested,
    required,
  });
}

function assessSupportedHarnessTracking(input: {
  fact: SetupFacts["harnessTracking"][number] | undefined;
  harnessId: SupportedHarnessId;
  harnessLabel: string;
  configRequested: boolean;
  required: boolean;
}): HarnessTrackingAssessment {
  const { fact, harnessId, harnessLabel, configRequested, required } = input;
  const unavailableStatus = required ? "missing" : "warning";
  if (fact === undefined || fact.capability !== "supported" || fact.probeFailed === true) {
    const supportedFact = fact?.capability === "supported" ? fact : undefined;
    return {
      capability: "supported",
      state: "probe-failed",
      status: unavailableStatus,
      message: fact?.detail ?? `${harnessId} tracking status could not be inspected.`,
      requested: supportedFact?.requested,
      installed: supportedFact?.installed,
    };
  }
  if (!configRequested || fact.requested !== true) {
    return {
      capability: "supported",
      state: "disabled",
      status: unavailableStatus,
      message: `${harnessLabel} tracking is disabled in Station config.`,
      requested: fact.requested,
      installed: fact.installed,
    };
  }
  if (fact.installed !== true) {
    return {
      capability: "supported",
      state: "artifact-missing-or-drifted",
      status: unavailableStatus,
      message: fact.detail ?? `${harnessId} tracking artifacts are absent or drifted.`,
      requested: fact.requested,
      installed: fact.installed,
    };
  }
  return {
    capability: "supported",
    state: "prepared",
    status: "ok",
    message: `${harnessLabel} Station tracking artifacts are prepared on disk.`,
    requested: fact.requested,
    installed: fact.installed,
  };
}

function xcodeChecks(facts: SetupFacts): SetupCheck[] {
  // Only surface a row when there is something to fix: a macOS host missing the
  // Command Line Tools. Healthy or non-macOS hosts add no noise to the plan.
  if (facts.xcode.status !== "missing") return [];
  return [
    {
      id: "command-line-tools",
      tier: "required",
      status: "missing",
      label: "Command Line Tools",
      message: facts.xcode.message,
    },
  ];
}

function dependencyCheck(input: {
  id: string;
  label: string;
  missingMessage: string;
  dependency: SetupFacts["worktrunk"];
}): SetupCheck {
  const details: Record<string, string> = { command: input.dependency.command };
  if (input.dependency.version !== undefined) details.version = input.dependency.version;
  if (input.dependency.resolvedPath !== undefined) {
    details.resolvedPath = input.dependency.resolvedPath;
  }
  return {
    id: input.id,
    tier: "required",
    status: input.dependency.status === "ok" ? "ok" : "missing",
    label: input.label,
    message:
      input.dependency.status === "ok" ? `${input.label} is available.` : input.missingMessage,
    details,
  };
}

function diffnavCheck(facts: SetupFacts): SetupCheck {
  const details: Record<string, string> = { command: facts.diffnav.command };
  if (facts.diffnav.resolvedPath !== undefined) details.resolvedPath = facts.diffnav.resolvedPath;
  if (facts.diffnav.status === "ok") {
    return {
      id: "diffnav",
      tier: "required",
      status: "ok",
      label: "diffnav",
      message: "diffnav is available for the STATION 'See diff (split right)' automation.",
      details,
    };
  }
  return {
    id: "diffnav",
    tier: "required",
    status: "missing",
    label: "diffnav",
    message:
      facts.diffnav.message ??
      "diffnav is required for the STATION 'See diff (split right)' automation.",
    details,
  };
}

function gitDeltaCheck(facts: SetupFacts): SetupCheck {
  const details: Record<string, string> = { command: facts.gitDelta.command };
  if (facts.gitDelta.resolvedPath !== undefined) details.resolvedPath = facts.gitDelta.resolvedPath;
  if (facts.gitDelta.status === "ok") {
    return {
      id: "git-delta",
      tier: "required",
      status: "ok",
      label: "git-delta",
      message:
        "git-delta is available; diffnav renders the STATION 'See diff' automation through it.",
      details,
    };
  }
  return {
    id: "git-delta",
    tier: "required",
    status: "missing",
    label: "git-delta",
    message:
      facts.gitDelta.message ??
      "git-delta is required; diffnav renders the STATION 'See diff' automation through it.",
    details,
  };
}

function gitCheck(facts: SetupFacts): SetupCheck {
  if (facts.git.status === "ok") {
    return {
      id: "git-project",
      tier: "required",
      status: "ok",
      label: "Git",
      message: "Git is available; choose projects explicitly in STATION.",
      details: {
        root: facts.git.root,
        defaultBranch: facts.git.defaultBranch,
      },
    };
  }
  if (facts.git.reason === "not-a-repo") {
    return {
      id: "git-project",
      tier: "required",
      status: "ok",
      label: "Git",
      message: "Git is available; choose a project explicitly in STATION.",
      details: { defaultBranch: facts.git.defaultBranch },
    };
  }
  return {
    id: "git-project",
    tier: "required",
    status: "missing",
    label: "Git",
    message: facts.git.message,
    details: {
      defaultBranch: facts.git.defaultBranch,
    },
  };
}

function harnessCheck(facts: SetupFacts, harnessSelection: SetupHarnessSelection): SetupCheck {
  const available = facts.harnesses.filter((harness) => harness.status === "ok");
  const details: Record<string, string> = {
    available: available.map((harness) => harness.id).join(","),
    selectionSource: harnessSelection.source,
  };
  if (harnessSelection.defaultHarness !== undefined) {
    details.default = harnessSelection.defaultHarness;
  }
  if (harnessSelection.requiredHarnessIds.length > 0) {
    details.enabled = harnessSelection.requiredHarnessIds.join(",");
  }

  if (harnessSelection.source === "unresolved") {
    details.state = "selection-required";
    return {
      id: "harness",
      tier: "required",
      status: "missing",
      label: "Agent CLI",
      message: unresolvedHarnessMessage(available),
      details,
    };
  }

  const unavailable = harnessSelection.requiredHarnessIds.filter(
    (id) => !available.some((harness) => harness.id === id),
  );
  if (unavailable.length > 0) {
    details.unavailable = unavailable.join(",");
    const defaultUnavailable =
      harnessSelection.defaultHarness !== undefined &&
      unavailable.includes(harnessSelection.defaultHarness);
    details.defaultStatus = defaultUnavailable ? "unavailable" : "available";
    return {
      id: "harness",
      tier: "required",
      status: "missing",
      label: "Agent CLI",
      message:
        harnessSelection.source === "configured"
          ? `${unavailable[0]} remains configured as the default agent CLI, but it is unavailable; another agent CLI cannot satisfy that default.`
          : `Selected agent CLIs are unavailable: ${unavailable.join(", ")}.`,
      details,
    };
  }

  const selectedDefault = available.find(
    (harness) => harness.id === harnessSelection.defaultHarness,
  );
  if (selectedDefault !== undefined) {
    details.command = selectedDefault.command;
    details.defaultStatus = "available";
  }
  const selectedLabels = harnessSelection.requiredHarnessIds.map(
    (id) => facts.harnesses.find((harness) => harness.id === id)?.label ?? id,
  );
  return {
    id: "harness",
    tier: "required",
    status: "ok",
    label: "Agent CLI",
    message: selectedHarnessMessage(harnessSelection.source, selectedLabels),
    details,
  };
}

function unresolvedHarnessMessage(available: readonly SetupFacts["harnesses"][number][]): string {
  if (available.length > 1) {
    return `Multiple supported agent CLIs are available (${available.map((item) => item.id).join(", ")}); run guided setup and select one explicitly.`;
  }
  if (available.length === 0) {
    return "Install one supported harness CLI: claude, codex, cursor agent, opencode, or pi.";
  }
  return "Harness selection could not be resolved from the current config.";
}

function selectedHarnessMessage(
  source: SetupHarnessSelection["source"],
  selectedLabels: readonly string[],
): string {
  if (source === "inferred") {
    return `${selectedLabels[0]} was inferred because it is the only runnable supported agent CLI.`;
  }
  if (source === "explicit") {
    return `Explicit agent selection: ${selectedLabels.join(", ")}.`;
  }
  return `${selectedLabels[0]} is preserved as the configured default agent CLI.`;
}

function configCheck(facts: SetupFacts): SetupCheck {
  if (facts.config.status === "missing") {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: "STATION config",
      message: facts.config.message,
      details: { path: facts.config.path },
    };
  }
  if (facts.config.status === "invalid") {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: "STATION config",
      message: facts.config.message,
      details: { path: facts.config.path },
    };
  }
  const defaultCoreProblem = defaultConfigCoreProblem(facts.config);
  if (defaultCoreProblem !== undefined) {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: "STATION config",
      message: defaultCoreProblem,
      details: {
        path: facts.config.path,
        worktreeProvider: facts.config.defaults.worktreeProvider,
        terminal: facts.config.defaults.terminal,
        harness: facts.config.defaults.harness,
      },
    };
  }
  return {
    id: "config",
    tier: "required",
    status: "ok",
    label: "STATION config",
    message: "Core STATION config is ready; projects are added explicitly in STATION.",
    details: {
      path: facts.config.path,
      harness: facts.config.defaults.harness,
      configuredHarnesses: facts.config.configuredHarnesses.join(","),
    },
  };
}

function configDiagnosticsChecks(facts: SetupFacts): SetupCheck[] {
  if (facts.config.status !== "valid") {
    return [];
  }
  const diagnostics = facts.config.diagnostics ?? [];
  if (diagnostics.length === 0) {
    return [];
  }
  const details: Record<string, string> = { path: facts.config.path };
  if (facts.config.matchedProject !== undefined) {
    details.project = facts.config.matchedProject.id;
  }
  return [
    {
      id: "config-diagnostics",
      tier: "recommended",
      status: "warning",
      label: "STATION config diagnostics",
      message: `Config loaded with ${diagnostics.length} diagnostic(s): ${diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
      details,
    },
  ];
}

function defaultConfigCoreProblem(
  config: Extract<SetupFacts["config"], { status: "valid" }>,
): string | undefined {
  if (config.defaults.worktreeProvider !== "worktrunk") {
    return `Config defaults use worktree provider ${config.defaults.worktreeProvider}; set defaults.worktree_provider to "worktrunk" for the setup core path.`;
  }
  if (config.defaults.terminal !== "tmux") {
    return `Config defaults use terminal ${config.defaults.terminal}; set defaults.terminal to "tmux" for the setup core path.`;
  }
  if (!isSupportedHarnessId(config.defaults.harness)) {
    return `Config defaults use unsupported harness ${config.defaults.harness}; choose claude, codex, cursor, opencode, or pi for the setup core path.`;
  }
  return undefined;
}

function setupActions(
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
  configWrite: ConfigWritePlan | undefined,
  options: BuildSetupPlanOptions,
): SetupAction[] {
  const actions: SetupAction[] = [];
  if (facts.worktrunk.status === "missing") {
    actions.push(installAction("install-worktrunk", "Worktrunk", "worktrunk", facts.brew));
  }
  if (facts.tmux.status === "missing") {
    actions.push(installAction("install-tmux", "tmux", "tmux", facts.brew));
  }
  if (!facts.compiled && facts.bun.status === "missing") {
    actions.push(installAction("install-bun", "Bun", "bun", facts.brew));
  }
  if (facts.diffnav.status === "missing") {
    actions.push(installAction("install-diffnav", "diffnav", "diffnav", facts.brew));
  }
  // delta is diffnav's renderer, not standalone-useful here; install it alongside
  // so a required diffnav never yields a diffnav that errors for a missing delta.
  if (facts.gitDelta.status === "missing") {
    actions.push(installAction("install-git-delta", "git-delta", "git-delta", facts.brew));
  }
  if (stationLaunchersNeedLink(facts)) {
    actions.push({
      id: "link-station-launchers",
      kind: "run-command",
      tier: "recommended",
      selected: false,
      label: "Link STATION launchers",
      message: "Link stn, stn-ingress, and stn-tmux-popup globally for bare terminal commands.",
      command: ["pnpm", "--dir", facts.launchers.packageRoot, "station:link"],
    });
  }
  if (
    facts.worktrunk.status === "ok" &&
    facts.worktrunkShellIntegration.status !== "ok" &&
    facts.worktrunkShellIntegration.shell !== undefined
  ) {
    actions.push({
      id: "worktrunk-shell-integration",
      kind: "run-command",
      tier: "recommended",
      selected: false,
      label: "Install Worktrunk shell integration",
      message: "Run wt config shell install after core setup if you want Worktrunk shell helpers.",
      command: [
        facts.worktrunk.resolvedPath ?? facts.worktrunk.command,
        "-y",
        "config",
        "shell",
        "install",
      ],
    });
  }
  if (
    facts.tmux.status === "ok" &&
    facts.launchers.tmuxPopup.status === "ok" &&
    facts.tmuxBinding.status === "missing"
  ) {
    actions.push({
      id: "tmux-popup-binding",
      kind: "append-file",
      tier: "recommended",
      selected: false,
      label: "Install tmux popup binding",
      message: `Install the tmux prefix + ${facts.tmuxBinding.bindingKey} binding for the STATION popup dashboard in ~/.tmux.conf.`,
      path: facts.tmuxBinding.path,
      data: {
        marker: facts.tmuxBinding.marker,
        endMarker: tmuxPopupBindingEndMarker,
        appendedText: tmuxPopupBindingBlock(facts.tmuxBinding.launcherCommand, {
          bindingKey: facts.tmuxBinding.bindingKey,
          runShellCommand: facts.tmuxBinding.runShellCommand,
        }),
      },
    });
  }
  if (
    facts.tmux.status === "ok" &&
    facts.launchers.tmuxPopup.status === "ok" &&
    facts.tmuxBinding.status !== "conflict" &&
    facts.tmuxBinding.insideTmux &&
    facts.tmuxBinding.liveStatus !== "loaded"
  ) {
    actions.push({
      id: "tmux-live-popup-binding",
      kind: "run-command",
      tier: "recommended",
      selected: false,
      label: "Load tmux popup binding",
      message: `Install the tmux prefix + ${facts.tmuxBinding.bindingKey} STATION popup binding in the current tmux server.`,
      command: [
        facts.tmux.resolvedPath ?? facts.tmux.command,
        "bind-key",
        facts.tmuxBinding.bindingKey,
        "run-shell",
        "-b",
        facts.tmuxBinding.runShellCommand,
      ],
    });
  }

  actions.push(...hookSetupActions(facts, harnessSelection, options));

  const configActions = configWriteActions(configWrite, harnessSelection.selected.length > 0);
  actions.push(...configActions);
  return actions;
}

function stationLaunchersNeedLink(facts: SetupFacts): boolean {
  return [facts.launchers.station, facts.launchers.ingress, facts.launchers.tmuxPopup].some(
    (launcher) => launcher.source !== "path" && launcher.source !== "installed",
  );
}

function hookSetupActions(
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
  options: BuildSetupPlanOptions,
): SetupAction[] {
  if (facts.launchers.station.status !== "ok" || facts.launchers.ingress.status !== "ok") {
    return [];
  }
  const actions: SetupAction[] = [];
  if (facts.worktrunk.status === "ok") {
    actions.push({
      id: "worktrunk-hooks",
      kind: "run-command",
      tier: "recommended",
      selected: options.installWorktrunkHooks === true,
      label: "Install Worktrunk hooks",
      message: "Install Worktrunk lifecycle hooks that report worktree changes to STATION.",
      command: [
        setupLauncherExecutable(facts.launchers.station),
        "--config",
        facts.configPath,
        "hooks",
        "install",
        "worktrunk",
        "--yes",
      ],
      data: { setupRole: "hook" },
    });
  }
  for (const selectedHarness of harnessSelection.selected) {
    if (
      !harnessSupportsSetupHooks(selectedHarness.id) ||
      harnessTrackingPrepared(facts, selectedHarness.id)
    ) {
      continue;
    }
    actions.push({
      id: `${selectedHarness.id}-hooks`,
      kind: "run-command",
      tier: "required",
      selected: true,
      label: `Install ${selectedHarness.label} tracking`,
      message: `Install Station-owned ${selectedHarness.label} tracking artifacts.`,
      command: harnessHookInstallCommand(facts, selectedHarness.id),
      data: { setupRole: "hook", harness: selectedHarness.id },
    });
  }
  return actions;
}

function harnessTrackingPrepared(facts: SetupFacts, harnessId: SupportedHarnessId): boolean {
  const fact = facts.harnessTracking.find((candidate) => candidate.harnessId === harnessId);
  return fact?.capability === "supported" && fact.requested === true && fact.installed === true;
}

function harnessHookInstallCommand(facts: SetupFacts, harness: SupportedHarnessId): string[] {
  const command = [
    setupLauncherExecutable(facts.launchers.station),
    "--config",
    facts.configPath,
    "hooks",
    "install",
    harness,
    "--yes",
  ];
  if (harness === "claude" || harness === "codex" || harness === "cursor") {
    command.push("--hook-bin", setupLauncherExecutable(facts.launchers.ingress));
  }
  return command;
}

function installAction(
  id: string,
  label: string,
  formula: string,
  brew: SetupFacts["brew"],
): SetupAction {
  const action: SetupAction = {
    id,
    kind: brew.status === "ok" ? "brew-install" : "noop",
    tier: "required",
    selected: brew.status === "ok",
    label: `Install ${label}`,
    message:
      brew.status === "ok"
        ? `Install ${label} with Homebrew.`
        : `Homebrew is unavailable; install ${label} manually with: brew install ${formula}`,
    command: ["brew", "install", formula],
    data: { formula },
  };
  return action;
}

function configWriteActions(
  configWrite: ConfigWritePlan | undefined,
  hasSelectedHarness: boolean,
): SetupAction[] {
  if (!hasSelectedHarness) return [];
  if (configWrite === undefined || configWrite.operation === "none") {
    return [];
  }
  if (configWrite.operation === "blocked") {
    return [
      {
        id: "config-blocked",
        kind: "noop",
        tier: "required",
        selected: false,
        label: "Update STATION config",
        message: configWrite.reason,
        path: configWrite.path,
      },
    ];
  }
  const mkdirAction: SetupAction = {
    id: "mkdir-config-dir",
    kind: "mkdir",
    tier: "required",
    selected: true,
    label: "Create config directory",
    message: "Create the parent directory for the STATION config file.",
    path: configWrite.path,
  };
  const writeAction: SetupAction = {
    id: configWrite.operation === "create" ? "write-config" : "update-config",
    kind: "write-config",
    tier: "required",
    selected: true,
    label: configWrite.operation === "create" ? "Write STATION config" : "Update STATION config",
    message:
      configWrite.operation === "create"
        ? "Create the core STATION config; add your first project in STATION."
        : "Update selected harness settings and append safe missing setup blocks.",
    path: configWrite.path,
    data: {
      operation: configWrite.operation,
      content: configWrite.content,
      ...(configWrite.backupPath === undefined ? {} : { backupPath: configWrite.backupPath }),
    },
  };
  return [mkdirAction, writeAction];
}

function nextSteps(requiredMissing: number, facts: SetupFacts): string[] {
  if (requiredMissing === 0) {
    const stationCommand = quoteCommandPart(facts.launchers.station.command);
    return [`${stationCommand} doctor`, stationCommand];
  }
  if (facts.stateDir.status === "missing") {
    return [facts.stateDir.message];
  }
  if (facts.xcode.status === "missing") {
    return [facts.xcode.message];
  }
  if (facts.worktrunk.status === "missing") {
    return ["Install Worktrunk, then run: stn setup check"];
  }
  if (facts.tmux.status === "missing") {
    return ["Install tmux, then run: stn setup check"];
  }
  if (facts.bun.status === "missing") {
    return ["Install Bun (brew install bun), then run: stn setup check"];
  }
  if (facts.git.status === "missing" && facts.git.reason === "git-absent") {
    return [facts.git.message];
  }
  if (facts.diffnav.status === "missing" || facts.gitDelta.status === "missing") {
    return [
      "Install diffnav and git-delta (brew install diffnav git-delta), then run: stn setup check",
    ];
  }
  return ["Resolve the missing required setup items, then run: stn setup check"];
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(part)) {
    return part;
  }
  return `'${part.replaceAll("'", "'\\''")}'`;
}
