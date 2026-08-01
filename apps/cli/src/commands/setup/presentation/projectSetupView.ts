import type { SetupPlan as CoreSetupPlan } from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import type { ConfigWritePlan, SetupFacts } from "../model.js";
import { SetupHarnessTrackingFactSchema } from "../model.js";
import { projectSetupActions } from "./projectSetupActions.js";
import {
  projectSetupEnvironmentChecks,
  projectSetupOperationalChecks,
} from "./projectSetupChecks.js";
import { projectSetupConfigChecks } from "./projectSetupConfigChecks.js";
import {
  projectSetupHarnessChecks,
  projectSetupHarnessSelection,
} from "./projectSetupHarnessChecks.js";
import { projectSetupResult } from "./projectSetupResult.js";
import type {
  ProjectSetupView,
  SetupRecoveryInstruction,
  SetupViewCheck,
} from "./setupViewTypes.js";

export type {
  ProjectSetupView,
  SetupDisplayDetail,
  SetupRecoveryInstruction,
  SetupViewAction,
  SetupViewCheck,
} from "./setupViewTypes.js";

export type ProjectSetupViewInput = {
  readonly plan: CoreSetupPlan;
  readonly facts: SetupFacts;
  readonly configWrite?: ConfigWritePlan;
};

export function projectSetupView(input: ProjectSetupViewInput): ProjectSetupView {
  SetupHarnessTrackingFactSchema.array().parse(input.facts.harnessTracking);
  const selection = projectSetupHarnessSelection(input.plan, input.facts);
  const environment = projectSetupEnvironmentChecks(input.facts);
  const harness = projectSetupHarnessChecks(input.plan, input.facts, selection);
  const config = projectSetupConfigChecks(input.facts);
  const operational = projectSetupOperationalChecks(input.facts);
  const checks = [...environment, ...harness, ...config, ...operational];
  assertPresentationCounts(input.plan, checks);
  const actions = projectSetupActions(
    input.plan.operations,
    input.facts,
    selection,
    input.configWrite,
  );
  return {
    generatedAt: input.plan.generatedAt,
    mode: input.plan.mode,
    title: setupMessageRef("setup.heading", { mode: input.plan.mode }),
    selection: {
      source: selection.source,
      summary: setupMessageRef("setup.selection-summary", { source: selection.source }),
      ...(selection.defaultHarness === undefined
        ? {}
        : { defaultHarness: selection.defaultHarness }),
    },
    checks,
    actions,
    result: projectSetupResult({
      plan: input.plan,
      facts: input.facts,
      selection,
      checks,
      actions,
    }),
    configPath: input.facts.configPath,
    recovery: projectRecovery(input.plan, input.facts),
  };
}

function assertPresentationCounts(plan: CoreSetupPlan, checks: readonly SetupViewCheck[]): void {
  const requiredMissing = checks.filter(
    (check) => check.tier === "required" && check.status !== "ok",
  ).length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  if (
    plan.result.readiness.requiredMissing !== requiredMissing ||
    plan.result.warningCount !== warnings
  ) {
    throw new Error(
      `Semantic setup counts do not match the human projection: required ${plan.result.readiness.requiredMissing}/${requiredMissing}, warnings ${plan.result.warningCount}/${warnings}.`,
    );
  }
}

function projectRecovery(
  plan: CoreSetupPlan,
  facts: SetupFacts,
): readonly SetupRecoveryInstruction[] {
  if (plan.result.readiness.requiredMissing === 0) {
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
