import {
  type ObserverLifecycleFailure,
  ObserverLifecycleFailureSchema,
  ObserverRestartCommandResultSchema,
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
  providerHookReconciliationSucceeded,
  ptyLifetimeIdentitySetsMatch,
  type UpdateHostConvergenceCommand,
  UpdateHostConvergenceCommandResultSchema,
  type UpdateHostConvergenceCommitment,
  type UpdateHostConvergenceReceipt,
} from "@station/contracts";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import type { ExecutableArgv } from "../selfExec.js";
import {
  sanitizePublicHookResult,
  sanitizePublicObserverLifecycleFailure,
} from "./publicUpdateReportAdapter.js";
import type { UpdateCommandArgv } from "./updateChannel.js";
import type {
  UpdateRecoveryCommandInput,
  UpdateRuntimeConvergencePort,
} from "./updateRuntimeConvergencePort.js";

const OBSERVER_CROSSOVER_TIMEOUT_MS = 20_000;

export type UpdateRuntimeConvergenceAdapterOptions = {
  configPath?: string;
  commandRunner?: ExternalCommandRunner;
};

/**
 * ADAPTER
 *
 * Translates safe runtime actions into strict Host, Observer, hook, and reconcile children. Host
 * children must receipt the exact requested action and authorized immutable commitment.
 */
export function createUpdateRuntimeConvergenceAdapter(
  options: UpdateRuntimeConvergenceAdapterOptions,
): UpdateRuntimeConvergencePort {
  return {
    reconcileHook: (cli, provider) =>
      runHookReconciliation(
        stationCommand(cli, options.configPath, ["hooks", "reconcile", provider]),
        options.commandRunner,
      ),
    convergeObserver: (cli, action) =>
      runObserverMutation(
        stationCommand(cli, options.configPath, [
          "observer",
          action,
          "--timeout-ms",
          String(OBSERVER_CROSSOVER_TIMEOUT_MS),
        ]),
        options.commandRunner,
      ),
    replaceIdleHost: (cli, commitment) =>
      runHostMutation(
        stationCommand(cli, options.configPath, ["host", "update-converge", "--stdin", "--json"]),
        { schemaVersion: 1, action: "replace-idle", commitment },
        options.commandRunner,
      ),
    handoffHost: (cli, fidelity, commitment) =>
      runHostMutation(
        stationCommand(cli, options.configPath, ["host", "update-converge", "--stdin", "--json"]),
        { schemaVersion: 1, action: "handoff", fidelity, commitment },
        options.commandRunner,
      ),
    reconcile: (cli) =>
      runMutationCommand(
        stationCommand(cli, options.configPath, ["reconcile", "--reason", "update-convergence"]),
        options.commandRunner,
      ),
    recoveryCommands: (input) => recoveryCommands(input, options.configPath),
  };
}

async function runHookReconciliation(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<ProviderHookReconciliationResult> {
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 60_000,
      maxOutputChars: 64 * 1024,
      allowedExitCodes: [1],
    },
    runner,
  );
  const parsed = sanitizePublicHookResult(
    ProviderHookReconciliationResultSchema.parse(JSON.parse(result.stdout)),
  );
  if ((result.exitCode === 0) !== providerHookReconciliationSucceeded(parsed)) {
    throw new Error("Hook reconciliation contradicted its process exit status.");
  }
  return parsed;
}

async function runMutationCommand(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<void> {
  const [executable, ...args] = command;
  await runExternalCommand(
    { command: executable, args, timeoutMs: 60_000, maxOutputChars: 128 * 1024 },
    runner,
  );
}

async function runHostMutation(
  command: UpdateCommandArgv,
  request: UpdateHostConvergenceCommand,
  runner: ExternalCommandRunner | undefined,
): Promise<UpdateHostConvergenceReceipt> {
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 60_000,
      maxOutputChars: 128 * 1024,
      allowedExitCodes: [1],
      stdin: `${JSON.stringify(request)}\n`,
    },
    runner,
  );
  const parsed = UpdateHostConvergenceCommandResultSchema.parse(JSON.parse(result.stdout));
  const succeeded = parsed.status === "completed";
  if ((result.exitCode === 0) !== succeeded) {
    throw new Error("Host convergence result contradicted its process exit status.");
  }
  if (parsed.requestedAction !== request.action) {
    throw new Error("Host convergence result contradicted the requested action.");
  }
  if (parsed.status !== "completed") throw parsed.error;
  if (!hostCommitmentsMatch(parsed.receipt.validatedCommitment, request.commitment)) {
    throw new Error("Host convergence receipt did not retain the authorized commitment.");
  }
  return parsed.receipt;
}

function hostCommitmentsMatch(
  left: UpdateHostConvergenceCommitment,
  right: UpdateHostConvergenceCommitment,
): boolean {
  return (
    committedValuesMatch(left.incumbent.buildVersion, right.incumbent.buildVersion) &&
    committedValuesMatch(left.incumbent.buildIdentity, right.incumbent.buildIdentity) &&
    left.incumbent.protocolVersion === right.incumbent.protocolVersion &&
    ptyLifetimeIdentitySetsMatch(
      left.incumbent.inventory.terminals,
      right.incumbent.inventory.terminals,
    ) &&
    left.target.buildVersion === right.target.buildVersion &&
    left.target.buildIdentity === right.target.buildIdentity
  );
}

function committedValuesMatch(
  left: UpdateHostConvergenceCommitment["incumbent"]["buildVersion"],
  right: UpdateHostConvergenceCommitment["incumbent"]["buildVersion"],
): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "absent") return true;
  return right.status === "known" && left.value === right.value;
}

async function runObserverMutation(
  command: UpdateCommandArgv,
  runner: ExternalCommandRunner | undefined,
): Promise<ObserverLifecycleFailure | undefined> {
  const [executable, ...args] = command;
  const result = await runExternalCommand(
    {
      command: executable,
      args,
      timeoutMs: 60_000,
      maxOutputChars: 128 * 1024,
      allowedExitCodes: [1],
    },
    runner,
  );
  const parsed = ObserverRestartCommandResultSchema.parse(JSON.parse(result.stdout));
  if (result.exitCode === 0 && parsed.status === "running") return undefined;
  if (result.exitCode !== 0 && parsed.status !== "running") {
    const failure: ObserverLifecycleFailure = { error: parsed.error };
    if (parsed.cause !== undefined) failure.cause = parsed.cause;
    if (parsed.startupEvidence !== undefined) failure.startupEvidence = parsed.startupEvidence;
    return sanitizePublicObserverLifecycleFailure(ObserverLifecycleFailureSchema.parse(failure));
  }
  throw new Error("Observer convergence result contradicted its process exit status.");
}

function stationCommand(
  cli: ExecutableArgv,
  configPath: string | undefined,
  operation: string[],
): UpdateCommandArgv {
  const [command, ...prefix] = cli;
  return [
    command,
    ...prefix,
    ...(configPath === undefined ? [] : ["--config", configPath]),
    ...operation,
  ];
}

function recoveryCommands(
  input: UpdateRecoveryCommandInput,
  configPath: string | undefined,
): UpdateCommandArgv[] {
  return [
    stationCommand(input.cli, configPath, [
      "update",
      "--channel",
      input.channel,
      ...(input.drivePackageManager ? ["--drive-package-manager"] : []),
      ...(input.handoff === undefined
        ? ["--no-handoff"]
        : input.handoff === "processes"
          ? []
          : [`--handoff=${input.handoff}`]),
    ]),
  ];
}
