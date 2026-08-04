import type {
  SetupPlan,
  SetupSessionOperationOutcome,
  SupportedHarnessId,
} from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import type { SetupFacts } from "../adapters/inspectionTypes.js";
import { setupLauncherExecutable } from "../checks/launchers.js";
import { launcherPathDirectory } from "./projectSetupChecks.js";
import type {
  ProjectSetupView,
  SetupApplyPresentation,
  SetupPresentationHarnessSelection,
  SetupViewAction,
  SetupViewCheck,
  SetupViewResult,
} from "./setupViewTypes.js";

export function projectSetupResult(input: {
  readonly plan: SetupPlan;
  readonly facts: SetupFacts;
  readonly selection: SetupPresentationHarnessSelection;
  readonly checks: readonly SetupViewCheck[];
  readonly actions: readonly SetupViewAction[];
}): SetupViewResult {
  return {
    ...input.plan.result,
    apply: projectApplyPresentation(input),
  };
}

export function overlaySetupOperationOutcomes(input: {
  readonly view: ProjectSetupView;
  readonly outcomes: readonly SetupSessionOperationOutcome[];
}): ProjectSetupView {
  const statuses = new Map(
    input.outcomes.map((outcome) => [outcome.operationId, outcome.status] as const),
  );
  const updatedActions = input.view.actions.map((action) => {
    const status = action.operationId === undefined ? undefined : statuses.get(action.operationId);
    return status === undefined ? action : { ...action, status };
  });
  return withUpdatedActions({ view: input.view, actions: updatedActions });
}

function withUpdatedActions(input: {
  readonly view: ProjectSetupView;
  readonly actions: readonly SetupViewAction[];
}): ProjectSetupView {
  const { view, actions } = input;
  const failedConfigWrite = actions.some(
    (action) => action.kind === "write-config" && action.status === "failed",
  );
  return {
    ...view,
    actions,
    result: {
      ...view.result,
      apply: failedConfigWrite
        ? { kind: "config-write-failed", message: setupMessageRef("guided.config-write-failed") }
        : view.result.apply,
    },
  };
}

function projectApplyPresentation(input: {
  readonly plan: SetupPlan;
  readonly facts: SetupFacts;
  readonly selection: SetupPresentationHarnessSelection;
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
      preparedHarnesses: preparedHarnesses({ plan, facts }),
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
      title: findCheck({ checks: input.checks, id: "harness" }).explanation,
      detail: setupMessageRef("recovery.selection-command"),
      commands: [["stn", "--config", facts.configPath, "setup"]],
    };
  }
  if (facts.git.status === "missing") {
    return {
      kind: "message",
      message: findCheck({ checks: input.checks, id: "git-project" }).explanation,
    };
  }
  const missingTracking = plan.evidence.harnessTracking.find(
    (tracking) =>
      selection.requiredHarnessIds.includes(tracking.harnessId) &&
      tracking.assessment.state !== "prepared" &&
      tracking.assessment.state !== "not-applicable",
  );
  if (missingTracking !== undefined) {
    const check = findCheck({
      checks: input.checks,
      id: `harness-tracking:${missingTracking.harnessId}`,
    });
    return {
      kind: "blocked",
      title: check.explanation,
      detail: setupMessageRef("recovery.tracking"),
      commands: [harnessTrackingCommand({ facts, harnessId: missingTracking.harnessId })],
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
    title: missingRecoveryTitle({ id: missing.id, fallback: missing.explanation }),
    detail: setupMessageRef("recovery.then-run"),
    commands: recoveryCommands(facts),
  };
}

function preparedHarnesses(input: {
  readonly plan: SetupPlan;
  readonly facts: SetupFacts;
}): readonly { readonly id: SupportedHarnessId; readonly label: string }[] {
  const { plan, facts } = input;
  return plan.evidence.harnessTracking.flatMap((tracking) => {
    if (tracking.assessment.state !== "prepared") return [];
    const harness = facts.harnesses.find((candidate) => candidate.id === tracking.harnessId);
    return harness === undefined ? [] : [{ id: harness.id, label: harness.label }];
  });
}

function harnessTrackingCommand(input: {
  readonly facts: SetupFacts;
  readonly harnessId: "claude" | "codex" | "cursor" | "opencode" | "pi";
}): readonly string[] {
  const { facts, harnessId } = input;
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

function findCheck(input: {
  readonly checks: readonly SetupViewCheck[];
  readonly id: string;
}): SetupViewCheck {
  const { checks, id } = input;
  const check = checks.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`Setup view is missing ${id}.`);
  return check;
}

function missingRecoveryTitle(input: {
  readonly id: string;
  readonly fallback: SetupViewCheck["explanation"];
}) {
  if (input.id === "command-line-tools") return setupMessageRef("recovery.command-line-tools");
  if (input.id === "worktrunk") return setupMessageRef("recovery.worktrunk");
  if (input.id === "tmux") return setupMessageRef("recovery.tmux");
  if (input.id === "bun") return setupMessageRef("recovery.bun");
  if (input.id === "diff-viewer") return setupMessageRef("recovery.diff-viewer");
  return input.fallback;
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
  if (facts.diffViewer.status === "missing") {
    return [["stn", "setup", "check"]];
  }
  return [["stn", "setup", "check"]];
}
