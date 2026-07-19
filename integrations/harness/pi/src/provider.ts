import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessLaunchPlan,
  HarnessProvider,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  createTerminalBoundHarnessProvider,
  harnessCommand,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { classifyPiRunStatus } from "./classify.js";
import { PiHarnessProviderError, piProviderErrorFromUnknown } from "./errors.js";
import { normalizePiRawEvent } from "./event/mapping.js";
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
  canClassifyStatus: true,
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: false,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: true,
};

const minimumPiVersion = [0, 80, 5] as const;
const minimumPiVersionText = minimumPiVersion.join(".");

const piSpec: TerminalBoundHarnessProviderSpec<PiHarnessProviderOptions> = {
  id: "pi",
  displayName: "Pi",
  commandEnvVar: "STATION_PI_BIN",
  commandFallback: "pi",
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
  classifyRun: (run) => classifyPiRunStatus(run),
  ingestEvent: {
    operation: "provider.pi.ingestEvent",
    errorCode: "HARNESS_PI_EVENT_INGEST_FAILED",
    errorMessage: "The Pi harness provider failed to ingest an event.",
    normalize: (event, context) => normalizePiRawEvent(event, context),
  },
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

function command(options: PiHarnessProviderOptions): string {
  return harnessCommand(options, "STATION_PI_BIN", "pi");
}

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
  return buildPiLaunchPlan(request, launchOptions);
}

export function createPiHarnessProvider(options: PiHarnessProviderOptions = {}): HarnessProvider {
  return createTerminalBoundHarnessProvider(piSpec, options);
}
