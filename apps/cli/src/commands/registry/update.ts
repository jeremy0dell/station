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
  createUpdateRecoveryPreflightPorts,
  createUpdateRuntimeCapabilities,
} from "../../update/recoveryPreflightAdapters.js";
import { runUpdateSuccessorTransport } from "../../update/successorExecution.js";
import { loadedConfigCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runUpdateCommand, runUpdateSuccessorCommand, type UpdateCommandDeps } from "../update.js";

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
  const loaded = loadedConfigCommandOptions(context);
  const deps = updateDeps(context, loaded);
  if (context.args.length === 1 && context.args[0] === "--successor") {
    const stdin = context.options.stdin ?? (await readStdinIfAvailable({ maxBytes: 64 * 1024 }));
    return runUpdateSuccessorCommand({
      ...(stdin === undefined ? {} : { stdin }),
      options: {
        config: loaded.config,
        cliEntryPath: context.cliEntryPath,
        ...(loaded.configPath === undefined ? {} : { configPath: loaded.configPath }),
        ...(context.options.env === undefined ? {} : { env: context.options.env }),
      },
      deps,
    });
  }
  return runUpdateCommand(
    context.args,
    {
      config: loaded.config,
      cliEntryPath: context.cliEntryPath,
      ...(loaded.configPath === undefined ? {} : { configPath: loaded.configPath }),
      ...(context.options.env === undefined ? {} : { env: context.options.env }),
    },
    deps,
  );
}

function updateDeps(
  context: CliCommandRunContext,
  loaded: ReturnType<typeof loadedConfigCommandOptions>,
): UpdateCommandDeps {
  const hostDeps = context.options.updateDeps?.hostDeps ?? context.options.hostDeps;
  const deps: UpdateCommandDeps = {
    ...context.options.updateDeps,
    ...(hostDeps === undefined ? {} : { hostDeps }),
  };
  const currentBuildInfo = deps.currentBuildInfo ?? (deps.buildInfo ?? stationBuildInfo)();
  deps.currentBuildInfo = currentBuildInfo;
  deps.probes ??= createDefaultUpdateProbes(
    {
      cliEntryPath: context.cliEntryPath,
      ...(context.options.env === undefined ? {} : { env: context.options.env }),
    },
    {
      buildInfo: currentBuildInfo,
      ...(deps.executablePath === undefined ? {} : { executablePath: deps.executablePath }),
      ...(deps.commandRunner === undefined ? {} : { commandRunner: deps.commandRunner }),
    },
  );
  deps.providers ??= createProviderRegistry(loaded.config, registryOptions(loaded));
  if (deps.recoveryPreflight === undefined) {
    deps.recoveryPreflight = (input) => {
      const preflightOptions: Parameters<typeof createUpdateRecoveryPreflightPorts>[0] = {
        config: loaded.config,
        providers: deps.providers as NonNullable<UpdateCommandDeps["providers"]>,
        currentBuildInfo: input.currentBuildInfo,
      };
      if (loaded.configPath !== undefined) preflightOptions.configPath = loaded.configPath;
      if (hostDeps?.inspectHost !== undefined) preflightOptions.inspectHost = hostDeps.inspectHost;
      const ports = createUpdateRecoveryPreflightPorts(preflightOptions);
      return runUpdateRecoveryPreflight({ ...input, ports });
    };
  }
  const runtimeCapabilities = createUpdateRuntimeCapabilities({
    config: loaded.config,
    ...(loaded.configPath === undefined ? {} : { configPath: loaded.configPath }),
    ...(deps.providers === undefined ? {} : { providers: deps.providers }),
    ...(hostDeps === undefined ? {} : { hostDeps }),
    ...(deps.convergeObserver === undefined ? {} : { convergeObserver: deps.convergeObserver }),
    ...(deps.reconcileHook === undefined ? {} : { reconcileHook: deps.reconcileHook }),
    ...(deps.convergeHost === undefined ? {} : { convergeHost: deps.convergeHost }),
    ...(deps.reconcilePersisted === undefined
      ? {}
      : { reconcilePersisted: deps.reconcilePersisted }),
  });
  deps.convergeObserver ??= runtimeCapabilities.convergeObserver;
  deps.reconcileHook ??= runtimeCapabilities.reconcileHook;
  deps.convergeHost ??= runtimeCapabilities.convergeHost;
  deps.reconcilePersisted ??= runtimeCapabilities.reconcilePersisted;
  deps.runSuccessor ??= (input) => {
    const request: UpdateSuccessorRequest = {
      schemaVersion: 1,
      channel: input.channel,
      target: input.target,
      handoff:
        input.handoff === undefined
          ? { action: "leave-in-place" }
          : { action: "preserve", fidelity: input.handoff },
      hookProviderIds: [...input.hookProviderIds],
    };
    return runUpdateSuccessorTransport({
      launcher: input.launcher,
      request,
      ...(loaded.configPath === undefined ? {} : { configPath: loaded.configPath }),
      ...(deps.commandRunner === undefined ? {} : { commandRunner: deps.commandRunner }),
    }).then((receipt) => ({
      status: receipt.status,
      finalInspection: receipt.finalInspection,
      hookReconciliations: receipt.hookReconciliations,
      steps: receipt.actions.map((action) => ({
        id: action.id,
        status: action.status,
        detail: action.detail,
      })),
      ...(receipt.status === "failed"
        ? {
            recoveryCommands: [
              retrySuccessorCommand(
                input.launcher,
                loaded.configPath,
                input.channel,
                input.handoff,
              ),
            ],
          }
        : {}),
      ...(receipt.error === undefined ? {} : { error: receipt.error }),
    }));
  };
  return deps;
}

function registryOptions(
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
  return [
    command,
    ...prefix,
    ...(configPath === undefined ? [] : ["--config", configPath]),
    "update",
    "--channel",
    channel,
    ...(handoff === undefined ? ["--no-handoff"] : [`--handoff=${handoff}`]),
  ];
}
