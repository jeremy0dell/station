import type { HarnessCapabilities } from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  TerminalBoundHarnessProvider,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { classifyPiRunStatus } from "./classify.js";
import { normalizePiRawEvent } from "./event/mapping.js";
import { buildPiLaunchPlan, type PiLaunchOptions } from "./launch.js";

export type PiHarnessProviderOptions = CommonHarnessProviderOptions & {
  extensionPath?: string;
  configPath?: string;
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
  supportsModifiedEnterSoftNewline: false,
};

const piProviderSpec = {
  id: "pi",
  displayName: "Pi",
  command: {
    envVar: "STATION_PI_BIN",
    fallback: "pi",
  },
  baseCapabilities,
  health: {
    args: ["--version"],
    unavailable: {
      code: "HARNESS_PI_UNAVAILABLE",
      message: "Pi is not available.",
      hint: "Install Pi or configure [harness.pi].command.",
    },
    diagnostics: () => ({
      command: "pi --version succeeded",
    }),
  },
  buildLaunchOptions: (options, command) => {
    const launchOptions: PiLaunchOptions = { command };
    if (options.extensionPath !== undefined) launchOptions.extensionPath = options.extensionPath;
    if (options.configPath !== undefined) launchOptions.configPath = options.configPath;
    if (options.observerSocketPath !== undefined) {
      launchOptions.observerSocketPath = options.observerSocketPath;
    }
    if (options.stateDir !== undefined) launchOptions.stateDir = options.stateDir;
    if (options.hookSpoolDir !== undefined) launchOptions.hookSpoolDir = options.hookSpoolDir;
    return launchOptions;
  },
  buildLaunch: buildPiLaunchPlan,
  classifyRun: (run) => classifyPiRunStatus(run),
  normalizeEvent: normalizePiRawEvent,
} satisfies TerminalBoundHarnessProviderSpec<PiHarnessProviderOptions, PiLaunchOptions>;

export class PiHarnessProvider extends TerminalBoundHarnessProvider<
  PiHarnessProviderOptions,
  PiLaunchOptions
> {
  constructor(options: PiHarnessProviderOptions = {}) {
    super(piProviderSpec, options);
  }
}
