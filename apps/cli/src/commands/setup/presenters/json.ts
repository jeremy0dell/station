import { dirname } from "node:path";
import type { SetupConfigMutationPlan } from "@station/config";
import {
  type CliSetupAction,
  type CliSetupCheck,
  type CliSetupHarnessId,
  CliSetupHarnessIdSchema,
  type CliSetupPlan,
  CliSetupPlanSchema,
  type ProviderHookArtifactOwnership,
} from "@station/contracts";
import type { HarnessTrackingAssessment, SetupOperation, SetupPlan } from "@station/setup-core";
import { stationUiInstallHint } from "../../../stationWorkspace.js";
import type { SetupFacts } from "../adapters/inspectionTypes.js";
import { SetupHarnessTrackingFactSchema } from "../adapters/inspectionTypes.js";
import { setupLauncherExecutable } from "../checks/launchers.js";
import { tmuxPopupBindingBlock, tmuxPopupBindingEndMarker } from "../checks/tmuxBinding.js";
import { SETUP_HARNESS_DEFINITIONS } from "../harnessDefinitions.js";
import { SETUP_TOOL_DEFINITIONS } from "../toolDefinitions.js";

type SetupHarnessSelection = {
  readonly source: CliSetupPlan["summary"]["selectionSource"];
  readonly requiredHarnessIds: readonly CliSetupHarnessId[];
  readonly defaultHarness?: CliSetupHarnessId;
};

export type JsonSetupPresenterInput = {
  readonly plan: SetupPlan;
  readonly facts: SetupFacts;
  readonly configMutation?: SetupConfigMutationPlan;
};

export type JsonSetupPresenter = {
  readonly project: (input: JsonSetupPresenterInput) => CliSetupPlan;
};

/**
 * ADAPTER
 *
 * Directly projects semantic plans and adapter evidence into the strict frozen CLI schema without resolving human presentation copy.
 */
export function createJsonSetupPresenter(): JsonSetupPresenter {
  return { project: projectJsonSetupPlan };
}

function projectJsonSetupPlan(input: JsonSetupPresenterInput): CliSetupPlan {
  const { facts } = input;
  SetupHarnessTrackingFactSchema.array().parse(facts.harnessTracking);
  const harnessSelection = projectHarnessSelection(input.plan);
  const checks = setupChecks(input.plan, facts, harnessSelection);
  const actions = setupActions(
    input.plan.operations,
    facts,
    harnessSelection,
    input.configMutation,
  );
  const { readiness } = input.plan.result;
  assertMachineProjectionCounts(input.plan, checks);
  const summary = {
    launchReady: readiness.launchReady,
    workflowReady: readiness.workflowReady,
    requiredOk: readiness.workflowReady,
    requiredMissing: readiness.requiredMissing,
    warnings: checks.filter((check) => check.status === "warning").length,
    selectedActions: actions.filter((action) => action.selected).length,
    selectionSource: harnessSelection.source,
    configPath: facts.configPath,
    ...(harnessSelection.defaultHarness === undefined
      ? {}
      : { selectedHarness: harnessSelection.defaultHarness }),
  };
  return CliSetupPlanSchema.parse({
    generatedAt: input.plan.generatedAt,
    mode: input.plan.mode,
    checks,
    actions,
    summary,
    nextSteps: nextSteps(readiness.requiredMissing, facts),
  });
}

function assertMachineProjectionCounts(plan: SetupPlan, checks: readonly CliSetupCheck[]): void {
  const requiredMissing = checks.filter(
    (check) => check.tier === "required" && check.status !== "ok",
  ).length;
  if (plan.result.readiness.requiredMissing !== requiredMissing) {
    throw new Error(
      `Semantic setup required count does not match the machine projection: ${plan.result.readiness.requiredMissing}/${requiredMissing}.`,
    );
  }
}

function projectHarnessSelection(plan: SetupPlan): SetupHarnessSelection {
  if (plan.selection.outcome !== "selected") {
    return { requiredHarnessIds: [], source: "unresolved" };
  }
  return {
    requiredHarnessIds: plan.selection.requiredHarnessIds,
    source: plan.selection.source,
    defaultHarness: plan.selection.defaultHarness,
  };
}

function setupChecks(
  plan: SetupPlan,
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
): CliSetupCheck[] {
  return [
    stateDirCheck(facts),
    socketEvidenceCheck(facts),
    ...(facts.compiled ? [] : xcodeChecks(facts)),
    dependencyCheck({
      definition: SETUP_TOOL_DEFINITIONS.worktrunk,
      facts,
      missingMessage: facts.worktrunk.message ?? "Worktrunk is required for core worktree setup.",
    }),
    dependencyCheck({
      definition: SETUP_TOOL_DEFINITIONS.tmux,
      facts,
      missingMessage: facts.tmux.message ?? "tmux is required for the reference terminal workflow.",
    }),
    ...(facts.compiled
      ? []
      : [
          dependencyCheck({
            definition: SETUP_TOOL_DEFINITIONS.bun,
            facts,
            missingMessage:
              facts.bun.message ?? "Bun is required to run the STATION terminal UI (bare stn).",
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
    ...harnessTrackingChecks(plan, facts, harnessSelection),
    dependencyCheck({
      definition: SETUP_TOOL_DEFINITIONS["diff-viewer"],
      facts,
      missingMessage:
        facts.diffViewer.message ?? "Hunk is required for the STATION 'See diff' automation.",
    }),
    {
      id: "doctor",
      tier: "recommended",
      status: "warning",
      label: "stn doctor",
      message: "Run stn doctor after setup to validate the observer runtime.",
    },
  ];
}

function socketEvidenceCheck(facts: SetupFacts): CliSetupCheck {
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

function tmuxPopupBindingCheck(facts: SetupFacts): CliSetupCheck {
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

function stateDirCheck(facts: SetupFacts): CliSetupCheck {
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

function launcherCheck(facts: SetupFacts): CliSetupCheck {
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
  const stationExecutable = setupLauncherExecutable(facts.launchers.station);
  const ingressExecutable = setupLauncherExecutable(facts.launchers.ingress);
  const tmuxPopupExecutable = setupLauncherExecutable(facts.launchers.tmuxPopup);
  const stationDirectory = dirname(stationExecutable);
  const launchersShareDirectory = [ingressExecutable, tmuxPopupExecutable].every(
    (executable) => dirname(executable) === stationDirectory,
  );
  const details: Record<string, string> = {
    station: stationExecutable,
    ingress: ingressExecutable,
    tmuxPopup: tmuxPopupExecutable,
  };
  if (missing.length === 0 && installedOutsidePath.length > 0 && launchersShareDirectory) {
    details.pathDirectory = stationDirectory;
  }
  let warningMessage: string | undefined;
  if (missing.length > 0) {
    warningMessage = `Some STATION launchers are missing: ${missing.map((launcher) => launcher.command).join(", ")}.`;
  } else if (checkoutOutsidePath.length > 0 && installedOutsidePath.length > 0) {
    warningMessage = `These bare STATION launchers do not resolve to setup's selected executables on PATH: ${[...checkoutOutsidePath, ...installedOutsidePath].join(", ")}. Use the installer's PATH guidance for installed launchers; setup can link checkout launchers separately.`;
  } else if (checkoutOutsidePath.length > 0) {
    warningMessage = `These bare launchers do not resolve to this checkout on PATH: ${checkoutOutsidePath.join(", ")}; setup will use their current-checkout paths.`;
  } else if (installedOutsidePath.length > 0) {
    warningMessage = `STATION is installed, but these bare launchers do not resolve to this installation on PATH: ${installedOutsidePath.join(", ")}. Use the installer's PATH guidance to repair bare launcher resolution.`;
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

function worktrunkShellIntegrationCheck(facts: SetupFacts): CliSetupCheck {
  const integration = facts.worktrunkShellIntegration;
  const details: Record<string, string> = {};
  if (integration.shell !== undefined) details.shell = integration.shell;
  if (integration.rcPath !== undefined) details.rcPath = integration.rcPath;
  const check: CliSetupCheck = {
    id: "worktrunk-shell-integration",
    tier: "recommended",
    status: integration.status,
    label: "Worktrunk shell integration",
    message: integration.message,
  };
  if (integration.shell !== undefined || integration.rcPath !== undefined) check.details = details;
  return check;
}

function stationUiCheck(facts: SetupFacts): CliSetupCheck {
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

function worktrunkHooksCheck(facts: SetupFacts): CliSetupCheck {
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
  plan: SetupPlan,
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
): CliSetupCheck[] {
  const harnessIds = plan.evidence.harnessTracking.map((tracking) => tracking.harnessId);
  const required = new Set(harnessSelection.requiredHarnessIds);
  return harnessIds.map((harnessId) =>
    harnessTrackingCheck(plan, facts, harnessId, required.has(harnessId), harnessSelection.source),
  );
}

function harnessTrackingCheck(
  plan: SetupPlan,
  facts: SetupFacts,
  harnessId: CliSetupHarnessId,
  required: boolean,
  selectionSource: SetupHarnessSelection["source"],
): CliSetupCheck {
  const harnessLabel =
    facts.harnesses.find((candidate) => candidate.id === harnessId)?.label ?? harnessId;
  const fact = facts.harnessTracking.find((candidate) => candidate.harnessId === harnessId);
  const assessment = plan.evidence.harnessTracking.find(
    (tracking) => tracking.harnessId === harnessId,
  )?.assessment;
  if (assessment === undefined) {
    throw new Error(`Semantic tracking evidence is missing for ${harnessId}.`);
  }
  const presentation = harnessTrackingPresentation(
    assessment,
    fact,
    harnessId,
    harnessLabel,
    required,
  );
  const details: Record<string, string> = {
    harness: harnessId,
    selectionSource,
    capability: fact?.capability ?? "supported",
    state: assessment.state,
  };
  if (assessment.state !== "not-applicable") {
    if (assessment.requested !== undefined) details.requested = String(assessment.requested);
    if (assessment.installed !== undefined) details.installed = String(assessment.installed);
  }
  if (fact?.ownership !== undefined) addHookOwnershipDetails(details, fact.ownership);
  return {
    id: `harness-tracking:${harnessId}`,
    tier: required ? "required" : "recommended",
    status: presentation.status,
    label: `${harnessLabel} tracking`,
    message: presentation.message,
    details,
  };
}

function harnessTrackingPresentation(
  assessment: HarnessTrackingAssessment,
  fact: SetupFacts["harnessTracking"][number] | undefined,
  harnessId: CliSetupHarnessId,
  harnessLabel: string,
  required: boolean,
): Pick<CliSetupCheck, "status" | "message"> {
  const unavailableStatus = required ? "missing" : "warning";
  switch (assessment.state) {
    case "not-applicable":
      return {
        status: required ? "ok" : "skipped",
        message: `${harnessLabel} has no Station-managed external tracking artifact.`,
      };
    case "probe-failed":
      return {
        status: unavailableStatus,
        message: fact?.detail ?? `${harnessId} tracking status could not be inspected.`,
      };
    case "disabled":
      return {
        status: unavailableStatus,
        message: `${harnessLabel} tracking is disabled in Station config.`,
      };
    case "artifact-missing-or-drifted":
      return {
        status: unavailableStatus,
        message: fact?.detail ?? `${harnessId} tracking artifacts are absent or drifted.`,
      };
    case "prepared":
      return {
        status: "ok",
        message: `${harnessLabel} Station tracking artifacts are prepared on disk.`,
      };
    default:
      return assertNever(assessment);
  }
}

function addHookOwnershipDetails(
  details: Record<string, string>,
  ownership: ProviderHookArtifactOwnership,
): void {
  details.ownership = ownership.status;
  details.requestedLauncher = ownership.requested.launcher;
  details.requestedRuntimeKind = ownership.requested.runtimeKind;
  details.requestedRuntimeVersion = ownership.requested.version;
  details.requestedBuildIdentity = ownership.requested.buildIdentity;
  if (ownership.status === "same-owner" || ownership.status === "different-owner") {
    details.currentLauncher = ownership.currentLauncher;
  }
  if (ownership.status === "different-owner" && ownership.current !== undefined) {
    details.currentRuntimeKind = ownership.current.runtimeKind;
    details.currentRuntimeVersion = ownership.current.version;
    details.currentBuildIdentity = ownership.current.buildIdentity;
  }
}

function xcodeChecks(facts: SetupFacts): CliSetupCheck[] {
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
  definition: (typeof SETUP_TOOL_DEFINITIONS)[keyof typeof SETUP_TOOL_DEFINITIONS];
  facts: SetupFacts;
  missingMessage: string;
}): CliSetupCheck {
  const dependency = input.facts[input.definition.factKey];
  const details: Record<string, string> = { command: dependency.command };
  if (dependency.version !== undefined) details.version = dependency.version;
  if (dependency.resolvedPath !== undefined) {
    details.resolvedPath = dependency.resolvedPath;
  }
  return {
    id: input.definition.id,
    tier: "required",
    status: dependency.status === "ok" ? "ok" : "missing",
    label: input.definition.availabilityName,
    message:
      dependency.status === "ok"
        ? `${input.definition.availabilityName} is available.`
        : input.missingMessage,
    details,
  };
}

type GitCheckAssessment = Pick<CliSetupCheck, "status" | "message" | "details">;

function gitCheck(facts: SetupFacts): CliSetupCheck {
  const assessment = assessGit(facts.git);
  return {
    id: "git-project",
    tier: "required",
    label: "Git",
    ...assessment,
  };
}

function assessGit(git: SetupFacts["git"]): GitCheckAssessment {
  if (git.status === "missing") {
    return {
      status: "missing",
      message: git.message,
      details: { defaultBranch: git.defaultBranch, reason: git.reason },
    };
  }
  if (git.repository === "absent") {
    return {
      status: "ok",
      message: git.message,
      details: { defaultBranch: git.defaultBranch },
    };
  }
  return {
    status: "ok",
    message: "Git is available; choose projects explicitly in STATION.",
    details: { root: git.root, defaultBranch: git.defaultBranch },
  };
}

function harnessCheck(facts: SetupFacts, harnessSelection: SetupHarnessSelection): CliSetupCheck {
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
    if (selectedDefault.resolvedPath !== undefined)
      details.resolvedPath = selectedDefault.resolvedPath;
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

function configCheck(facts: SetupFacts): CliSetupCheck {
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

function configDiagnosticsChecks(facts: SetupFacts): CliSetupCheck[] {
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
  if (!CliSetupHarnessIdSchema.safeParse(config.defaults.harness).success) {
    return `Config defaults use unsupported harness ${config.defaults.harness}; choose claude, codex, cursor, opencode, or pi for the setup core path.`;
  }
  return undefined;
}

function setupActions(
  operations: readonly SetupOperation[],
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
  configWrite: SetupConfigMutationPlan | undefined,
): CliSetupAction[] {
  const actions: CliSetupAction[] = [];
  for (const operation of operations) {
    switch (operation.kind) {
      case "install-tool": {
        const definition = SETUP_TOOL_DEFINITIONS[operation.tool];
        actions.push(
          installAction(
            `install-${definition.id}`,
            definition.displayName,
            definition.formula,
            facts.brew,
            operation.selected,
          ),
        );
        break;
      }
      case "link-launchers":
        actions.push({
          id: "link-station-launchers",
          kind: "run-command",
          tier: "recommended",
          selected: operation.selected,
          label: "Link STATION launchers",
          message: "Link stn, stn-ingress, and stn-tmux-popup globally for bare terminal commands.",
          command: ["bun", "run", "--cwd", facts.launchers.packageRoot, "station:link"],
        });
        break;
      case "configure-worktrunk-shell":
        if (facts.worktrunkShellIntegration.shell === undefined) break;
        actions.push({
          id: "worktrunk-shell-integration",
          kind: "run-command",
          tier: "recommended",
          selected: operation.selected,
          label: "Install Worktrunk shell integration",
          message:
            "Run wt config shell install after core setup if you want Worktrunk shell helpers.",
          command: [
            facts.worktrunk.resolvedPath ?? facts.worktrunk.command,
            "-y",
            "config",
            "shell",
            "install",
          ],
        });
        break;
      case "configure-tmux-popup":
        actions.push(
          operation.scope === "persisted"
            ? persistedTmuxPopupAction(facts, operation.selected)
            : liveTmuxPopupAction(facts, operation.selected),
        );
        break;
      case "prepare-worktrunk-tracking":
        actions.push({
          id: "worktrunk-hooks",
          kind: "run-command",
          tier: "recommended",
          selected: operation.selected,
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
        break;
      case "prepare-harness-tracking": {
        const harnessLabel =
          facts.harnesses.find((candidate) => candidate.id === operation.harnessId)?.label ??
          operation.harnessId;
        actions.push({
          id: `${operation.harnessId}-hooks`,
          kind: "run-command",
          tier: operation.tier,
          selected: operation.selected,
          label: `Install ${harnessLabel} tracking`,
          message: `Install Station-owned ${harnessLabel} tracking artifacts.`,
          command: harnessHookInstallCommand(facts, operation.harnessId),
          data: { setupRole: "hook", harness: operation.harnessId },
        });
        break;
      }
      case "write-config":
        actions.push(...configWriteActions(configWrite, true));
        break;
      case "activate-observer-config":
        // Observer activation has no representation in the frozen machine action schema.
        break;
      case "install-harness":
      case "install-homebrew":
      case "install-xcode-command-line-tools":
        // Guided and system-only installers are not exposed by read-only machine plans.
        break;
      default:
        assertNever(operation);
    }
  }
  if (configWrite?.operation === "blocked") {
    actions.push(
      ...configWriteActions(configWrite, harnessSelection.requiredHarnessIds.length > 0),
    );
  }
  return actions;
}

function persistedTmuxPopupAction(facts: SetupFacts, selected: boolean): CliSetupAction {
  if (facts.tmuxBinding.status === "conflict") {
    throw new Error("A conflicting tmux popup binding cannot be persisted.");
  }
  return {
    id: "tmux-popup-binding",
    kind: "append-file",
    tier: "recommended",
    selected,
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
  };
}

function liveTmuxPopupAction(facts: SetupFacts, selected: boolean): CliSetupAction {
  if (facts.tmuxBinding.status === "conflict") {
    throw new Error("A conflicting tmux popup binding cannot be loaded.");
  }
  return {
    id: "tmux-live-popup-binding",
    kind: "run-command",
    tier: "recommended",
    selected,
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
  };
}

function harnessHookInstallCommand(facts: SetupFacts, harness: CliSetupHarnessId): string[] {
  const command = [
    setupLauncherExecutable(facts.launchers.station),
    "--config",
    facts.configPath,
    "hooks",
    "install",
    harness,
    "--yes",
  ];
  if (SETUP_HARNESS_DEFINITIONS[harness].providerHook?.supportsHookBin === true) {
    command.push("--hook-bin", setupLauncherExecutable(facts.launchers.ingress));
  }
  return command;
}

function installAction(
  id: string,
  label: string,
  formula: string,
  brew: SetupFacts["brew"],
  selected: boolean,
): CliSetupAction {
  const action: CliSetupAction = {
    id,
    kind: brew.status === "ok" ? "brew-install" : "noop",
    tier: "required",
    selected,
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
  configWrite: SetupConfigMutationPlan | undefined,
  hasSelectedHarness: boolean,
): CliSetupAction[] {
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
  const mkdirAction: CliSetupAction = {
    id: "mkdir-config-dir",
    kind: "mkdir",
    tier: "required",
    selected: true,
    label: "Create config directory",
    message: "Create the parent directory for the STATION config file.",
    path: configWrite.path,
  };
  const writeAction: CliSetupAction = {
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
    const definition = SETUP_TOOL_DEFINITIONS.bun;
    return [
      `Install ${definition.displayName} (brew install ${definition.formula}), then run: stn setup check`,
    ];
  }
  if (facts.git.status === "missing") {
    return [facts.git.message];
  }
  if (facts.diffViewer.status === "missing") {
    const definition = SETUP_TOOL_DEFINITIONS["diff-viewer"];
    return [
      `Install ${definition.displayName} (brew install ${definition.formula}), then run: stn setup check`,
    ];
  }
  return ["Resolve the missing required setup items, then run: stn setup check"];
}

function assertNever(value: never): never {
  throw new Error(`Unsupported semantic setup value: ${JSON.stringify(value)}`);
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(part)) {
    return part;
  }
  return `'${part.replaceAll("'", "'\\''")}'`;
}
