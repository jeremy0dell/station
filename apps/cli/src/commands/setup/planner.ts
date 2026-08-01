import {
  type SetupPlan as CoreSetupPlan,
  type HarnessSelectionIntent,
  planSetup,
  type SetupOperation,
  type SetupPlanningIntent,
} from "@station/setup-core";
import { normalizeSetupPlanningFacts } from "./adapters/inspection.js";
import type { SetupOperationBinding } from "./apply.js";
import { resolveSetupHarnessSelection, type SetupHarnessSelection } from "./harnessSelection.js";
import type { ConfigWritePlan, SetupFacts, SetupPlan } from "./model.js";
import { SetupHarnessTrackingFactSchema } from "./model.js";
import { projectCliSetupPlan } from "./presentation/projectCliSetupPlan.js";
import { type ProjectSetupView, projectSetupView } from "./presentation/projectSetupView.js";

export type BuildSetupPlanOptions = {
  configWrite?: ConfigWritePlan;
  harnessSelection?: SetupHarnessSelection;
  installWorktrunkHooks?: boolean;
};

export type BuiltSetupPlans = {
  readonly semanticPlan: CoreSetupPlan;
  readonly presentationView: ProjectSetupView;
  readonly compatibilityPlan: SetupPlan;
  readonly operationBindings: readonly SetupOperationBinding[];
};

export function buildSetupPlan(facts: SetupFacts, options: BuildSetupPlanOptions = {}): SetupPlan {
  return buildSetupPlans(facts, options).compatibilityPlan;
}

export function buildSetupPlans(
  facts: SetupFacts,
  options: BuildSetupPlanOptions = {},
): BuiltSetupPlans {
  SetupHarnessTrackingFactSchema.array().parse(facts.harnessTracking);
  const harnessSelection = options.harnessSelection ?? resolveSetupHarnessSelection(facts);
  const evidence = normalizeSetupPlanningFacts(facts, harnessSelection, options.configWrite);
  const intent: SetupPlanningIntent = {
    mode: facts.mode,
    harnessSelection: normalizeHarnessSelectionIntent(options.harnessSelection),
    installWorktrunkHooks: options.installWorktrunkHooks === true,
  };
  const semanticPlan = planSetup(evidence, intent);
  const projectionInput =
    options.configWrite === undefined
      ? { plan: semanticPlan, facts }
      : { plan: semanticPlan, facts, configWrite: options.configWrite };
  // Keep the frozen JSON adapter independent from catalog-backed human projection until #358 removes it.
  const presentationView = projectSetupView(projectionInput);
  const compatibilityPlan = projectCliSetupPlan(projectionInput);
  return {
    semanticPlan,
    presentationView,
    compatibilityPlan,
    operationBindings: bindSetupOperations(semanticPlan.operations),
  };
}

function bindSetupOperations(
  operations: readonly SetupOperation[],
): readonly SetupOperationBinding[] {
  const bindings: SetupOperationBinding[] = [];
  for (const operation of operations) {
    switch (operation.kind) {
      case "install-tool":
        bindings.push({ actionId: `install-${operation.tool}`, operation });
        break;
      case "link-launchers":
        bindings.push({ actionId: "link-station-launchers", operation });
        break;
      case "configure-worktrunk-shell":
        bindings.push({ actionId: "worktrunk-shell-integration", operation });
        break;
      case "configure-tmux-popup":
        bindings.push({
          actionId:
            operation.scope === "persisted" ? "tmux-popup-binding" : "tmux-live-popup-binding",
          operation,
        });
        break;
      case "prepare-worktrunk-tracking":
        bindings.push({ actionId: "worktrunk-hooks", operation });
        break;
      case "prepare-harness-tracking":
        bindings.push({ actionId: `${operation.harnessId}-hooks`, operation });
        break;
      case "write-config":
        bindings.push(
          { actionId: "mkdir-config-dir", operation },
          {
            actionId: operation.change === "create" ? "write-config" : "update-config",
            operation,
          },
        );
        break;
      case "activate-observer-config":
      case "install-harness":
      case "install-homebrew":
      case "install-xcode-command-line-tools":
        break;
      default:
        assertNeverOperation(operation);
    }
  }
  return bindings;
}

function normalizeHarnessSelectionIntent(
  selection: SetupHarnessSelection | undefined,
): HarnessSelectionIntent {
  if (selection?.source === "explicit") {
    return { kind: "explicit", harnessIds: selection.requiredHarnessIds };
  }
  return { kind: "automatic" };
}

function assertNeverOperation(operation: never): never {
  throw new Error(`Unsupported setup operation: ${String(operation)}`);
}
