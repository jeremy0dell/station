import type { SetupPlan as CoreSetupPlan } from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import { setupLauncherExecutable } from "../checks/launchers.js";
import type { SetupHarnessSelection } from "../harnessSelection.js";
import type { SetupAction, SetupFacts, SupportedHarnessId } from "../model.js";
import { launcherPathDirectory } from "./projectSetupChecks.js";
import type {
  ProjectSetupView,
  SetupApplyPresentation,
  SetupViewAction,
  SetupViewCheck,
  SetupViewResult,
} from "./setupViewTypes.js";

export function projectSetupResult(input: {
  readonly plan: CoreSetupPlan;
  readonly facts: SetupFacts;
  readonly selection: SetupHarnessSelection;
  readonly checks: readonly SetupViewCheck[];
  readonly actions: readonly SetupViewAction[];
}): SetupViewResult {
  return {
    ...input.plan.result,
    apply: projectApplyPresentation(input),
  };
}

export function overlaySetupActionStatuses(
  view: ProjectSetupView,
  actions: readonly SetupAction[],
): ProjectSetupView {
  // Apply records statuses on its copied compatibility plan; overlay them without projecting human copy through that schema.
  const statuses = new Map(actions.map((action) => [action.id, action.status] as const));
  const updatedActions = view.actions.map((action) => {
    const status = statuses.get(action.id);
    return status === undefined ? action : { ...action, status };
  });
  const failedConfigWrite = updatedActions.some(
    (action) => action.kind === "write-config" && action.status === "failed",
  );
  return {
    ...view,
    actions: updatedActions,
    result: {
      ...view.result,
      apply: failedConfigWrite
        ? { kind: "config-write-failed", message: setupMessageRef("guided.config-write-failed") }
        : view.result.apply,
    },
  };
}

function projectApplyPresentation(input: {
  readonly plan: CoreSetupPlan;
  readonly facts: SetupFacts;
  readonly selection: SetupHarnessSelection;
  readonly checks: readonly SetupViewCheck[];
  readonly actions: readonly SetupViewAction[];
}): SetupApplyPresentation {
  const { facts, plan, selection } = input;
  if (plan.result.readiness.workflowReady) {
    const launcherWarning = input.checks.find(
      (check) => check.id === "station-launchers" && check.status === "warning",
    );
    const pathDirectory = launcherPathDirectory(facts);
    const linkAction = input.actions.find((action) => action.kind === "link-launchers");
    const launcher =
      launcherWarning === undefined
        ? undefined
        : {
            check: launcherWarning,
            stationExecutable: setupLauncherExecutable(facts.launchers.station),
            ...(pathDirectory === undefined ? {} : { pathDirectory }),
            ...(linkAction === undefined
              ? {}
              : {
                  linkAction,
                  linkCommand: [
                    "pnpm",
                    "--dir",
                    facts.launchers.packageRoot,
                    "station:link",
                  ] as const,
                }),
          };
    const stationCommand = launcher?.stationExecutable ?? facts.launchers.station.command;
    return {
      kind: "complete",
      preparedHarnesses: preparedHarnesses(plan, facts),
      showCodexReview: plan.evidence.harnessTracking.some(
        (tracking) => tracking.harnessId === "codex" && tracking.assessment.state === "prepared",
      ),
      ...(launcher === undefined ? {} : { launcherWarning: launcher }),
      nextCommands: [[stationCommand, "doctor"], [stationCommand]],
    };
  }
  if (selection.source === "unresolved") {
    return {
      kind: "blocked",
      title: findCheck(input.checks, "harness").explanation,
      detail: setupMessageRef("recovery.selection-command"),
      commands: [["stn", "--config", facts.configPath, "setup"]],
    };
  }
  if (facts.git.status === "missing") {
    return { kind: "message", message: findCheck(input.checks, "git-project").explanation };
  }
  const missingTracking = plan.evidence.harnessTracking.find(
    (tracking) =>
      selection.requiredHarnessIds.includes(tracking.harnessId) &&
      tracking.assessment.state !== "prepared" &&
      tracking.assessment.state !== "not-applicable",
  );
  if (missingTracking !== undefined) {
    const check = findCheck(input.checks, `harness-tracking:${missingTracking.harnessId}`);
    return {
      kind: "blocked",
      title: check.explanation,
      detail: setupMessageRef("recovery.tracking"),
      commands: [harnessTrackingCommand(facts, missingTracking.harnessId)],
    };
  }
  const missing = input.checks.find(
    (check) => check.tier === "required" && check.status === "missing",
  );
  if (missing === undefined) {
    return {
      kind: "blocked",
      title: setupMessageRef("recovery.core-incomplete"),
      detail: setupMessageRef("recovery.then-run"),
      commands: [["stn", "setup", "check"]],
    };
  }
  return {
    kind: "blocked",
    title: missingRecoveryTitle(missing.id, missing.explanation),
    detail: setupMessageRef("recovery.then-run"),
    commands: recoveryCommands(facts),
  };
}

function preparedHarnesses(
  plan: CoreSetupPlan,
  facts: SetupFacts,
): readonly { readonly id: SupportedHarnessId; readonly label: string }[] {
  return plan.evidence.harnessTracking.flatMap((tracking) => {
    if (tracking.assessment.state !== "prepared") return [];
    const harness = facts.harnesses.find((candidate) => candidate.id === tracking.harnessId);
    return harness === undefined ? [] : [{ id: harness.id, label: harness.label }];
  });
}

function harnessTrackingCommand(
  facts: SetupFacts,
  harnessId: "claude" | "codex" | "cursor" | "opencode" | "pi",
): readonly string[] {
  const command = [
    setupLauncherExecutable(facts.launchers.station),
    "--config",
    facts.configPath,
    "hooks",
    "install",
    harnessId,
    "--yes",
  ];
  if (harnessId === "claude" || harnessId === "codex" || harnessId === "cursor") {
    command.push("--hook-bin", setupLauncherExecutable(facts.launchers.ingress));
  }
  return command;
}

function findCheck(checks: readonly SetupViewCheck[], id: string): SetupViewCheck {
  const check = checks.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`Setup view is missing ${id}.`);
  return check;
}

function missingRecoveryTitle(id: string, fallback: SetupViewCheck["explanation"]) {
  switch (id) {
    case "command-line-tools":
      return setupMessageRef("recovery.command-line-tools");
    case "worktrunk":
      return setupMessageRef("recovery.worktrunk");
    case "tmux":
      return setupMessageRef("recovery.tmux");
    case "bun":
      return setupMessageRef("recovery.bun");
    case "harness":
      return fallback;
    case "diffnav":
      return setupMessageRef("recovery.diffnav");
    case "git-delta":
      return setupMessageRef("recovery.git-delta");
    default:
      return fallback;
  }
}

function recoveryCommands(facts: SetupFacts): readonly (readonly string[])[] {
  if (facts.stateDir.status === "missing") return [];
  if (facts.xcode.status === "missing") return [];
  if (
    facts.worktrunk.status === "missing" ||
    facts.tmux.status === "missing" ||
    facts.bun.status === "missing"
  ) {
    return [["stn", "setup", "check"]];
  }
  if (facts.diffnav.status === "missing" || facts.gitDelta.status === "missing") {
    return [["stn", "setup", "check"]];
  }
  return [["stn", "setup", "check"]];
}
