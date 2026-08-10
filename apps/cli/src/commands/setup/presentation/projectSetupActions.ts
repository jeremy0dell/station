import type { SetupConfigMutationPlan } from "@station/config";
import type { SetupOperation, SetupToolInstallOperation } from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import type { SetupFacts } from "../adapters/inspectionTypes.js";
import { resolveSetupHarnessInstallation } from "../harnessInstallation.js";
import { SETUP_TOOL_DEFINITIONS } from "../toolDefinitions.js";
import type { SetupPresentationHarnessSelection, SetupViewAction } from "./setupViewTypes.js";

export function projectSetupActions(input: {
  readonly operations: readonly SetupOperation[];
  readonly facts: SetupFacts;
  readonly selection: SetupPresentationHarnessSelection;
  readonly configMutation: SetupConfigMutationPlan | undefined;
}): readonly SetupViewAction[] {
  const { operations, facts, selection, configMutation } = input;
  const actions = operations.flatMap((operation) =>
    projectSetupOperationActions({ operation, facts, configMutation }),
  );
  if (configMutation?.operation === "blocked") {
    actions.push(
      ...projectConfigWriteActions({
        configMutation,
        hasSelectedHarness: selection.requiredHarnessIds.length > 0,
      }),
    );
  }
  return actions;
}

export function projectSetupOperationActions(input: {
  readonly operation: SetupOperation;
  readonly facts: SetupFacts;
  readonly configMutation: SetupConfigMutationPlan | undefined;
}): SetupViewAction[] {
  const { operation, facts, configMutation } = input;
  switch (operation.kind) {
    case "install-tool": {
      return [projectInstallToolAction({ operation, facts })];
    }
    case "link-launchers":
      return [
        {
          id: "link-station-launchers",
          operationId: operation.id,
          kind: operation.kind,
          tier: "recommended",
          selected: operation.selected,
          label: setupMessageRef("action.link-launchers-label"),
          explanation: setupMessageRef("action.link-launchers-message"),
        },
      ];
    case "configure-worktrunk-shell":
      return facts.worktrunkShellIntegration.shell === undefined
        ? []
        : [
            {
              id: "worktrunk-shell-integration",
              operationId: operation.id,
              kind: operation.kind,
              tier: "recommended",
              selected: operation.selected,
              label: setupMessageRef("action.worktrunk-shell-label"),
              explanation: setupMessageRef("action.worktrunk-shell-message"),
            },
          ];
    case "configure-tmux-popup":
      return [
        {
          id: operation.scope === "persisted" ? "tmux-popup-binding" : "tmux-live-popup-binding",
          operationId: operation.id,
          kind: operation.kind,
          tier: "recommended",
          selected: operation.selected,
          label: setupMessageRef(
            operation.scope === "persisted"
              ? "action.tmux-persist-label"
              : "action.tmux-live-label",
          ),
          explanation: setupMessageRef(
            operation.scope === "persisted"
              ? "action.tmux-persist-message"
              : "action.tmux-live-message",
            {
              key: facts.tmuxBinding.status === "conflict" ? "Space" : facts.tmuxBinding.bindingKey,
            },
          ),
        },
      ];
    case "prepare-worktrunk-tracking":
      return [
        {
          id: "worktrunk-hooks",
          operationId: operation.id,
          kind: operation.kind,
          tier: "recommended",
          selected: operation.selected,
          label: setupMessageRef("action.worktrunk-hooks-label"),
          explanation: setupMessageRef("action.worktrunk-hooks-message"),
        },
      ];
    case "prepare-harness-tracking": {
      const label =
        facts.harnesses.find((harness) => harness.id === operation.harnessId)?.label ??
        operation.harnessId;
      return [
        {
          id: `${operation.harnessId}-hooks`,
          operationId: operation.id,
          kind: operation.kind,
          tier: operation.tier,
          selected: operation.selected,
          label: setupMessageRef("action.harness-tracking-label", { harness: label }),
          explanation: setupMessageRef("action.harness-tracking-message", { harness: label }),
        },
      ];
    }
    case "write-config": {
      return projectConfigWriteActions({
        configMutation,
        hasSelectedHarness: true,
        operationId: operation.id,
      });
    }
    case "install-harness": {
      const label =
        facts.harnesses.find((harness) => harness.id === operation.harnessId)?.label ??
        operation.harnessId;
      const installation = resolveSetupHarnessInstallation({
        harnessId: operation.harnessId,
        brewAvailable: facts.brew.status === "ok",
        homeDir: facts.homeDir,
        macos: facts.xcode.applicable,
      });
      return [
        {
          id: `install-harness-${operation.harnessId}`,
          operationId: operation.id,
          kind: operation.kind,
          tier: "required",
          selected: operation.selected,
          label: setupMessageRef("action.install-label", { label }),
          explanation: installation.message,
        },
      ];
    }
    case "install-homebrew":
      return [
        {
          id: "install-homebrew",
          operationId: operation.id,
          kind: operation.kind,
          tier: "required",
          selected: operation.selected,
          label: setupMessageRef("action.install-label", { label: "Homebrew" }),
          explanation: setupMessageRef("installer.homebrew"),
        },
      ];
    case "install-xcode-command-line-tools":
      return [
        {
          id: "install-command-line-tools",
          operationId: operation.id,
          kind: operation.kind,
          tier: "required",
          selected: operation.selected,
          label: setupMessageRef("action.install-label", { label: "Command Line Tools" }),
          explanation: setupMessageRef("installer.command-line-tools"),
        },
      ];
    case "activate-observer-config":
      return [];
    default:
      return assertNeverOperation(operation);
  }
}

function projectInstallToolAction(input: {
  readonly operation: SetupToolInstallOperation;
  readonly facts: SetupFacts;
}): SetupViewAction {
  const { operation, facts } = input;
  const definition = SETUP_TOOL_DEFINITIONS[operation.tool];
  const installerAvailable = facts.brew.status === "ok";
  return {
    id: `install-${definition.id}`,
    operationId: operation.id,
    kind: operation.kind,
    tier: "required",
    selected: operation.selected,
    label: setupMessageRef("action.install-label", { label: definition.displayName }),
    explanation: installerAvailable
      ? setupMessageRef("action.install-homebrew", { label: definition.displayName })
      : setupMessageRef("action.install-manually", {
          label: definition.displayName,
          formula: definition.formula,
        }),
  };
}

function projectConfigWriteActions(input: {
  readonly configMutation: SetupConfigMutationPlan | undefined;
  readonly hasSelectedHarness: boolean;
  readonly operationId?: SetupOperation["id"];
}): SetupViewAction[] {
  const { configMutation, hasSelectedHarness, operationId } = input;
  if (!hasSelectedHarness || configMutation === undefined || configMutation.operation === "none") {
    return [];
  }
  if (configMutation.operation === "blocked") {
    return [
      {
        id: "config-blocked",
        kind: "write-config",
        tier: "required",
        selected: false,
        label: setupMessageRef("action.config-blocked-label"),
        explanation: setupMessageRef("check.evidence", { message: configMutation.reason }),
      },
    ];
  }
  return [
    {
      id: "mkdir-config-dir",
      ...(operationId === undefined ? {} : { operationId }),
      kind: "mkdir",
      tier: "required",
      selected: true,
      label: setupMessageRef("action.config-directory-label"),
      explanation: setupMessageRef("action.config-directory-message"),
    },
    {
      id: configMutation.operation === "create" ? "write-config" : "update-config",
      ...(operationId === undefined ? {} : { operationId }),
      kind: "write-config",
      tier: "required",
      selected: true,
      label: setupMessageRef(
        configMutation.operation === "create"
          ? "action.config-create-label"
          : "action.config-update-label",
      ),
      explanation: setupMessageRef(
        configMutation.operation === "create"
          ? "action.config-create-message"
          : "action.config-update-message",
      ),
    },
  ];
}

function assertNeverOperation(operation: never): never {
  throw new Error(`Unsupported setup operation: ${String(operation)}`);
}
