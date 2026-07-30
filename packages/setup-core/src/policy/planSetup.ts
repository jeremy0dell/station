import type {
  HarnessSelectionResolution,
  SetupPlanningFacts,
  SetupToolId,
} from "../model/facts.js";
import type { SetupPlanningIntent } from "../model/intent.js";
import type { SetupIssue } from "../model/issues.js";
import type { SetupOperation } from "../model/operations.js";
import type { SetupPlan } from "../model/plan.js";
import { deriveSetupResult } from "./deriveSetupResult.js";
import { resolveHarnessSelection } from "./resolveHarnessSelection.js";

/**
 * POLICY
 *
 * Derives semantic setup issues and operations from normalized evidence and intent without rendering or performing effects.
 */
export function planSetup(facts: SetupPlanningFacts, intent: SetupPlanningIntent): SetupPlan {
  const selection = resolveHarnessSelection(facts.harnessSelection, intent.harnessSelection);
  const issues = deriveIssues(facts, selection);
  const operations = deriveOperations(facts, intent, selection, issues);
  return {
    generatedAt: facts.generatedAt,
    mode: intent.mode,
    selection,
    evidence: facts,
    issues,
    operations,
    result: deriveSetupResult({ evidence: facts, issues, operations }),
  };
}

function deriveIssues(
  facts: SetupPlanningFacts,
  selection: HarnessSelectionResolution,
): SetupIssue[] {
  const issues: SetupIssue[] = [];
  if (!facts.stateDirectoryWritable) {
    issues.push({ code: "state-directory-unwritable", tier: "required" });
  }
  if (!facts.socketEvidenceAvailable) {
    issues.push({ code: "socket-evidence-unavailable", tier: "recommended" });
  }
  if (!facts.compiled && facts.xcodeTools === "missing") {
    issues.push({ code: "xcode-tools-missing", tier: "required" });
  }
  for (const tool of facts.tools) {
    if (!tool.available && toolApplies(tool.id, facts.compiled)) {
      issues.push({ code: "tool-missing", tier: "required", tool: tool.id });
    }
  }
  if (facts.git.state === "unusable") {
    issues.push({ code: "git-unavailable", tier: "required", reason: facts.git.reason });
  }
  addHarnessSelectionIssues(issues, facts, selection);

  if (facts.config.write === "blocked") {
    issues.push({ code: "config-unready", tier: "required", state: "write-blocked" });
  } else if (facts.config.state !== "valid") {
    issues.push({
      code: "config-unready",
      tier: "required",
      state: facts.config.state,
    });
  }
  for (const diagnostic of facts.config.diagnostics) {
    issues.push({
      code: "config-diagnostic",
      tier: "recommended",
      diagnosticCode: diagnostic.code,
      severity: diagnostic.severity,
    });
  }
  addLauncherIssues(issues, facts);
  if (!facts.compiled && facts.runtimeUi === "missing") {
    issues.push({ code: "station-ui-missing", tier: "required" });
  }
  if (facts.worktrunkAutomation !== "ready") {
    issues.push({
      code: "worktrunk-automation-unready",
      tier: "recommended",
      state: facts.worktrunkAutomation,
    });
  }
  if (facts.worktrunkShell === "missing") {
    issues.push({ code: "worktrunk-shell-missing", tier: "recommended" });
  }
  if (facts.tmuxPopup.persisted !== "ready") {
    issues.push({
      code: "tmux-popup-unready",
      tier: "recommended",
      scope: "persisted",
      state: facts.tmuxPopup.persisted,
    });
  }
  if (facts.tmuxPopup.live === "missing" || facts.tmuxPopup.live === "unknown") {
    issues.push({
      code: "tmux-popup-unready",
      tier: "recommended",
      scope: "live",
      state: facts.tmuxPopup.live,
    });
  }
  if (facts.worktrunkHooks === "missing") {
    issues.push({ code: "worktrunk-hooks-missing", tier: "recommended" });
  }
  for (const tracking of facts.harnessTracking) {
    if (
      tracking.assessment.state === "probe-failed" ||
      tracking.assessment.state === "disabled" ||
      tracking.assessment.state === "artifact-missing-or-drifted"
    ) {
      issues.push({
        code: "harness-tracking-unprepared",
        tier: tracking.required ? "required" : "recommended",
        harnessId: tracking.harnessId,
        state: tracking.assessment.state,
      });
    }
  }
  return issues;
}

function addHarnessSelectionIssues(
  issues: SetupIssue[],
  facts: SetupPlanningFacts,
  selection: HarnessSelectionResolution,
): void {
  if (selection.outcome === "invalid") {
    issues.push({
      code: "harness-selection-invalid",
      tier: "required",
      reason: selection.reason,
    });
    return;
  }
  if (selection.outcome === "ambiguous") {
    issues.push({
      code: "harness-selection-ambiguous",
      tier: "required",
      candidateHarnessIds: selection.candidateHarnessIds,
    });
    return;
  }
  if (selection.outcome === "cancelled") {
    issues.push({ code: "harness-selection-invalid", tier: "required", reason: "cancelled" });
    return;
  }
  const unavailable = selection.requiredHarnessIds.some(
    (harnessId) =>
      facts.harnessSelection.harnesses.find((harness) => harness.id === harnessId)?.availability !==
      "available",
  );
  if (unavailable) {
    issues.push({
      code: "harness-selection-invalid",
      tier: "required",
      reason: "no-available-harness",
    });
  }
}

function addLauncherIssues(issues: SetupIssue[], facts: SetupPlanningFacts): void {
  const launchers = [
    ["station", facts.launchers.station],
    ["ingress", facts.launchers.ingress],
    ["tmux-popup", facts.launchers.tmuxPopup],
  ] as const;
  for (const [launcher, state] of launchers) {
    if (state !== "available") {
      issues.push({ code: "launcher-unready", tier: "recommended", launcher, state });
    }
  }
}

function deriveOperations(
  facts: SetupPlanningFacts,
  intent: SetupPlanningIntent,
  selection: HarnessSelectionResolution,
  issues: readonly SetupIssue[],
): SetupOperation[] {
  const operations: SetupOperation[] = [];
  for (const tool of facts.tools) {
    if (!tool.available && toolApplies(tool.id, facts.compiled)) {
      operations.push({
        id: `install:${tool.id}`,
        kind: "install-tool",
        tier: "required",
        selected: tool.installerAvailable,
        tool: tool.id,
      });
    }
  }
  if (Object.values(facts.launchers).some((launcher) => launcher === "checkout")) {
    operations.push({
      id: "link-station-launchers",
      kind: "link-launchers",
      tier: "recommended",
      selected: false,
    });
  }
  if (facts.worktrunkShell === "missing") {
    operations.push({
      id: "configure-worktrunk-shell",
      kind: "configure-worktrunk-shell",
      tier: "recommended",
      selected: false,
    });
  }
  const tmuxReady = toolAvailable(facts, "tmux") && facts.launchers.tmuxPopup !== "missing";
  if (tmuxReady && facts.tmuxPopup.persisted === "missing") {
    operations.push({
      id: "persist-tmux-popup",
      kind: "configure-tmux-popup",
      tier: "recommended",
      selected: false,
      scope: "persisted",
    });
  }
  if (
    tmuxReady &&
    facts.tmuxPopup.persisted !== "conflict" &&
    (facts.tmuxPopup.live === "missing" || facts.tmuxPopup.live === "unknown")
  ) {
    operations.push({
      id: "load-tmux-popup",
      kind: "configure-tmux-popup",
      tier: "recommended",
      selected: false,
      scope: "live",
    });
  }

  const hookLaunchersReady =
    facts.launchers.station !== "missing" && facts.launchers.ingress !== "missing";
  if (hookLaunchersReady && toolAvailable(facts, "worktrunk")) {
    operations.push({
      id: "prepare-worktrunk-tracking",
      kind: "prepare-worktrunk-tracking",
      tier: "recommended",
      selected: intent.installWorktrunkHooks,
    });
  }
  if (hookLaunchersReady) {
    for (const issue of issues) {
      if (issue.code !== "harness-tracking-unprepared") continue;
      if (!harnessAvailable(facts, issue.harnessId)) continue;
      const tracking = facts.harnessTracking.find(
        (candidate) => candidate.harnessId === issue.harnessId,
      );
      if (tracking === undefined || !trackingNeedsRepair(tracking)) continue;
      operations.push({
        id: `prepare-harness-tracking:${issue.harnessId}`,
        kind: "prepare-harness-tracking",
        tier: issue.tier,
        selected: true,
        harnessId: issue.harnessId,
      });
    }
  }
  if (
    selection.outcome === "selected" &&
    selection.requiredHarnessIds.some((harnessId) => harnessAvailable(facts, harnessId)) &&
    (facts.config.write === "create" || facts.config.write === "update")
  ) {
    operations.push({
      id: "write-config",
      kind: "write-config",
      tier: "required",
      selected: true,
      change: facts.config.write,
    });
  }
  return operations;
}

function trackingNeedsRepair(tracking: SetupPlanningFacts["harnessTracking"][number]): boolean {
  const assessment = tracking.assessment;
  if (assessment.state === "prepared" || assessment.state === "not-applicable") return false;
  if (assessment.requested === true && assessment.installed === true) return false;
  return tracking.required || assessment.state !== "disabled";
}

function toolApplies(toolId: SetupToolId, compiled: boolean): boolean {
  return toolId !== "bun" || !compiled;
}

function toolAvailable(facts: SetupPlanningFacts, toolId: SetupToolId): boolean {
  return facts.tools.find((tool) => tool.id === toolId)?.available === true;
}

function harnessAvailable(
  facts: SetupPlanningFacts,
  harnessId: SetupPlanningFacts["harnessTracking"][number]["harnessId"],
): boolean {
  return (
    facts.harnessSelection.harnesses.find((harness) => harness.id === harnessId)?.availability ===
    "available"
  );
}
