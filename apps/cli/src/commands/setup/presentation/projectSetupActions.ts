import type { SetupOperation, SetupToolInstallOperation } from "@station/setup-core";
import { setupMessageRef } from "@station/setup-messages";
import type { SetupHarnessSelection } from "../harnessSelection.js";
import type { ConfigWritePlan, SetupFacts } from "../model.js";
import type { SetupViewAction } from "./setupViewTypes.js";

export function projectSetupActions(
  operations: readonly SetupOperation[],
  facts: SetupFacts,
  selection: SetupHarnessSelection,
  configWrite: ConfigWritePlan | undefined,
): readonly SetupViewAction[] {
  const actions = operations.flatMap((operation) =>
    projectSetupOperationActions(operation, facts, configWrite),
  );
  if (configWrite?.operation === "blocked") {
    actions.push(...projectConfigWriteActions(configWrite, selection.selected.length > 0));
  }
  return actions;
}

export function projectSetupOperationActions(
  operation: SetupOperation,
  facts: SetupFacts,
  configWrite: ConfigWritePlan | undefined,
): SetupViewAction[] {
  switch (operation.kind) {
    case "install-tool":
      return [projectInstallToolAction(operation, facts)];
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
    case "write-config":
      return projectConfigWriteActions(configWrite, true, operation.id);
    case "install-harness": {
      const label =
        facts.harnesses.find((harness) => harness.id === operation.harnessId)?.label ??
        operation.harnessId;
      return [
        {
          id: `install-harness-${operation.harnessId}`,
          operationId: operation.id,
          kind: operation.kind,
          tier: "required",
          selected: operation.selected,
          label: setupMessageRef("action.install-label", { label }),
          explanation: harnessInstallerMessage(operation.harnessId, facts),
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

function harnessInstallerMessage(
  harnessId: Extract<SetupOperation, { kind: "install-harness" }>["harnessId"],
  facts: SetupFacts,
) {
  const macBrewAvailable = facts.xcode.applicable && facts.brew.status === "ok";
  switch (harnessId) {
    case "codex":
      return setupMessageRef(macBrewAvailable ? "installer.codex-brew" : "installer.codex-script");
    case "cursor":
      return setupMessageRef("installer.cursor-script");
    case "opencode":
      return setupMessageRef(
        facts.brew.status === "ok" ? "installer.opencode-brew" : "installer.opencode-script",
      );
    case "pi":
      return setupMessageRef(facts.brew.status === "ok" ? "installer.pi-brew" : "installer.pi-npm");
    case "claude":
      return setupMessageRef(macBrewAvailable ? "installer.claude-brew" : "installer.claude-npm");
    default:
      return assertNeverHarness(harnessId);
  }
}

function projectInstallToolAction(
  operation: SetupToolInstallOperation,
  facts: SetupFacts,
): SetupViewAction {
  const presentation = toolPresentation(operation.tool);
  const installerAvailable = facts.brew.status === "ok";
  return {
    id: `install-${operation.tool}`,
    operationId: operation.id,
    kind: operation.kind,
    tier: "required",
    selected: operation.selected,
    label: setupMessageRef("action.install-label", { label: presentation.label }),
    explanation: installerAvailable
      ? setupMessageRef("action.install-homebrew", { label: presentation.label })
      : setupMessageRef("action.install-manually", {
          label: presentation.label,
          formula: presentation.formula,
        }),
  };
}

function toolPresentation(tool: SetupToolInstallOperation["tool"]): {
  readonly label: string;
  readonly formula: string;
} {
  switch (tool) {
    case "worktrunk":
      return { label: "Worktrunk", formula: "worktrunk" };
    case "tmux":
      return { label: "tmux", formula: "tmux" };
    case "bun":
      return { label: "Bun", formula: "bun" };
    case "diffnav":
      return { label: "diffnav", formula: "diffnav" };
    case "git-delta":
      return { label: "git-delta", formula: "git-delta" };
    default:
      return assertNeverTool(tool);
  }
}

function projectConfigWriteActions(
  configWrite: ConfigWritePlan | undefined,
  hasSelectedHarness: boolean,
  operationId?: SetupOperation["id"],
): SetupViewAction[] {
  if (!hasSelectedHarness || configWrite === undefined || configWrite.operation === "none") {
    return [];
  }
  if (configWrite.operation === "blocked") {
    return [
      {
        id: "config-blocked",
        kind: "write-config",
        tier: "required",
        selected: false,
        label: setupMessageRef("action.config-blocked-label"),
        explanation: setupMessageRef("check.evidence", { message: configWrite.reason }),
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
      id: configWrite.operation === "create" ? "write-config" : "update-config",
      ...(operationId === undefined ? {} : { operationId }),
      kind: "write-config",
      tier: "required",
      selected: true,
      label: setupMessageRef(
        configWrite.operation === "create"
          ? "action.config-create-label"
          : "action.config-update-label",
      ),
      explanation: setupMessageRef(
        configWrite.operation === "create"
          ? "action.config-create-message"
          : "action.config-update-message",
      ),
    },
  ];
}

function assertNeverOperation(operation: never): never {
  throw new Error(`Unsupported setup operation: ${String(operation)}`);
}

function assertNeverTool(tool: never): never {
  throw new Error(`Unsupported setup tool: ${String(tool)}`);
}

function assertNeverHarness(harness: never): never {
  throw new Error(`Unsupported setup harness: ${String(harness)}`);
}
