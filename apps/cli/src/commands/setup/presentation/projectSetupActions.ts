import type { SetupOperation } from "@station/setup-core";
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
  const actions: SetupViewAction[] = [];
  for (const operation of operations) {
    switch (operation.kind) {
      case "install-tool":
        actions.push(projectInstallToolAction(operation, facts));
        break;
      case "link-launchers":
        actions.push({
          id: "link-station-launchers",
          kind: operation.kind,
          tier: "recommended",
          selected: false,
          label: setupMessageRef("action.link-launchers-label"),
          explanation: setupMessageRef("action.link-launchers-message"),
        });
        break;
      case "configure-worktrunk-shell":
        if (facts.worktrunkShellIntegration.shell !== undefined) {
          actions.push({
            id: "worktrunk-shell-integration",
            kind: operation.kind,
            tier: "recommended",
            selected: false,
            label: setupMessageRef("action.worktrunk-shell-label"),
            explanation: setupMessageRef("action.worktrunk-shell-message"),
          });
        }
        break;
      case "configure-tmux-popup":
        actions.push({
          id: operation.scope === "persisted" ? "tmux-popup-binding" : "tmux-live-popup-binding",
          kind: operation.kind,
          tier: "recommended",
          selected: false,
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
        });
        break;
      case "prepare-worktrunk-tracking":
        actions.push({
          id: "worktrunk-hooks",
          kind: operation.kind,
          tier: "recommended",
          selected: operation.selected,
          label: setupMessageRef("action.worktrunk-hooks-label"),
          explanation: setupMessageRef("action.worktrunk-hooks-message"),
        });
        break;
      case "prepare-harness-tracking": {
        const label =
          facts.harnesses.find((harness) => harness.id === operation.harnessId)?.label ??
          operation.harnessId;
        actions.push({
          id: `${operation.harnessId}-hooks`,
          kind: operation.kind,
          tier: operation.tier,
          selected: true,
          label: setupMessageRef("action.harness-tracking-label", { harness: label }),
          explanation: setupMessageRef("action.harness-tracking-message", { harness: label }),
        });
        break;
      }
      case "write-config":
        actions.push(...projectConfigWriteActions(configWrite, true));
        break;
      case "activate-observer-config":
      case "install-harness":
      case "install-homebrew":
      case "install-xcode-command-line-tools":
        break;
    }
  }
  if (configWrite?.operation === "blocked") {
    actions.push(...projectConfigWriteActions(configWrite, selection.selected.length > 0));
  }
  return actions;
}

function projectInstallToolAction(
  operation: Extract<SetupOperation, { kind: "install-tool" }>,
  facts: SetupFacts,
): SetupViewAction {
  const presentation = toolPresentation(operation.tool);
  const installerAvailable = facts.brew.status === "ok";
  return {
    id: `install-${operation.tool}`,
    kind: operation.kind,
    tier: "required",
    selected: installerAvailable,
    label: setupMessageRef("action.install-label", { label: presentation.label }),
    explanation: installerAvailable
      ? setupMessageRef("action.install-homebrew", { label: presentation.label })
      : setupMessageRef("action.install-manually", {
          label: presentation.label,
          formula: presentation.formula,
        }),
  };
}

function toolPresentation(tool: Extract<SetupOperation, { kind: "install-tool" }>["tool"]): {
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
  }
}

function projectConfigWriteActions(
  configWrite: ConfigWritePlan | undefined,
  hasSelectedHarness: boolean,
): readonly SetupViewAction[] {
  if (!hasSelectedHarness || configWrite === undefined || configWrite.operation === "none")
    return [];
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
      kind: "mkdir",
      tier: "required",
      selected: true,
      label: setupMessageRef("action.config-directory-label"),
      explanation: setupMessageRef("action.config-directory-message"),
    },
    {
      id: configWrite.operation === "create" ? "write-config" : "update-config",
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
