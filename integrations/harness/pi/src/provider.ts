import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessLaunchPlan,
  HarnessProvider,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  createTerminalBoundHarnessProvider,
  harnessCommandResolver,
  type TerminalBoundHarnessCommandDefinition,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { PiHarnessProviderError, piProviderErrorFromUnknown } from "./errors.js";
import { buildPiLaunchPlan } from "./launch.js";

export type PiHarnessProviderOptions = CommonHarnessProviderOptions & {
  extensionPath?: string;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  resume?: boolean;
};

const baseCapabilities: HarnessCapabilities = {
  canLaunch: true,
  canDiscoverRuns: true,
  canEmitEvents: true,
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: false,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: true,
};

const minimumPiVersion = [0, 80, 5] as const;
const minimumPiVersionText = minimumPiVersion.join(".");

export const piHarnessCommandDefinition = {
  id: "pi",
  displayName: "Pi",
  commandEnvVar: "STATION_PI_BIN",
  commandFallback: "pi",
} as const satisfies TerminalBoundHarnessCommandDefinition;

const piSpec: TerminalBoundHarnessProviderSpec<PiHarnessProviderOptions> = {
  ...piHarnessCommandDefinition,
  baseCapabilities,
  // Adapter support alone is not enough; resume stays invisible unless explicitly enabled
  // by [harness.pi].resume.
  resumeFromOptions: (options) => options.resume === true,
  health: {
    args: ["--version"],
    diagnostics: (result) => piHealthDiagnostics(result.stdout),
    unavailableError: (error) =>
      piProviderErrorFromUnknown(error, {
        code: "HARNESS_PI_UNAVAILABLE",
        message: "Pi is not available.",
        hint: "Install Pi or configure [harness.pi].command.",
      }),
  },
  buildLaunch,
  unknownStatusReason: "Pi run has no reliable Pi status signal yet.",
};

function piHealthDiagnostics(output: string): Record<string, string> {
  const match = output.trim().match(/^(?:pi\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/i);
  if (match === null) {
    throw new PiHarnessProviderError(
      "HARNESS_PI_VERSION_UNSUPPORTED",
      "Station could not determine the installed Pi version.",
      { hint: `Install Pi ${minimumPiVersionText} or newer.` },
    );
  }

  const installed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (compareVersion(installed, minimumPiVersion) < 0) {
    throw new PiHarnessProviderError(
      "HARNESS_PI_VERSION_UNSUPPORTED",
      `Pi ${installed.join(".")} does not emit the settlement event Station requires.`,
      { hint: `Install Pi ${minimumPiVersionText} or newer.` },
    );
  }

  return {
    command: "pi --version succeeded",
    installedVersion: installed.join("."),
    minimumVersion: minimumPiVersionText,
  };
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const command = harnessCommandResolver(piHarnessCommandDefinition);

function buildLaunch(
  options: PiHarnessProviderOptions,
  request: BuildHarnessLaunchRequest,
): HarnessLaunchPlan {
  const launchOptions: Parameters<typeof buildPiLaunchPlan>[1] = { command: command(options) };
  if (options.extensionPath !== undefined) {
    launchOptions.extensionPath = options.extensionPath;
  }
  if (options.configPath !== undefined) {
    launchOptions.configPath = options.configPath;
  }
  if (options.observerSocketPath !== undefined) {
    launchOptions.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) {
    launchOptions.stateDir = options.stateDir;
  }
  if (options.hookSpoolDir !== undefined) {
    launchOptions.hookSpoolDir = options.hookSpoolDir;
  }
  if (options.hookBin !== undefined) {
    launchOptions.hookBin = options.hookBin;
  }
  return buildPiLaunchPlan(request, launchOptions);
}

export function createPiHarnessProvider(options: PiHarnessProviderOptions = {}): HarnessProvider {
  return createTerminalBoundHarnessProvider(piSpec, options);
}
