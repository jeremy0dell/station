import {
  type PersistSetupConfigMutationOptions,
  persistSetupConfigMutation,
  planSetupConfigMutation,
  type SetupConfigDesiredState,
  type SetupConfigMutationInput,
} from "@station/config";
import { publicSafeErrorFromUnknown } from "@station/runtime";
import type {
  SetupConfigMutationPort,
  SetupOperation,
  SetupOperationOutcome,
} from "@station/setup-core";
import type { SetupFacts } from "../model.js";

export type SetupConfigAdapterOptions = {
  readonly facts: SetupFacts;
  readonly now?: () => Date;
  readonly fs?: PersistSetupConfigMutationOptions["fs"];
  readonly onCommitted?: (configPath: string) => void;
};

/**
 * ADAPTER
 *
 * Translates semantic setup configuration policy into validated config-owned planning and persistence.
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

export function setupConfigMutationInput(
  operation: Extract<SetupOperation, { kind: "write-config" }>,
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
        command: harness.command,
        installHooks: operation.trackingHarnessIds.includes(harnessId),
      };
    }),
    worktrunkCommand: detectedCommand(facts.worktrunk, "wt"),
    installWorktrunkHooks: operation.installWorktrunkTracking,
  };
  const tmuxCommand = detectedOptionalCommand(facts.tmux, "tmux");
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
  operation: Extract<SetupOperation, { kind: "write-config" }>,
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
