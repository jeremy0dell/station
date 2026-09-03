import type { UpdateSuccessorRequest } from "@station/contracts";
import { stationBuildInfo } from "@station/runtime";
import {
  type CreateProviderRegistryOptions,
  createProviderRegistry,
} from "../../observerProviders.js";
import { readStdinIfAvailable } from "../../stdin.js";
import { createDefaultUpdateProbes } from "../../update/defaultUpdateProbes.js";
import { runUpdateRecoveryPreflight } from "../../update/recoveryPreflight.js";
import {
  type CreateUpdateRecoveryPreflightPortsOptions,
  type CreateUpdateRuntimeCapabilitiesOptions,
  createUpdateRecoveryPreflightPorts,
  createUpdateRuntimeCapabilities,
} from "../../update/recoveryPreflightAdapters.js";
import {
  runUpdateSuccessorTransport,
  sealUpdateSuccessorOutput,
  UPDATE_SUCCESSOR_PRIVATE_ENV,
  type UpdateSuccessorTransportInput,
  updateSuccessorTransportKeyIsValid,
} from "../../update/successorExecution.js";
import { loadedConfigCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import {
  runUpdateCommand,
  runUpdateSuccessorCommand,
  type UpdateCommandDeps,
  type UpdateCommandOptions,
  type UpdateSuccessorRunner,
} from "../update.js";

type UpdateSuccessorResult = Awaited<ReturnType<UpdateSuccessorRunner>>;

export const updateCliCommand: CliCommandNode = {
  name: "update",
  description: "Plan or apply an update through the installation's owning channel.",
  requiresConfig: true,
  run: runUpdateCliCommand,
  usage: [
    "stn update [--channel <id>] [--dry-run] [--reap] [--json] [--drive-package-manager] [--handoff[=processes|screen] | --no-handoff]",
  ],
  options: [
    {
      name: "--channel <id>",
      description: "Require installer-binary, dev-checkout, homebrew, npm-global, or mise.",
    },
    { name: "--dry-run", description: "Print the complete plan without applying it." },
    {
      name: "--reap",
      description:
        "With --dry-run, keep read-only behavior; every dry run includes recovery facts.",
    },
    { name: "--json", description: "Print the update plan or result as JSON." },
    {
      name: "--drive-package-manager",
      description: "Run the detected package manager command instead of deferring it.",
    },
    {
      name: "--handoff[=processes|screen]",
      description: "Explicitly preserve live Host state; bare --handoff uses processes fidelity.",
    },
    {
      name: "--no-handoff",
      description: "Update without preserving a busy Host; the next TUI may refuse it.",
    },
  ],
  examples: [
    "stn update --dry-run",
    "stn update --dry-run --json",
    "stn update --dry-run --reap --json",
    "stn update --drive-package-manager",
    "stn update --handoff=screen",
  ],
  notes: [
    "Package-managed installations defer by default and print the exact manager command.",
    "A committed update restarts the Observer before the default processes Host handoff.",
    "Non-dry-run --reap is reserved for the later destructive executor and is rejected before update detection.",
  ],
  verification: ["stn update --dry-run --json"],
};

async function runUpdateCliCommand(context: CliCommandRunContext) {
  if (isSuccessorInvocation(context.args)) {
    const successorTransportKey = consumeSuccessorTransportKey(context);
    try {
      return await runProtectedUpdateSuccessor(context, successorTransportKey);
    } catch {
      return {
        code: 1,
        output: sealUpdateSuccessorOutput(
          {
            error: {
              tag: "UpdateError",
              code: "UPDATE_SUCCESSOR_BOUNDARY_FAILED",
              message: "The protected update successor boundary failed.",
            },
          },
          successorTransportKey,
        ),
      };
    }
  }
  const loaded = loadedConfigCommandOptions(context);
  const options = updateCommandOptions(context, loaded);
  const deps = createUpdateDeps(context, loaded);
  return runUpdateCommand(context.args, options, deps);
}

async function runProtectedUpdateSuccessor(
  context: CliCommandRunContext,
  successorTransportKey: string,
) {
  const loaded = loadedConfigCommandOptions(context);
  const options = updateCommandOptions(context, loaded);
  const deps = createUpdateDeps(context, loaded);
  const stdin = context.options.stdin ?? (await readStdinIfAvailable({ maxBytes: 64 * 1024 }));
  const input: Parameters<typeof runUpdateSuccessorCommand>[0] = { options, deps };
  if (stdin !== undefined) input.stdin = stdin;
  const result = await runUpdateSuccessorCommand(input);
  return {
    ...result,
    output: sealUpdateSuccessorOutput(result.output, successorTransportKey),
  };
}

function consumeSuccessorTransportKey(context: CliCommandRunContext): string {
  const env = context.options.env ?? process.env;
  const transportKey = env[UPDATE_SUCCESSOR_PRIVATE_ENV];
  delete env[UPDATE_SUCCESSOR_PRIVATE_ENV];
  delete process.env[UPDATE_SUCCESSOR_PRIVATE_ENV];
  if (!updateSuccessorTransportKeyIsValid(transportKey)) {
    throw new Error("Update successor is a private transport command.");
  }
  return transportKey;
}

function updateCommandOptions(
  context: CliCommandRunContext,
  loaded: ReturnType<typeof loadedConfigCommandOptions>,
): UpdateCommandOptions {
  const options: UpdateCommandOptions = {
    config: loaded.config,
    cliEntryPath: context.cliEntryPath,
  };
  if (loaded.configPath !== undefined) options.configPath = loaded.configPath;
  if (context.options.env !== undefined) options.env = context.options.env;
  return options;
}

function isSuccessorInvocation(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === "--successor";
}

/** COMPOSITION ROOT: assembles one update invocation's read and mutation capabilities. */
function createUpdateDeps(
  context: CliCommandRunContext,
  loaded: ReturnType<typeof loadedConfigCommandOptions>,
): UpdateCommandDeps {
  const suppliedDeps = context.options.updateDeps ?? {};
  const hostDeps = suppliedDeps.hostDeps ?? context.options.hostDeps;
  const currentBuildInfo =
    suppliedDeps.currentBuildInfo ?? (suppliedDeps.buildInfo ?? stationBuildInfo)();
  const probes = suppliedDeps.probes ?? createUpdateProbes(context, suppliedDeps, currentBuildInfo);
  const providers =
    suppliedDeps.providers ??
    createProviderRegistry(loaded.config, providerRegistryOptions(loaded));
  const recoveryPreflight =
    suppliedDeps.recoveryPreflight ?? createRecoveryPreflight(loaded, providers, hostDeps);
  const capabilities = createRuntimeCapabilities(loaded, suppliedDeps, providers, hostDeps);

  const deps: UpdateCommandDeps = {
    ...suppliedDeps,
    currentBuildInfo,
    probes,
    providers,
    recoveryPreflight,
    convergeObserver: suppliedDeps.convergeObserver ?? capabilities.convergeObserver,
    reconcileHook: suppliedDeps.reconcileHook ?? capabilities.reconcileHook,
    convergeHost: suppliedDeps.convergeHost ?? capabilities.convergeHost,
    reconcilePersisted: suppliedDeps.reconcilePersisted ?? capabilities.reconcilePersisted,
  };
  if (hostDeps !== undefined) deps.hostDeps = hostDeps;
  deps.runSuccessor = suppliedDeps.runSuccessor ?? createSuccessorRunner(loaded, suppliedDeps);
  return deps;
}

function createUpdateProbes(
  context: CliCommandRunContext,
  suppliedDeps: UpdateCommandDeps,
  currentBuildInfo: NonNullable<UpdateCommandDeps["currentBuildInfo"]>,
) {
  const options: Parameters<typeof createDefaultUpdateProbes>[0] = {
    cliEntryPath: context.cliEntryPath,
  };
  if (context.options.env !== undefined) options.env = context.options.env;
  const probeDeps: Parameters<typeof createDefaultUpdateProbes>[1] = {
    buildInfo: currentBuildInfo,
  };
  if (suppliedDeps.executablePath !== undefined) {
    probeDeps.executablePath = suppliedDeps.executablePath;
  }
  if (suppliedDeps.commandRunner !== undefined)
    probeDeps.commandRunner = suppliedDeps.commandRunner;
  return createDefaultUpdateProbes(options, probeDeps);
}

function createRecoveryPreflight(
  loaded: ReturnType<typeof loadedConfigCommandOptions>,
  providers: NonNullable<UpdateCommandDeps["providers"]>,
  hostDeps: UpdateCommandDeps["hostDeps"],
): NonNullable<UpdateCommandDeps["recoveryPreflight"]> {
  return (input) => {
    const options: CreateUpdateRecoveryPreflightPortsOptions = {
      config: loaded.config,
      providers,
      currentBuildArtifact: input.currentBuildArtifact,
      currentBuildInfo: input.currentBuildInfo,
    };
    if (loaded.configPath !== undefined) options.configPath = loaded.configPath;
    if (hostDeps?.inspectHost !== undefined) options.inspectHost = hostDeps.inspectHost;
    const ports = createUpdateRecoveryPreflightPorts(options);
    return runUpdateRecoveryPreflight({ ...input, ports });
  };
}

function createRuntimeCapabilities(
  loaded: ReturnType<typeof loadedConfigCommandOptions>,
  suppliedDeps: UpdateCommandDeps,
  providers: NonNullable<UpdateCommandDeps["providers"]>,
  hostDeps: UpdateCommandDeps["hostDeps"],
) {
  const options: CreateUpdateRuntimeCapabilitiesOptions = {
    config: loaded.config,
    providers,
  };
  if (loaded.configPath !== undefined) options.configPath = loaded.configPath;
  if (hostDeps !== undefined) options.hostDeps = hostDeps;
  if (suppliedDeps.convergeObserver !== undefined) {
    options.convergeObserver = suppliedDeps.convergeObserver;
  }
  if (suppliedDeps.reconcileHook !== undefined) options.reconcileHook = suppliedDeps.reconcileHook;
  if (suppliedDeps.convergeHost !== undefined) options.convergeHost = suppliedDeps.convergeHost;
  if (suppliedDeps.reconcilePersisted !== undefined) {
    options.reconcilePersisted = suppliedDeps.reconcilePersisted;
  }
  return createUpdateRuntimeCapabilities(options);
}

function createSuccessorRunner(
  loaded: ReturnType<typeof loadedConfigCommandOptions>,
  suppliedDeps: UpdateCommandDeps,
): NonNullable<UpdateCommandDeps["runSuccessor"]> {
  return async (input) => {
    const handoff: UpdateSuccessorRequest["handoff"] =
      input.handoff === undefined
        ? { action: "leave-in-place" }
        : { action: "preserve", fidelity: input.handoff };
    const request: UpdateSuccessorRequest = {
      schemaVersion: 1,
      channel: input.channel,
      target: input.target,
      installedScopeDigest: input.installedScopeDigest,
      handoff,
      hookProviderIds: [...input.hookProviderIds],
    };
    const transportOptions: UpdateSuccessorTransportInput = {
      launcher: input.launcher,
      request,
    };
    if (loaded.configPath !== undefined) transportOptions.configPath = loaded.configPath;
    if (suppliedDeps.commandRunner !== undefined) {
      transportOptions.commandRunner = suppliedDeps.commandRunner;
    }
    const receipt = await runUpdateSuccessorTransport(transportOptions);
    const result: UpdateSuccessorResult = {
      status: receipt.status,
      finalInspection: receipt.finalInspection,
      hookReconciliations: receipt.hookReconciliations,
      parkedTerminals: receipt.parkedTerminals,
      steps: receipt.actions.map((action) => ({
        id: action.id,
        status: action.status,
        detail: action.detail,
      })),
    };
    if (receipt.status === "failed") {
      result.recoveryCommands = [
        retrySuccessorCommand(input.launcher, loaded.configPath, input.channel, input.handoff),
      ];
    }
    if (receipt.error !== undefined) result.error = receipt.error;
    return result;
  };
}

function providerRegistryOptions(
  loaded: ReturnType<typeof loadedConfigCommandOptions>,
): CreateProviderRegistryOptions {
  const options: CreateProviderRegistryOptions = {};
  if (loaded.configPath !== undefined) options.configPath = loaded.configPath;
  if (loaded.providerHookIngressLauncher !== undefined) {
    options.providerHookIngressLauncher = loaded.providerHookIngressLauncher;
  }
  if (loaded.providerHookArtifactOwner !== undefined) {
    options.providerHookArtifactOwner = loaded.providerHookArtifactOwner;
  }
  return options;
}

function retrySuccessorCommand(
  launcher: readonly [string, ...string[]],
  configPath: string | undefined,
  channel: UpdateSuccessorRequest["channel"],
  handoff: "processes" | "screen" | undefined,
): readonly [string, ...string[]] {
  const [command, ...prefix] = launcher;
  const retryCommand: [string, ...string[]] = [command, ...prefix];
  if (configPath !== undefined) retryCommand.push("--config", configPath);
  retryCommand.push("update", "--channel", channel);
  retryCommand.push(handoff === undefined ? "--no-handoff" : `--handoff=${handoff}`);
  return retryCommand;
}
