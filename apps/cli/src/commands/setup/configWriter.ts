import {
  planSetupConfigMutation,
  renderSetupConfig,
  type SetupConfigDesiredState,
} from "@station/config";
import type { SetupConfigWriteOperation } from "@station/setup-core";
import { setupConfigMutationInput } from "./adapters/config.js";
import {
  harnessSupportsSetupHooks,
  resolveSetupHarnessSelection,
  type SetupHarnessSelection,
} from "./harnessSelection.js";
import type { ConfigWritePlan, SetupFacts, SetupHarnessFact, SupportedHarnessId } from "./model.js";

export type PlanSetupConfigWriteOptions = {
  harnessSelection?: SetupHarnessSelection;
  installWorktrunkHooks?: boolean;
  installHarnessHooks?: readonly SupportedHarnessId[];
};

export async function planSetupConfigWrite(
  facts: SetupFacts,
  options: PlanSetupConfigWriteOptions = {},
): Promise<ConfigWritePlan> {
  const harnessSelection = options.harnessSelection ?? resolveSetupHarnessSelection(facts);
  if (facts.config.status === "invalid") {
    return { operation: "blocked", path: facts.config.path, reason: facts.config.message };
  }
  if (harnessSelection.selected.length === 0) {
    return {
      operation: "blocked",
      path: facts.configPath,
      reason:
        harnessSelection.source === "unresolved" &&
        facts.harnesses.filter((harness) => harness.status === "ok").length > 1
          ? "Multiple supported harness CLIs are available; explicit selection is required."
          : "No unambiguous supported harness CLI is available; config was not planned.",
    };
  }

  const operation = configOperation(harnessSelection, options);
  const plan = await planSetupConfigMutation(setupConfigMutationInput(operation, facts));
  switch (plan.operation) {
    case "none":
      return plan;
    case "blocked":
      return plan;
    case "create":
      return { operation: "create", path: plan.path, content: plan.content };
    case "update":
      return { operation: "update", path: plan.path, content: plan.content };
  }
}

export function renderNewSetupConfig(
  harnesses: readonly SetupHarnessFact[],
  facts?: Pick<SetupFacts, "worktrunk" | "tmux">,
  options: Pick<PlanSetupConfigWriteOptions, "installWorktrunkHooks" | "installHarnessHooks"> = {},
): string {
  const defaultHarness = harnesses[0];
  if (defaultHarness === undefined) throw new Error("New setup config requires an agent CLI.");
  const desired: {
    defaultHarness: SetupConfigDesiredState["defaultHarness"];
    harnesses: SetupConfigDesiredState["harnesses"];
    worktrunkCommand: string;
    tmuxCommand?: string;
    installWorktrunkHooks: boolean;
  } = {
    defaultHarness: defaultHarness.id,
    harnesses: harnesses.map((harness) => ({
      id: harness.id,
      command: harness.command,
      installHooks:
        harnessSupportsSetupHooks(harness.id) &&
        options.installHarnessHooks?.includes(harness.id) === true,
    })),
    worktrunkCommand:
      facts?.worktrunk === undefined ? "wt" : detectedCommand(facts.worktrunk, "wt"),
    installWorktrunkHooks: options.installWorktrunkHooks === true,
  };
  const tmuxCommand =
    facts?.tmux === undefined ? undefined : detectedOptionalCommand(facts.tmux, "tmux");
  if (tmuxCommand !== undefined) desired.tmuxCommand = tmuxCommand;
  return renderSetupConfig(desired);
}

function configOperation(
  selection: SetupHarnessSelection,
  options: PlanSetupConfigWriteOptions,
): SetupConfigWriteOperation {
  const defaultHarnessId = selection.defaultHarness ?? selection.requiredHarnessIds[0];
  if (defaultHarnessId === undefined) throw new Error("Setup config requires a default harness.");
  const trackingHarnessIds = selection.requiredHarnessIds.filter(
    (harnessId) =>
      harnessSupportsSetupHooks(harnessId) &&
      options.installHarnessHooks?.includes(harnessId) === true,
  );
  return {
    id: "write-config",
    kind: "write-config",
    tier: "required",
    selected: true,
    change: "create",
    defaultHarnessId,
    harnessIds: selection.requiredHarnessIds,
    trackingHarnessIds,
    installWorktrunkTracking: options.installWorktrunkHooks === true,
  };
}

function detectedCommand(
  fact: { command: string; resolvedPath?: string },
  defaultCommand: string,
): string {
  if (fact.command !== defaultCommand || fact.command.includes("/")) return fact.command;
  return fact.resolvedPath ?? defaultCommand;
}

function detectedOptionalCommand(
  fact: { command: string; resolvedPath?: string },
  defaultCommand: string,
): string | undefined {
  if (fact.command !== defaultCommand || fact.command.includes("/")) return fact.command;
  return fact.resolvedPath;
}
