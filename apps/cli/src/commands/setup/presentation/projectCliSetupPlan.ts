import { resolveSetupMessage } from "@station/setup-messages";
import type { SetupAction, SetupPlan } from "../model.js";
import { SetupPlanSchema } from "../model.js";
import type {
  ProjectSetupView,
  SetupDisplayDetail,
  SetupRecoveryInstruction,
  SetupViewAction,
} from "./projectSetupView.js";

export function projectCliSetupPlan(view: ProjectSetupView): SetupPlan {
  const summary: SetupPlan["summary"] = {
    launchReady: view.result.readiness.launchReady,
    workflowReady: view.result.readiness.workflowReady,
    requiredOk: view.result.readiness.workflowReady,
    requiredMissing: view.result.readiness.requiredMissing,
    warnings: view.result.warningCount,
    selectedActions: view.actions.filter((action) => action.selected).length,
    selectionSource: view.selection.source,
    configPath: view.configPath,
  };
  if (view.selection.defaultHarness !== undefined) {
    summary.selectedHarness = view.selection.defaultHarness;
  }
  return SetupPlanSchema.parse({
    generatedAt: view.generatedAt,
    mode: view.mode,
    checks: view.checks.map((check) => ({
      id: check.id,
      tier: check.tier,
      status: check.status,
      label: resolveSetupMessage(check.label),
      message: resolveSetupMessage(check.explanation),
      ...(check.details.length === 0 ? {} : { details: compatibilityDetails(check.details) }),
    })),
    actions: view.actions.map(projectCompatibilityAction),
    summary,
    nextSteps: view.recovery.map(projectCompatibilityRecovery),
  });
}

function projectCompatibilityAction(action: SetupViewAction): SetupAction {
  const base = {
    id: action.id,
    tier: action.tier,
    selected: action.selected,
    label: resolveSetupMessage(action.label),
    message: resolveSetupMessage(action.explanation),
    ...(action.status === undefined ? {} : { status: action.status }),
  } as const;
  switch (action.execution.kind) {
    case "package-install":
      return {
        ...base,
        kind: action.execution.installerAvailable ? "brew-install" : "noop",
        command: [...action.execution.command],
        data: { formula: action.execution.formula },
      };
    case "command": {
      const data = providerTrackingData(action.execution);
      return {
        ...base,
        kind: "run-command",
        command: [...action.execution.command],
        ...(data === undefined ? {} : { data }),
      };
    }
    case "directory":
      return { ...base, kind: "mkdir", path: action.execution.path };
    case "config-write": {
      const data: Record<string, string> = {
        operation: action.execution.change,
        content: action.execution.content,
      };
      if (action.execution.backupPath !== undefined) {
        data.backupPath = action.execution.backupPath;
      }
      return {
        ...base,
        kind: "write-config",
        path: action.execution.path,
        data,
      };
    }
    case "file-append": {
      const data: Record<string, string> = { appendedText: action.execution.content };
      if (action.execution.marker !== undefined) data.marker = action.execution.marker;
      if (action.execution.endMarker !== undefined) data.endMarker = action.execution.endMarker;
      return {
        ...base,
        kind: "append-file",
        path: action.execution.path,
        data,
      };
    }
    case "none":
      return {
        ...base,
        kind: "noop",
        ...(action.execution.path === undefined ? {} : { path: action.execution.path }),
      };
  }
}

function providerTrackingData(
  execution: Extract<SetupViewAction["execution"], { kind: "command" }>,
): Record<string, string> | undefined {
  if (execution.purpose !== "provider-tracking") return undefined;
  const data: Record<string, string> = { setupRole: "hook" };
  if (execution.provider !== undefined && execution.provider !== "worktrunk") {
    data.harness = execution.provider;
  }
  return data;
}

function compatibilityDetails(details: readonly SetupDisplayDetail[]): Record<string, string> {
  return Object.fromEntries(
    details.map((detail) => [compatibilityDetailKey(detail), detail.value] as const),
  );
}

function compatibilityDetailKey(detail: SetupDisplayDetail): string {
  switch (detail.kind) {
    case "executable":
      return "command";
    case "version":
      return "version";
    case "path":
      return "path";
    case "repository-root":
      return "root";
    case "default-branch":
      return "defaultBranch";
    case "reason":
      return "reason";
    case "selection-origin":
      return "selectionSource";
    case "available-harnesses":
      return "available";
    case "default-harness":
      return "default";
    case "enabled-harnesses":
      return "enabled";
    case "unavailable-harnesses":
      return "unavailable";
    case "default-harness-status":
      return "defaultStatus";
    case "tracking-state":
      return "state";
    case "harness-identity":
      return "harness";
    case "tracking-capability":
      return "capability";
    case "tracking-requested":
      return "requested";
    case "tracking-installed":
      return "installed";
    case "tracking-owner-status":
      return "ownership";
    case "requested-launcher":
      return "requestedLauncher";
    case "requested-runtime-kind":
      return "requestedRuntimeKind";
    case "requested-runtime-version":
      return "requestedRuntimeVersion";
    case "requested-build-identity":
      return "requestedBuildIdentity";
    case "current-launcher":
      return "currentLauncher";
    case "current-runtime-kind":
      return "currentRuntimeKind";
    case "current-runtime-version":
      return "currentRuntimeVersion";
    case "current-build-identity":
      return "currentBuildIdentity";
    case "worktrunk-policy":
      return "automationMode";
    case "worktrunk-flag":
      return "flag";
    case "missing-subcommands":
      return "missingSubcommands";
    case "station-launcher":
      return "station";
    case "ingress-launcher":
      return "ingress";
    case "tmux-popup-launcher":
      return "tmuxPopup";
    case "launcher-directory":
      return "pathDirectory";
    case "resolved-executable":
      return "resolvedPath";
    case "tmux-binding-launcher":
      return "launcherCommand";
    case "tmux-live-status":
      return "liveStatus";
    case "tmux-binding-key":
      return "bindingKey";
    case "shell":
      return "shell";
    case "shell-config-path":
      return "rcPath";
    case "configured-harnesses":
      return "configuredHarnesses";
    case "project":
      return "project";
    case "worktree-provider":
      return "worktreeProvider";
    case "terminal":
      return "terminal";
  }
}

function projectCompatibilityRecovery(instruction: SetupRecoveryInstruction): string {
  if (instruction.kind === "command") return formatCommand(instruction.command);
  const message = resolveSetupMessage(instruction.message);
  return instruction.command === undefined
    ? message
    : `${message} Then run: ${formatCommand(instruction.command)}`;
}

function formatCommand(command: readonly string[]): string {
  return command.map(quoteCommandPart).join(" ");
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(part)) return part;
  return `'${part.replaceAll("'", "'\\''")}'`;
}
