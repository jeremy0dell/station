import { dirname } from "node:path";
import type { ProviderHookArtifactOwnership } from "@station/contracts";
import type {
  SetupPlan as CoreSetupPlan,
  HarnessTrackingAssessment,
  SetupOperation,
  SetupOperationOutcome,
} from "@station/setup-core";
import { type SetupMessageRef, setupMessageRef } from "@station/setup-messages";
import { stationUiInstallHint } from "../../../stationWorkspace.js";
import { setupLauncherExecutable } from "../checks/launchers.js";
import { tmuxPopupBindingBlock, tmuxPopupBindingEndMarker } from "../checks/tmuxBinding.js";
import {
  harnessSupportsSetupHooks,
  isSupportedHarnessId,
  relevantHarnessTrackingIds,
  type SetupHarnessSelection,
} from "../harnessSelection.js";
import type {
  ConfigWritePlan,
  SetupAction,
  SetupCheck,
  SetupFacts,
  SetupPlan,
  SupportedHarnessId,
} from "../model.js";
import { SetupHarnessTrackingFactSchema, SetupPlanSchema } from "../model.js";

export type SetupDisplayDetailKind =
  | "executable"
  | "version"
  | "path"
  | "repository-root"
  | "default-branch"
  | "reason"
  | "selection-origin"
  | "available-harnesses"
  | "default-harness"
  | "enabled-harnesses"
  | "unavailable-harnesses"
  | "default-harness-status"
  | "tracking-state"
  | "harness-identity"
  | "tracking-capability"
  | "tracking-requested"
  | "tracking-installed"
  | "tracking-owner-status"
  | "requested-launcher"
  | "requested-runtime-kind"
  | "requested-runtime-version"
  | "requested-build-identity"
  | "current-launcher"
  | "current-runtime-kind"
  | "current-runtime-version"
  | "current-build-identity"
  | "worktrunk-policy"
  | "worktrunk-flag"
  | "missing-subcommands"
  | "station-launcher"
  | "ingress-launcher"
  | "tmux-popup-launcher"
  | "launcher-directory"
  | "resolved-executable"
  | "tmux-binding-launcher"
  | "tmux-live-status"
  | "tmux-binding-key"
  | "shell"
  | "shell-config-path"
  | "configured-harnesses"
  | "project"
  | "worktree-provider"
  | "terminal";

export type SetupDisplayDetail = {
  readonly kind: SetupDisplayDetailKind;
  readonly value: string;
};

export type SetupViewCheck = {
  readonly id: string;
  readonly tier: SetupCheck["tier"];
  readonly status: SetupCheck["status"];
  readonly label: SetupMessageRef;
  readonly explanation: SetupMessageRef;
  readonly details: readonly SetupDisplayDetail[];
};

export type SetupViewActionExecution =
  | {
      readonly kind: "package-install";
      readonly command: readonly string[];
      readonly formula: string;
      readonly installerAvailable: boolean;
    }
  | {
      readonly kind: "command";
      readonly command: readonly string[];
      readonly purpose: "ordinary" | "provider-tracking";
      readonly provider?: "worktrunk" | SupportedHarnessId;
    }
  | { readonly kind: "directory"; readonly path: string }
  | {
      readonly kind: "config-write";
      readonly path: string;
      readonly change: "create" | "update";
      readonly content: string;
      readonly backupPath?: string;
    }
  | {
      readonly kind: "file-append";
      readonly path: string;
      readonly marker?: string;
      readonly endMarker?: string;
      readonly content: string;
    }
  | { readonly kind: "none"; readonly path?: string };

export type SetupViewAction = {
  readonly id: string;
  readonly operationId?: SetupOperation["id"];
  readonly tier: SetupAction["tier"];
  readonly selected: boolean;
  readonly status?: SetupAction["status"];
  readonly label: SetupMessageRef;
  readonly explanation: SetupMessageRef;
  readonly execution: SetupViewActionExecution;
};

export type SetupRecoveryInstruction =
  | { readonly kind: "command"; readonly command: readonly string[] }
  | {
      readonly kind: "instruction";
      readonly message: SetupMessageRef;
      readonly command?: readonly string[];
    };

export type ProjectSetupView = {
  readonly generatedAt: string;
  readonly mode: SetupPlan["mode"];
  readonly title: SetupMessageRef;
  readonly selection: {
    readonly source: SetupHarnessSelection["source"];
    readonly summary: SetupMessageRef;
    readonly defaultHarness?: SupportedHarnessId;
  };
  readonly checks: readonly SetupViewCheck[];
  readonly actions: readonly SetupViewAction[];
  readonly result: CoreSetupPlan["result"];
  readonly configPath: string;
  readonly recovery: readonly SetupRecoveryInstruction[];
  readonly outcomes: readonly SetupOperationOutcome[];
};

export type ProjectSetupViewInput = {
  readonly plan: CoreSetupPlan;
  readonly facts: SetupFacts;
  readonly configWrite?: ConfigWritePlan;
  readonly outcomes?: readonly SetupOperationOutcome[];
};

export function projectSetupView(input: ProjectSetupViewInput): ProjectSetupView {
  const { facts } = input;
  SetupHarnessTrackingFactSchema.array().parse(facts.harnessTracking);
  const harnessSelection = projectHarnessSelection(input.plan, facts);
  const checks = setupChecks(input.plan, facts, harnessSelection);
  const actions = setupActions(input.plan.operations, facts, harnessSelection, input.configWrite);
  const { readiness } = input.plan.result;
  assertCompatibilityCounts(input.plan, checks);
  const summary = {
    launchReady: readiness.launchReady,
    workflowReady: readiness.workflowReady,
    requiredOk: readiness.workflowReady,
    requiredMissing: readiness.requiredMissing,
    warnings: input.plan.result.warningCount,
    selectedActions: actions.filter((action) => action.selected).length,
    selectionSource: harnessSelection.source,
    configPath: facts.configPath,
    ...(harnessSelection.defaultHarness === undefined
      ? {}
      : { selectedHarness: harnessSelection.defaultHarness }),
  };
  const compatibilitySeed = SetupPlanSchema.parse({
    generatedAt: input.plan.generatedAt,
    mode: input.plan.mode,
    checks,
    actions,
    summary,
    nextSteps: nextSteps(readiness.requiredMissing, facts),
  });
  return {
    generatedAt: compatibilitySeed.generatedAt,
    mode: compatibilitySeed.mode,
    title: setupMessageRef("setup.heading", { mode: compatibilitySeed.mode }),
    selection: {
      source: harnessSelection.source,
      summary: setupMessageRef("setup.selection-summary", { source: harnessSelection.source }),
      ...(harnessSelection.defaultHarness === undefined
        ? {}
        : { defaultHarness: harnessSelection.defaultHarness }),
    },
    checks: compatibilitySeed.checks.map((check) => projectViewCheck(check, input)),
    actions: compatibilitySeed.actions.map((action) => projectViewAction(action, input)),
    result: input.plan.result,
    configPath: facts.configPath,
    recovery: projectRecoveryInstructions(readiness.requiredMissing, facts),
    outcomes: input.outcomes ?? [],
  };
}

function assertCompatibilityCounts(plan: CoreSetupPlan, checks: readonly SetupCheck[]): void {
  const requiredMissing = checks.filter(
    (check) => check.tier === "required" && check.status !== "ok",
  ).length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  if (
    plan.result.readiness.requiredMissing !== requiredMissing ||
    plan.result.warningCount !== warnings
  ) {
    throw new Error(
      `Semantic setup counts do not match the CLI compatibility projection: required ${plan.result.readiness.requiredMissing}/${requiredMissing}, warnings ${plan.result.warningCount}/${warnings}.`,
    );
  }
}

function projectHarnessSelection(plan: CoreSetupPlan, facts: SetupFacts): SetupHarnessSelection {
  if (plan.selection.outcome !== "selected") {
    return { selected: [], requiredHarnessIds: [], source: "unresolved" };
  }
  const selected = plan.selection.requiredHarnessIds.flatMap((harnessId) => {
    const harness = facts.harnesses.find(
      (candidate) => candidate.id === harnessId && candidate.status === "ok",
    );
    return harness === undefined ? [] : [harness];
  });
  return {
    selected,
    requiredHarnessIds: plan.selection.requiredHarnessIds,
    source: plan.selection.source,
    defaultHarness: plan.selection.defaultHarness,
  };
}

function setupChecks(
  plan: CoreSetupPlan,
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
): SetupCheck[] {
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
    ...harnessTrackingChecks(plan, facts, harnessSelection),
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
  plan: CoreSetupPlan,
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
): SetupCheck[] {
  const harnessIds = relevantHarnessTrackingIds(facts, harnessSelection);
  const required = new Set(harnessSelection.requiredHarnessIds);
  return harnessIds.map((harnessId) =>
    harnessTrackingCheck(plan, facts, harnessId, required.has(harnessId), harnessSelection.source),
  );
}

function harnessTrackingCheck(
  plan: CoreSetupPlan,
  facts: SetupFacts,
  harnessId: SupportedHarnessId,
  required: boolean,
  selectionSource: SetupHarnessSelection["source"],
): SetupCheck {
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
    capability: harnessSupportsSetupHooks(harnessId) ? "supported" : "unsupported",
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
  harnessId: SupportedHarnessId,
  harnessLabel: string,
  required: boolean,
): Pick<SetupCheck, "status" | "message"> {
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

type GitCheckAssessment = Pick<SetupCheck, "status" | "message" | "details">;

function gitCheck(facts: SetupFacts): SetupCheck {
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
    return "Install one supported agent CLI: claude, codex, cursor agent, opencode, or pi.";
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
  operations: readonly SetupOperation[],
  facts: SetupFacts,
  harnessSelection: SetupHarnessSelection,
  configWrite: ConfigWritePlan | undefined,
): SetupAction[] {
  const actions: SetupAction[] = [];
  for (const operation of operations) {
    switch (operation.kind) {
      case "install-tool": {
        const presentation = installToolPresentation(operation.tool);
        actions.push(
          installAction(presentation.id, presentation.label, presentation.formula, facts.brew),
        );
        break;
      }
      case "link-launchers":
        actions.push({
          id: "link-station-launchers",
          kind: "run-command",
          tier: "recommended",
          selected: false,
          label: "Link STATION launchers",
          message: "Link stn, stn-ingress, and stn-tmux-popup globally for bare terminal commands.",
          command: ["pnpm", "--dir", facts.launchers.packageRoot, "station:link"],
        });
        break;
      case "configure-worktrunk-shell":
        if (facts.worktrunkShellIntegration.shell === undefined) break;
        actions.push({
          id: "worktrunk-shell-integration",
          kind: "run-command",
          tier: "recommended",
          selected: false,
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
            ? persistedTmuxPopupAction(facts)
            : liveTmuxPopupAction(facts),
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
          selected: true,
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
        // Activation is orchestration-only until the compatibility action contract is retired.
        break;
      case "install-harness":
      case "install-homebrew":
      case "install-xcode-command-line-tools":
        // Guided and system-only installers are projected by their existing compatibility helpers.
        break;
    }
  }
  if (configWrite?.operation === "blocked") {
    actions.push(...configWriteActions(configWrite, harnessSelection.selected.length > 0));
  }
  return actions;
}

function installToolPresentation(tool: Extract<SetupOperation, { kind: "install-tool" }>["tool"]): {
  id: string;
  label: string;
  formula: string;
} {
  switch (tool) {
    case "worktrunk":
      return { id: "install-worktrunk", label: "Worktrunk", formula: "worktrunk" };
    case "tmux":
      return { id: "install-tmux", label: "tmux", formula: "tmux" };
    case "bun":
      return { id: "install-bun", label: "Bun", formula: "bun" };
    case "diffnav":
      return { id: "install-diffnav", label: "diffnav", formula: "diffnav" };
    case "git-delta":
      return { id: "install-git-delta", label: "git-delta", formula: "git-delta" };
    default:
      throw new Error(`Unsupported semantic setup tool: ${tool}`);
  }
}

function persistedTmuxPopupAction(facts: SetupFacts): SetupAction {
  if (facts.tmuxBinding.status === "conflict") {
    throw new Error("A conflicting tmux popup binding cannot be persisted.");
  }
  return {
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
  };
}

function liveTmuxPopupAction(facts: SetupFacts): SetupAction {
  if (facts.tmuxBinding.status === "conflict") {
    throw new Error("A conflicting tmux popup binding cannot be loaded.");
  }
  return {
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
  };
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
  if (facts.git.status === "missing") {
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

function projectViewCheck(check: SetupCheck, input: ProjectSetupViewInput): SetupViewCheck {
  return {
    id: check.id,
    tier: check.tier,
    status: check.status,
    label: projectCheckLabel(check, input.facts),
    explanation: projectCheckExplanation(check, input),
    details: projectDisplayDetails(check.details),
  };
}

function projectCheckLabel(check: SetupCheck, facts: SetupFacts): SetupMessageRef {
  switch (check.id) {
    case "state-dir":
      return setupMessageRef("label.state-directory");
    case "observer-socket-evidence":
      return setupMessageRef("label.socket-evidence");
    case "worktrunk":
      return setupMessageRef("label.worktrunk");
    case "tmux":
      return setupMessageRef("label.tmux");
    case "bun":
      return setupMessageRef("label.bun");
    case "git-project":
      return setupMessageRef("label.git");
    case "harness":
      return setupMessageRef("label.agent-cli");
    case "config":
      return setupMessageRef("label.config");
    case "station-launchers":
      return setupMessageRef("label.launchers");
    case "station-ui":
      return setupMessageRef("label.station-ui");
    case "worktrunk-shell-integration":
      return setupMessageRef("label.worktrunk-shell");
    case "tmux-popup-binding":
      return setupMessageRef("label.tmux-popup");
    case "worktrunk-hooks":
      return setupMessageRef("label.worktrunk-hooks");
    case "diffnav":
      return setupMessageRef("label.diffnav");
    case "git-delta":
      return setupMessageRef("label.git-delta");
    case "doctor":
      return setupMessageRef("label.doctor");
    case "config-diagnostics":
      return setupMessageRef("label.config-diagnostics");
    case "command-line-tools":
      return setupMessageRef("label.command-line-tools");
    default: {
      if (check.id.startsWith("harness-tracking:")) {
        const harnessId = check.id.slice("harness-tracking:".length);
        const harness = facts.harnesses.find((candidate) => candidate.id === harnessId);
        return setupMessageRef("label.harness-tracking", {
          harness: harness?.label ?? harnessId,
        });
      }
      return setupMessageRef("check.evidence", { message: check.label });
    }
  }
}

function projectCheckExplanation(check: SetupCheck, input: ProjectSetupViewInput): SetupMessageRef {
  const { facts, plan } = input;
  switch (check.id) {
    case "state-dir":
      return facts.stateDir.status === "ok"
        ? setupMessageRef("check.state-directory-ready")
        : setupMessageRef("check.evidence", { message: facts.stateDir.message });
    case "observer-socket-evidence":
      return check.status === "ok"
        ? setupMessageRef("check.socket-evidence-ready")
        : setupMessageRef("check.socket-evidence-missing", {
            command: facts.socketEvidence.command,
          });
    case "worktrunk":
    case "tmux":
    case "bun":
      return check.status === "ok"
        ? setupMessageRef("check.available", { label: check.label })
        : setupMessageRef("check.evidence", { message: check.message });
    case "git-project":
      return check.status === "ok"
        ? setupMessageRef("check.git-repository-ready")
        : setupMessageRef("check.evidence", { message: check.message });
    case "harness":
      return projectHarnessExplanation(plan, facts);
    case "config":
      return projectConfigExplanation(check, facts);
    case "config-diagnostics": {
      const diagnostics = facts.config.status === "valid" ? (facts.config.diagnostics ?? []) : [];
      return setupMessageRef("check.config-diagnostics", {
        count: diagnostics.length,
        messages: diagnostics.map((diagnostic) => diagnostic.message).join("; "),
      });
    }
    case "station-launchers":
      return projectLauncherExplanation(check, facts);
    case "station-ui":
      if (facts.stationUi.status === "installed") return setupMessageRef("check.station-ui-ready");
      if (facts.stationUi.status === "missing") {
        return setupMessageRef("check.station-ui-missing", { installHint: stationUiInstallHint });
      }
      return setupMessageRef("check.station-ui-skipped");
    case "worktrunk-shell-integration":
      return setupMessageRef("check.evidence", {
        message: facts.worktrunkShellIntegration.message,
      });
    case "tmux-popup-binding":
      return projectTmuxPopupExplanation(check, facts);
    case "worktrunk-hooks":
      if (facts.worktrunk.status !== "ok") return setupMessageRef("check.worktrunk-hooks-skipped");
      if (facts.config.status !== "valid") {
        return setupMessageRef("check.worktrunk-hooks-recommended");
      }
      if (facts.worktrunkAutomation.status !== "skipped") {
        return setupMessageRef("check.evidence", { message: facts.worktrunkAutomation.message });
      }
      return setupMessageRef("check.worktrunk-hooks-defaults");
    case "diffnav":
      if (facts.diffnav.status === "ok") return setupMessageRef("check.diffnav-ready");
      return facts.diffnav.message === undefined
        ? setupMessageRef("check.diffnav-missing")
        : setupMessageRef("check.evidence", { message: facts.diffnav.message });
    case "git-delta":
      if (facts.gitDelta.status === "ok") return setupMessageRef("check.git-delta-ready");
      return facts.gitDelta.message === undefined
        ? setupMessageRef("check.git-delta-missing")
        : setupMessageRef("check.evidence", { message: facts.gitDelta.message });
    case "doctor":
      return setupMessageRef("check.doctor-reminder");
    case "command-line-tools":
      return setupMessageRef("check.evidence", { message: check.message });
    default:
      return check.id.startsWith("harness-tracking:")
        ? projectTrackingExplanation(check, facts)
        : setupMessageRef("check.evidence", { message: check.message });
  }
}

function projectHarnessExplanation(plan: CoreSetupPlan, facts: SetupFacts): SetupMessageRef {
  if (plan.selection.outcome !== "selected") {
    const available = facts.harnesses.filter((harness) => harness.status === "ok");
    if (available.length > 1) {
      return setupMessageRef("check.harness-selection-ambiguous", {
        harnesses: available.map((harness) => harness.id).join(", "),
      });
    }
    return available.length === 0
      ? setupMessageRef("check.harness-none-available")
      : setupMessageRef("check.harness-selection-unresolved");
  }
  const unavailable = plan.selection.requiredHarnessIds.filter(
    (harnessId) =>
      !facts.harnesses.some((harness) => harness.id === harnessId && harness.status === "ok"),
  );
  if (unavailable.length > 0) {
    return plan.selection.source === "configured"
      ? setupMessageRef("check.harness-configured-unavailable", {
          harnessId: unavailable[0] ?? "unknown",
        })
      : setupMessageRef("check.harness-explicit-unavailable", {
          harnessIds: unavailable.join(", "),
        });
  }
  const labels = plan.selection.requiredHarnessIds.map(
    (harnessId) => facts.harnesses.find((harness) => harness.id === harnessId)?.label ?? harnessId,
  );
  switch (plan.selection.source) {
    case "inferred":
      return setupMessageRef("check.harness-inferred", { harness: labels[0] ?? "Agent" });
    case "explicit":
      return setupMessageRef("check.harness-explicit", { harnesses: labels.join(", ") });
    case "configured":
      return setupMessageRef("check.harness-configured", { harness: labels[0] ?? "Agent" });
  }
}

function projectConfigExplanation(check: SetupCheck, facts: SetupFacts): SetupMessageRef {
  if (facts.config.status !== "valid") {
    return setupMessageRef("check.evidence", { message: check.message });
  }
  if (facts.config.defaults.worktreeProvider !== "worktrunk") {
    return setupMessageRef("check.config-worktree-provider", {
      provider: facts.config.defaults.worktreeProvider,
    });
  }
  if (facts.config.defaults.terminal !== "tmux") {
    return setupMessageRef("check.config-terminal", { terminal: facts.config.defaults.terminal });
  }
  if (!isSupportedHarnessId(facts.config.defaults.harness)) {
    return setupMessageRef("check.config-harness", { harness: facts.config.defaults.harness });
  }
  return setupMessageRef("check.config-core-ready");
}

function projectLauncherExplanation(check: SetupCheck, facts: SetupFacts): SetupMessageRef {
  if (check.status === "ok") return setupMessageRef("check.launchers-ready");
  const entries = [
    ["stn", facts.launchers.station],
    ["stn-ingress", facts.launchers.ingress],
    ["stn-tmux-popup", facts.launchers.tmuxPopup],
  ] as const;
  const missing = entries.flatMap((entry) => (entry[1].status === "missing" ? [entry[0]] : []));
  if (missing.length > 0) {
    return setupMessageRef("check.launchers-missing", { launchers: missing.join(", ") });
  }
  const checkout = entries.flatMap((entry) => (entry[1].source === "checkout" ? [entry[0]] : []));
  const installed = entries.flatMap((entry) => (entry[1].source === "installed" ? [entry[0]] : []));
  if (checkout.length > 0 && installed.length > 0) {
    return setupMessageRef("check.launchers-mixed-path", {
      launchers: [...checkout, ...installed].join(", "),
    });
  }
  return checkout.length > 0
    ? setupMessageRef("check.launchers-checkout-path", { launchers: checkout.join(", ") })
    : setupMessageRef("check.launchers-installed-path", { launchers: installed.join(", ") });
}

function projectTmuxPopupExplanation(check: SetupCheck, facts: SetupFacts): SetupMessageRef {
  if (facts.tmuxBinding.status === "conflict") {
    return setupMessageRef("check.evidence", { message: check.message });
  }
  if (facts.tmux.status !== "ok") return setupMessageRef("check.tmux-popup-skipped");
  if (facts.launchers.tmuxPopup.status !== "ok") {
    return setupMessageRef("check.tmux-popup-launcher-missing");
  }
  if (facts.tmuxBinding.status === "missing") {
    return setupMessageRef("check.evidence", { message: facts.tmuxBinding.message });
  }
  if (facts.tmuxBinding.insideTmux && facts.tmuxBinding.liveStatus === "missing") {
    return setupMessageRef("check.tmux-popup-persisted-missing");
  }
  if (facts.tmuxBinding.insideTmux && facts.tmuxBinding.liveStatus === "unknown") {
    return setupMessageRef("check.tmux-popup-persisted-unknown");
  }
  return setupMessageRef("check.tmux-popup-ready");
}

function projectTrackingExplanation(check: SetupCheck, facts: SetupFacts): SetupMessageRef {
  const harnessId = check.id.slice("harness-tracking:".length);
  const harness = facts.harnesses.find((candidate) => candidate.id === harnessId);
  const label = harness?.label ?? harnessId;
  const fact = facts.harnessTracking.find((candidate) => candidate.harnessId === harnessId);
  switch (check.details?.state) {
    case "not-applicable":
      return setupMessageRef("check.tracking-not-applicable", { harness: label });
    case "probe-failed":
      return fact?.detail === undefined
        ? setupMessageRef("check.tracking-probe-failed", { harnessId })
        : setupMessageRef("check.evidence", { message: fact.detail });
    case "disabled":
      return setupMessageRef("check.tracking-disabled", { harness: label });
    case "artifact-missing-or-drifted":
      return fact?.detail === undefined
        ? setupMessageRef("check.tracking-missing", { harnessId })
        : setupMessageRef("check.evidence", { message: fact.detail });
    case "prepared":
      return setupMessageRef("check.tracking-prepared", { harness: label });
    default:
      return setupMessageRef("check.evidence", { message: check.message });
  }
}

function projectDisplayDetails(details: SetupCheck["details"]): SetupDisplayDetail[] {
  if (details === undefined) return [];
  return Object.entries(details).map(([key, value]) => ({
    kind: displayDetailKind(key),
    value,
  }));
}

function displayDetailKind(key: string): SetupDisplayDetailKind {
  switch (key) {
    case "command":
      return "executable";
    case "version":
      return "version";
    case "path":
      return "path";
    case "root":
      return "repository-root";
    case "defaultBranch":
      return "default-branch";
    case "reason":
      return "reason";
    case "selectionSource":
      return "selection-origin";
    case "available":
      return "available-harnesses";
    case "default":
      return "default-harness";
    case "enabled":
      return "enabled-harnesses";
    case "unavailable":
      return "unavailable-harnesses";
    case "defaultStatus":
      return "default-harness-status";
    case "state":
      return "tracking-state";
    case "harness":
      return "harness-identity";
    case "capability":
      return "tracking-capability";
    case "requested":
      return "tracking-requested";
    case "installed":
      return "tracking-installed";
    case "ownership":
      return "tracking-owner-status";
    case "requestedLauncher":
      return "requested-launcher";
    case "requestedRuntimeKind":
      return "requested-runtime-kind";
    case "requestedRuntimeVersion":
      return "requested-runtime-version";
    case "requestedBuildIdentity":
      return "requested-build-identity";
    case "currentLauncher":
      return "current-launcher";
    case "currentRuntimeKind":
      return "current-runtime-kind";
    case "currentRuntimeVersion":
      return "current-runtime-version";
    case "currentBuildIdentity":
      return "current-build-identity";
    case "automationMode":
      return "worktrunk-policy";
    case "flag":
      return "worktrunk-flag";
    case "missingSubcommands":
      return "missing-subcommands";
    case "station":
      return "station-launcher";
    case "ingress":
      return "ingress-launcher";
    case "tmuxPopup":
      return "tmux-popup-launcher";
    case "pathDirectory":
      return "launcher-directory";
    case "resolvedPath":
      return "resolved-executable";
    case "launcherCommand":
      return "tmux-binding-launcher";
    case "liveStatus":
      return "tmux-live-status";
    case "bindingKey":
      return "tmux-binding-key";
    case "shell":
      return "shell";
    case "rcPath":
      return "shell-config-path";
    case "configuredHarnesses":
      return "configured-harnesses";
    case "project":
      return "project";
    case "worktreeProvider":
      return "worktree-provider";
    case "terminal":
      return "terminal";
    default:
      throw new Error(`Unsupported setup display detail: ${key}`);
  }
}

function projectViewAction(action: SetupAction, input: ProjectSetupViewInput): SetupViewAction {
  const operation = input.plan.operations.find((candidate) =>
    actionMatchesOperation(action, candidate),
  );
  return {
    id: action.id,
    ...(operation === undefined ? {} : { operationId: operation.id }),
    tier: action.tier,
    selected: action.selected,
    ...(action.status === undefined ? {} : { status: action.status }),
    label: projectActionLabel(action, input.facts),
    explanation: projectActionExplanation(action, input.facts),
    execution: projectActionExecution(action),
  };
}

function actionMatchesOperation(action: SetupAction, operation: SetupOperation): boolean {
  switch (operation.kind) {
    case "install-tool":
      return action.id === `install-${operation.tool}`;
    case "link-launchers":
      return action.id === "link-station-launchers";
    case "configure-worktrunk-shell":
      return action.id === "worktrunk-shell-integration";
    case "configure-tmux-popup":
      return (
        action.id ===
        (operation.scope === "persisted" ? "tmux-popup-binding" : "tmux-live-popup-binding")
      );
    case "prepare-worktrunk-tracking":
      return action.id === "worktrunk-hooks";
    case "prepare-harness-tracking":
      return action.id === `${operation.harnessId}-hooks`;
    case "write-config":
      return (
        action.id === "mkdir-config-dir" ||
        action.id === "write-config" ||
        action.id === "update-config"
      );
    case "activate-observer-config":
    case "install-harness":
    case "install-homebrew":
    case "install-xcode-command-line-tools":
      return false;
  }
}

function projectActionLabel(action: SetupAction, facts: SetupFacts): SetupMessageRef {
  const installLabel = installActionLabel(action.id);
  if (installLabel !== undefined)
    return setupMessageRef("action.install-label", { label: installLabel });
  switch (action.id) {
    case "link-station-launchers":
      return setupMessageRef("action.link-launchers-label");
    case "worktrunk-shell-integration":
      return setupMessageRef("action.worktrunk-shell-label");
    case "worktrunk-hooks":
      return setupMessageRef("action.worktrunk-hooks-label");
    case "tmux-popup-binding":
      return setupMessageRef("action.tmux-persist-label");
    case "tmux-live-popup-binding":
      return setupMessageRef("action.tmux-live-label");
    case "mkdir-config-dir":
      return setupMessageRef("action.config-directory-label");
    case "write-config":
      return setupMessageRef("action.config-create-label");
    case "update-config":
      return setupMessageRef("action.config-update-label");
    case "config-blocked":
      return setupMessageRef("action.config-blocked-label");
    default: {
      if (action.id.endsWith("-hooks")) {
        const harnessId = action.id.slice(0, -"-hooks".length);
        const harness = facts.harnesses.find((candidate) => candidate.id === harnessId);
        return setupMessageRef("action.harness-tracking-label", {
          harness: harness?.label ?? harnessId,
        });
      }
      return setupMessageRef("check.evidence", { message: action.label });
    }
  }
}

function projectActionExplanation(action: SetupAction, facts: SetupFacts): SetupMessageRef {
  const installLabel = installActionLabel(action.id);
  if (installLabel !== undefined) {
    const formula = action.data?.formula ?? installLabel.toLowerCase();
    return action.kind === "brew-install"
      ? setupMessageRef("action.install-homebrew", { label: installLabel })
      : setupMessageRef("action.install-manually", { label: installLabel, formula });
  }
  switch (action.id) {
    case "link-station-launchers":
      return setupMessageRef("action.link-launchers-message");
    case "worktrunk-shell-integration":
      return setupMessageRef("action.worktrunk-shell-message");
    case "worktrunk-hooks":
      return setupMessageRef("action.worktrunk-hooks-message");
    case "tmux-popup-binding":
      return setupMessageRef("action.tmux-persist-message", {
        key: facts.tmuxBinding.status === "conflict" ? "Space" : facts.tmuxBinding.bindingKey,
      });
    case "tmux-live-popup-binding":
      return setupMessageRef("action.tmux-live-message", {
        key: facts.tmuxBinding.status === "conflict" ? "Space" : facts.tmuxBinding.bindingKey,
      });
    case "mkdir-config-dir":
      return setupMessageRef("action.config-directory-message");
    case "write-config":
      return setupMessageRef("action.config-create-message");
    case "update-config":
      return setupMessageRef("action.config-update-message");
    case "config-blocked":
      return setupMessageRef("check.evidence", { message: action.message });
    default: {
      if (action.id.endsWith("-hooks")) {
        const harnessId = action.id.slice(0, -"-hooks".length);
        const harness = facts.harnesses.find((candidate) => candidate.id === harnessId);
        return setupMessageRef("action.harness-tracking-message", {
          harness: harness?.label ?? harnessId,
        });
      }
      return setupMessageRef("check.evidence", { message: action.message });
    }
  }
}

function installActionLabel(actionId: string): string | undefined {
  switch (actionId) {
    case "install-worktrunk":
      return "Worktrunk";
    case "install-tmux":
      return "tmux";
    case "install-bun":
      return "Bun";
    case "install-diffnav":
      return "diffnav";
    case "install-git-delta":
      return "git-delta";
    default:
      return undefined;
  }
}

function projectActionExecution(action: SetupAction): SetupViewActionExecution {
  if (action.data?.formula !== undefined) {
    if (action.command === undefined) {
      throw new Error(`${action.id} package install presentation is incomplete.`);
    }
    return {
      kind: "package-install",
      command: action.command,
      formula: action.data.formula,
      installerAvailable: action.kind === "brew-install",
    };
  }
  switch (action.kind) {
    case "brew-install":
      throw new Error(`${action.id} package install formula is missing.`);
    case "run-command": {
      if (action.command === undefined) {
        throw new Error(`${action.id} command presentation is incomplete.`);
      }
      if (action.data?.setupRole !== "hook") {
        return { kind: "command", command: action.command, purpose: "ordinary" };
      }
      const harnessId = action.data.harness;
      if (harnessId === undefined) {
        return {
          kind: "command",
          command: action.command,
          purpose: "provider-tracking",
          provider: "worktrunk",
        };
      }
      if (!isSupportedHarnessId(harnessId)) {
        throw new Error(`Unsupported setup tracking provider: ${harnessId}`);
      }
      return {
        kind: "command",
        command: action.command,
        purpose: "provider-tracking",
        provider: harnessId,
      };
    }
    case "mkdir":
      if (action.path === undefined) throw new Error(`${action.id} directory path is missing.`);
      return { kind: "directory", path: action.path };
    case "write-config": {
      const change = action.data?.operation;
      const content = action.data?.content;
      if (
        action.path === undefined ||
        (change !== "create" && change !== "update") ||
        content === undefined
      ) {
        throw new Error(`${action.id} config presentation is incomplete.`);
      }
      return {
        kind: "config-write",
        path: action.path,
        change,
        content,
        ...(action.data?.backupPath === undefined ? {} : { backupPath: action.data.backupPath }),
      };
    }
    case "append-file": {
      if (action.path === undefined || action.data?.appendedText === undefined) {
        throw new Error(`${action.id} file presentation is incomplete.`);
      }
      return {
        kind: "file-append",
        path: action.path,
        content: action.data.appendedText,
        ...(action.data.marker === undefined ? {} : { marker: action.data.marker }),
        ...(action.data.endMarker === undefined ? {} : { endMarker: action.data.endMarker }),
      };
    }
    case "noop":
      return action.path === undefined ? { kind: "none" } : { kind: "none", path: action.path };
  }
}

function projectRecoveryInstructions(
  requiredMissing: number,
  facts: SetupFacts,
): SetupRecoveryInstruction[] {
  if (requiredMissing === 0) {
    return [
      { kind: "command", command: [facts.launchers.station.command, "doctor"] },
      { kind: "command", command: [facts.launchers.station.command] },
    ];
  }
  if (facts.stateDir.status === "missing") {
    return [
      {
        kind: "instruction",
        message: setupMessageRef("check.evidence", { message: facts.stateDir.message }),
      },
    ];
  }
  if (facts.xcode.status === "missing") {
    return [
      {
        kind: "instruction",
        message: setupMessageRef("check.evidence", { message: facts.xcode.message }),
      },
    ];
  }
  if (facts.worktrunk.status === "missing") {
    return [
      {
        kind: "instruction",
        message: setupMessageRef("next.install-worktrunk"),
        command: ["stn", "setup", "check"],
      },
    ];
  }
  if (facts.tmux.status === "missing") {
    return [
      {
        kind: "instruction",
        message: setupMessageRef("next.install-tmux"),
        command: ["stn", "setup", "check"],
      },
    ];
  }
  if (facts.bun.status === "missing") {
    return [
      {
        kind: "instruction",
        message: setupMessageRef("next.install-bun"),
        command: ["stn", "setup", "check"],
      },
    ];
  }
  if (facts.git.status === "missing") {
    return [
      {
        kind: "instruction",
        message: setupMessageRef("check.evidence", { message: facts.git.message }),
      },
    ];
  }
  if (facts.diffnav.status === "missing" || facts.gitDelta.status === "missing") {
    return [
      {
        kind: "instruction",
        message: setupMessageRef("next.install-diff-tools"),
        command: ["stn", "setup", "check"],
      },
    ];
  }
  return [
    {
      kind: "instruction",
      message: setupMessageRef("next.resolve-required"),
      command: ["stn", "setup", "check"],
    },
  ];
}
