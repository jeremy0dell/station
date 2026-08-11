import {
  type PersistSetupConfigMutationOptions,
  persistSetupConfigMutation,
  planSetupConfigMutation,
  type SetupConfigDesiredState,
  type SetupConfigMutationInput,
  type SetupConfigMutationPlan,
} from "@station/config";
import type { CliSetupHarnessId } from "@station/contracts";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type {
  HarnessSelectionResolution,
  SetupConfigMutationPort,
  SetupConfigWriteOperation,
  SetupOperationOutcome,
} from "@station/setup-core";
import { SETUP_HARNESS_DEFINITIONS } from "../harnessDefinitions.js";
import { SETUP_TOOL_DEFINITIONS } from "../toolDefinitions.js";
import type { SetupFacts } from "./inspectionTypes.js";

export type SetupConfigAdapterOptions = {
  readonly facts: SetupFacts;
  readonly now?: () => Date;
  readonly fs?: PersistSetupConfigMutationOptions["fs"];
  readonly onCommitted?: (configPath: string) => void;
};

/**
 * ADAPTER
 *
 * Translates semantic setup configuration intent through one shared preview mapper and serializes validated config-owned persistence.
 */
export function createSetupConfigAdapter(
  options: SetupConfigAdapterOptions,
): SetupConfigMutationPort {
  return async (operation) => {
    try {
      const input = setupConfigMutationInput(operation, options.facts);
      const plan = await planSetupConfigMutation(input);
      if (plan.operation === "blocked") {
        throw {
          tag: "SetupConfigError",
          code: "SETUP_CONFIG_PRECONDITION_FAILED",
          message: plan.reason,
          hint: plan.path,
        };
      }
      if (plan.operation === "none") {
        options.onCommitted?.(options.facts.config.path);
        return completedConfigOutcome(operation, {
          status: "unchanged",
          configPath: options.facts.config.path,
        });
      }
      const persistenceOptions: {
        homeDir: string;
        now?: NonNullable<PersistSetupConfigMutationOptions["now"]>;
        fs?: NonNullable<PersistSetupConfigMutationOptions["fs"]>;
      } = { homeDir: options.facts.homeDir };
      if (options.now !== undefined) persistenceOptions.now = options.now;
      if (options.fs !== undefined) persistenceOptions.fs = options.fs;
      const result = await persistSetupConfigMutation(plan, persistenceOptions);
      options.onCommitted?.(result.configPath);
      return completedConfigOutcome(operation, result);
    } catch (error) {
      return {
        status: "failed",
        operationId: operation.id,
        error: publicSafeErrorFromUnknown(error, {
          tag: "SetupConfigError",
          code: "CONFIG_WRITE_FAILED",
          message: "Could not update config.toml.",
          hint: options.facts.config.path,
        }),
      };
    }
  };
}

export async function planSetupConfigMutationForInspection(input: {
  readonly facts: SetupFacts;
  readonly selection: HarnessSelectionResolution;
  readonly trackingIntent: {
    readonly harnessIds: readonly CliSetupHarnessId[];
    readonly installWorktrunkHooks: boolean;
  };
}): Promise<SetupConfigMutationPlan> {
  const { facts, selection, trackingIntent } = input;
  if (facts.config.status === "invalid") {
    return {
      operation: "blocked",
      path: facts.config.path,
      reason: facts.config.message,
    };
  }
  if (selection.outcome !== "selected") {
    const multipleHarnessesAvailable =
      selection.outcome === "ambiguous" ||
      facts.harnesses.filter((harness) => harness.status === "ok").length > 1;
    return {
      operation: "blocked",
      path: facts.configPath,
      reason: multipleHarnessesAvailable
        ? "Multiple supported harness CLIs are available; explicit selection is required."
        : "No unambiguous supported harness CLI is available; config was not planned.",
    };
  }
  const operation: SetupConfigWriteOperation = {
    id: "write-config",
    kind: "write-config",
    tier: "required",
    selected: true,
    change: facts.config.status === "missing" ? "create" : "update",
    defaultHarnessId: selection.defaultHarness,
    harnessIds: selection.requiredHarnessIds,
    trackingHarnessIds: selection.requiredHarnessIds.filter((harnessId) =>
      trackingIntent.harnessIds.includes(harnessId),
    ),
    installWorktrunkTracking: trackingIntent.installWorktrunkHooks,
  };
  // Inspection and commit share this mapper so the displayed plan cannot drift from the executed mutation.
  return planSetupConfigMutation(setupConfigMutationInput(operation, facts));
}

export function setupConfigMutationInput(
  operation: SetupConfigWriteOperation,
  facts: SetupFacts,
): SetupConfigMutationInput {
  const desired: {
    defaultHarness: SetupConfigDesiredState["defaultHarness"];
    harnesses: SetupConfigDesiredState["harnesses"];
    worktrunkCommand: string;
    tmuxCommand?: string;
    installWorktrunkHooks: boolean;
  } = {
    defaultHarness: operation.defaultHarnessId,
    harnesses: operation.harnessIds.map((harnessId) => {
      const harness = facts.harnesses.find((candidate) => candidate.id === harnessId);
      if (harness === undefined) {
        throw new Error(`Setup facts do not include selected harness ${harnessId}.`);
      }
      return {
        id: harnessId,
        command: detectedHarnessCommand(harness),
        installHooks: operation.trackingHarnessIds.includes(harnessId),
      };
    }),
    worktrunkCommand: detectedCommand(facts.worktrunk, SETUP_TOOL_DEFINITIONS.worktrunk.command),
    installWorktrunkHooks: operation.installWorktrunkTracking,
  };
  const tmuxCommand = detectedOptionalCommand(facts.tmux, SETUP_TOOL_DEFINITIONS.tmux.command);
  if (tmuxCommand !== undefined) desired.tmuxCommand = tmuxCommand;

  let current: SetupConfigMutationInput["current"];
  switch (facts.config.status) {
    case "missing":
      current = { state: "missing" };
      break;
    case "valid":
      current = { state: "valid", source: facts.config.source };
      break;
    case "invalid":
      throw {
        tag: "SetupConfigError",
        code: "SETUP_CONFIG_PRECONDITION_FAILED",
        message: facts.config.message,
        hint: facts.config.path,
      };
  }
  return {
    configPath: facts.config.path,
    homeDir: facts.homeDir,
    current,
    desired,
  };
}

function completedConfigOutcome(
  operation: SetupConfigWriteOperation,
  result: {
    readonly status: "created" | "updated" | "unchanged";
    readonly configPath: string;
    readonly backupPath?: string;
  },
): SetupOperationOutcome {
  return result.backupPath === undefined
    ? {
        status: "completed",
        operationId: operation.id,
        commit: { kind: "config", configPath: result.configPath, change: result.status },
      }
    : {
        status: "completed",
        operationId: operation.id,
        commit: {
          kind: "config",
          configPath: result.configPath,
          change: result.status,
          backupPath: result.backupPath,
        },
      };
}

function detectedHarnessCommand(fact: SetupFacts["harnesses"][number]): string {
  if (!fact.command.includes("/") && fact.resolvedPath !== undefined) return fact.resolvedPath;
  const defaultCommand = SETUP_HARNESS_DEFINITIONS[fact.id].commandFallback;
  return detectedCommand(fact, defaultCommand);
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
