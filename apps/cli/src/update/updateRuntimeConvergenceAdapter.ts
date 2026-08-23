import {
  type ObserverLifecycleFailure,
  ObserverLifecycleFailureSchema,
  ObserverRestartCommandResultSchema,
  type ProviderHookReconciliationResult,
  ProviderHookReconciliationResultSchema,
  providerHookReconciliationSucceeded,
} from "@station/contracts";
import { type ExternalCommandRunner, runExternalCommand } from "@station/runtime";
import type { ExecutableArgv } from "../selfExec.js";
import {
  sanitizePublicHookResult,
  sanitizePublicObserverLifecycleFailure,
} from "./publicUpdateReportAdapter.js";
import type { UpdateCommandArgv } from "./updateChannel.js";
import type {
  UpdateHookFailureRecoveryInput,
  UpdateRecoveryCommandInput,
  UpdateRuntimeConvergencePort,
} from "./updateRuntimeConvergencePort.js";

const OBSERVER_CROSSOVER_TIMEOUT_MS = 20_000;

export type UpdateRuntimeConvergenceAdapterOptions = {
  configPath?: string;
  commandRunner?: ExternalCommandRunner;
  observerSocketPath: string;
  observerBuildSelector: string;
};

/**
 * ADAPTER
 *
 * Translates safe Observer, hook, and reconcile runtime actions into strict child boundaries.
 * Observer mutation pins the selected build and configured socket and admits only an exact healthy
 * running result with exit zero; typed hook and Observer failures require exit one.
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
          "--internal-update-expected-socket",
          options.observerSocketPath,
          "--internal-update-expected-build-selector",
          options.observerBuildSelector,
        ]),
        {
          socketPath: options.observerSocketPath,
          buildSelector: options.observerBuildSelector,
        },
        options.commandRunner,
      ),
    reconcile: (cli) =>
      runMutationCommand(
        stationCommand(cli, options.configPath, ["reconcile", "--reason", "update-convergence"]),
        options.commandRunner,
      ),
    hookFailureRecoveryCommands: (input) => hookFailureRecoveryCommands(input, options.configPath),
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
  typedChildDisposition(
    result.exitCode,
    providerHookReconciliationSucceeded(parsed),
    "Hook reconciliation",
  );
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

async function runObserverMutation(
  command: UpdateCommandArgv,
  expected: { socketPath: string; buildSelector: string },
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
  const disposition = typedChildDisposition(
    result.exitCode,
    parsed.status === "running",
    "Observer convergence",
  );
  if (disposition === "success") {
    if (parsed.status !== "running" || !observerRunningResultMatches(parsed, expected)) {
      throw new Error(
        "Observer convergence did not prove admitted health and the exact configured identity.",
      );
    }
    return undefined;
  }
  if (parsed.status !== "running") {
    const failure: ObserverLifecycleFailure = { error: parsed.error };
    if (parsed.cause !== undefined) failure.cause = parsed.cause;
    if (parsed.startupEvidence !== undefined) failure.startupEvidence = parsed.startupEvidence;
    return sanitizePublicObserverLifecycleFailure(ObserverLifecycleFailureSchema.parse(failure));
  }
  throw new Error("Observer convergence result contradicted its process exit status.");
}

function observerRunningResultMatches(
  result: Extract<
    ReturnType<typeof ObserverRestartCommandResultSchema.parse>,
    { status: "running" }
  >,
  expected: { socketPath: string; buildSelector: string },
): boolean {
  return (
    result.socketPath === expected.socketPath &&
    result.health.status === "healthy" &&
    result.health.socketPath === expected.socketPath &&
    result.health.pid !== undefined &&
    result.health.startedAt !== undefined &&
    result.health.version === expected.buildSelector
  );
}

function typedChildDisposition(
  exitCode: number,
  declaredSuccess: boolean,
  boundary: "Hook reconciliation" | "Observer convergence",
): "success" | "failure" {
  // Injected runners return directly, so the typed trust boundary must enforce process semantics.
  if (exitCode === 0 && declaredSuccess) return "success";
  if (exitCode === 1 && !declaredSuccess) return "failure";
  throw new Error(`${boundary} contradicted its exact process exit status.`);
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

function hookFailureRecoveryCommands(
  input: UpdateHookFailureRecoveryInput,
  configPath: string | undefined,
): UpdateCommandArgv[] {
  const providerCommands = input.failures.map(({ provider, followUp }) => {
    switch (followUp.action) {
      case "enable-hooks":
        return stationCommand(input.cli, configPath, ["hooks", "install", provider, "--yes"]);
      case "run-doctor":
        return stationCommand(input.cli, configPath, ["hooks", "doctor", provider]);
      case "run-explicit-takeover":
        return stationCommand(input.cli, configPath, [
          "hooks",
          "install",
          provider,
          "--yes",
          "--takeover",
        ]);
      case "retry":
        return stationCommand(input.cli, configPath, ["hooks", "reconcile", provider]);
    }
    return assertNever(followUp.action);
  });
  return [
    ...providerCommands,
    stationCommand(input.cli, configPath, ["reconcile", "--reason", "update-convergence"]),
    ...recoveryCommands(input, configPath),
  ];
}

function assertNever(value: never): never {
  throw new Error(`Unexpected hook follow-up: ${String(value)}`);
}
