import { stationBuildInfo, stationObserverBuildVersion } from "@station/runtime";
import { observerBootLogPath } from "../../observerProcess/spawn.js";
import {
  type CreateProviderRegistryOptions,
  createProviderRegistry,
} from "../../observerProviders.js";
import { resolveObserverPaths } from "../../paths.js";
import { createDefaultUpdateProbes } from "../../update/defaultUpdateProbes.js";
import { createPublicUpdateReport } from "../../update/publicUpdateReportAdapter.js";
import { inspectUpdateConvergencePreflight } from "../../update/recoveryPreflight.js";
import { createUpdateRecoveryPreflightPorts } from "../../update/recoveryPreflightAdapters.js";
import { runUpdateConvergence } from "../../update/updateConvergenceUseCase.js";
import { createUpdateHostRuntimeAdapter } from "../../update/updateHostRuntimeAdapter.js";
import { createUpdateRuntimeConvergenceAdapter } from "../../update/updateRuntimeConvergenceAdapter.js";
import { createUpdateSuccessorTransportAdapter } from "../../update/updateSuccessorTransportAdapter.js";
import { loadedConfigCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runUpdateCommand, type UpdateCommandDeps } from "../update.js";

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
      description: "With --dry-run, disclose exact terminal-loss and recovery consequences.",
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
  return runUpdateCommand(context.args, createUpdateCommandDeps(context, loaded));
}

/**
 * COMPOSITION ROOT
 *
 * Wires the selected install-channel probes, direct Host runtime, aggregate inspection, remaining
 * runtime children, and pinned successor transport used by the update convergence use case.
 */
export function createUpdateCommandDeps(
  context: CliCommandRunContext,
  loaded: ReturnType<typeof loadedConfigCommandOptions>,
): UpdateCommandDeps {
  const overrides = context.options.updateDeps;
  const hostDeps = overrides?.hostDeps ?? context.options.hostDeps;
  const buildInfo = overrides?.buildInfo ?? stationBuildInfo;
  const host =
    overrides?.host ??
    createUpdateHostRuntimeAdapter(
      { config: loaded.config, buildInfo },
      {
        ...(hostDeps?.clientFactory === undefined ? {} : { clientFactory: hostDeps.clientFactory }),
        ...(hostDeps?.resolveHostCommand === undefined
          ? {}
          : { resolveHostCommand: hostDeps.resolveHostCommand }),
      },
    );
  const configuredInspection = overrides?.convergenceInspection;
  let convergenceInspection = configuredInspection;
  if (convergenceInspection === undefined) {
    const registryOptions: CreateProviderRegistryOptions = {};
    if (loaded.configPath !== undefined) registryOptions.configPath = loaded.configPath;
    if (loaded.providerHookIngressLauncher !== undefined) {
      registryOptions.providerHookIngressLauncher = loaded.providerHookIngressLauncher;
    }
    if (loaded.providerHookArtifactOwner !== undefined) {
      registryOptions.providerHookArtifactOwner = loaded.providerHookArtifactOwner;
    }
    const preflightOptions: Parameters<typeof createUpdateRecoveryPreflightPorts>[0] = {
      config: loaded.config,
      providers: createProviderRegistry(loaded.config, registryOptions),
      inspectHost: host.inspect,
    };
    if (loaded.configPath !== undefined) preflightOptions.configPath = loaded.configPath;
    if (context.options.observerDeps !== undefined) {
      preflightOptions.observerDeps = context.options.observerDeps;
    }
    const ports = createUpdateRecoveryPreflightPorts(preflightOptions);
    convergenceInspection = (input) => inspectUpdateConvergencePreflight({ ...input, ports });
  }
  const commandRunner = overrides?.commandRunner;
  const observerPaths = resolveObserverPaths(loaded.config);
  const adapterOptions = {
    observerSocketPath: observerPaths.socketPath,
    observerBuildSelector: stationObserverBuildVersion(buildInfo()),
    observerBootLogPath: observerBootLogPath(observerPaths),
    ...(loaded.configPath === undefined ? {} : { configPath: loaded.configPath }),
    ...(commandRunner === undefined ? {} : { commandRunner }),
  };
  const probes =
    overrides?.probes ??
    createDefaultUpdateProbes(
      {
        cliEntryPath: context.cliEntryPath,
        ...(context.options.env === undefined ? {} : { env: context.options.env }),
      },
      {
        buildInfo,
        ...(overrides?.executablePath === undefined
          ? {}
          : { executablePath: overrides.executablePath }),
        ...(commandRunner === undefined ? {} : { commandRunner }),
      },
    );
  const runtime = overrides?.runtime ?? createUpdateRuntimeConvergenceAdapter(adapterOptions);
  const successor = overrides?.successor ?? createUpdateSuccessorTransportAdapter(adapterOptions);
  const publicReport = overrides?.publicReport ?? { create: createPublicUpdateReport };
  return {
    convergence: overrides?.convergence ?? {
      run: (request) =>
        runUpdateConvergence(request, {
          convergenceInspection,
          probes,
          buildInfo,
          publicReport,
          host,
          runtime,
          successor,
        }),
    },
  };
}
