import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessLaunchPlan,
  HarnessProvider,
  ProviderDoctorCheck,
  ProviderDoctorContext,
} from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  createTerminalBoundHarnessProvider,
  harnessCommand,
  harnessHookDoctorOptions,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { safeErrorFromUnknown } from "@station/runtime";
import { classifyCursorRunStatus } from "./classify.js";
import { cursorProviderErrorFromUnknown } from "./errors.js";
import { normalizeCursorRawEvent } from "./events.js";
import { doctorCursorHooks } from "./hooks.js";
import { buildCursorLaunchPlan, type CursorLaunchOptions } from "./launch.js";

export type CursorHarnessProviderOptions = CommonHarnessProviderOptions & {
  installHooks?: boolean;
  configPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  autoStartFromHooks?: boolean;
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
  supportsModifiedEnterSoftNewline: false,
};

const cursorSpec: TerminalBoundHarnessProviderSpec<CursorHarnessProviderOptions> = {
  id: "cursor",
  displayName: "Cursor",
  commandEnvVar: "STATION_CURSOR_AGENT_BIN",
  commandFallback: "agent",
  baseCapabilities,
  // Adapter support alone is not enough; resume stays invisible unless explicitly enabled
  // by [harness.cursor].resume.
  resumeFromOptions: (options) => options.resume === true,
  health: {
    args: ["--version"],
    diagnostics: () => ({ command: "agent --version succeeded", observation: "hooks" }),
    unavailableError: (error) =>
      cursorProviderErrorFromUnknown(error, {
        code: "HARNESS_CURSOR_UNAVAILABLE",
        message: "Cursor Agent is not available.",
        hint: "Install Cursor Agent or configure [harness.cursor].command.",
      }),
  },
  buildLaunch,
  classifyRun: (run) => classifyCursorRunStatus(run),
  ingestEvent: {
    operation: "provider.cursor.ingestEvent",
    errorCode: "HARNESS_CURSOR_EVENT_INGEST_FAILED",
    errorMessage: "The Cursor harness provider failed to ingest an event.",
    normalize: (event, context) => normalizeCursorRawEvent(event, context),
  },
  doctorChecks,
};

function command(options: CursorHarnessProviderOptions): string {
  return harnessCommand(options, "STATION_CURSOR_AGENT_BIN", "agent");
}

function buildLaunch(
  options: CursorHarnessProviderOptions,
  request: BuildHarnessLaunchRequest,
): HarnessLaunchPlan {
  const launchOptions: CursorLaunchOptions = { command: command(options) };
  return buildCursorLaunchPlan(request, launchOptions);
}

async function doctorChecks(
  options: CursorHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<ProviderDoctorCheck[]> {
  try {
    const hookOptions = harnessHookDoctorOptions(options, context);
    if (
      context?.providerHookRuntime === undefined &&
      hookOptions.stationConfigPath === undefined &&
      options.configPath !== undefined
    ) {
      hookOptions.stationConfigPath = options.configPath;
    }
    const hookResult = await doctorCursorHooks(hookOptions);
    return [
      {
        name: "cursor-hooks",
        status: hookResult.status,
        message: `${hookResult.message} Hooks: ${hookResult.hooksPath}. Script: ${hookResult.hookScriptPath}.`,
      },
    ];
  } catch (cause) {
    return [
      {
        name: "cursor-hooks",
        status: "error",
        message: "Cursor hook diagnostics failed.",
        error: safeErrorFromUnknown(cause, {
          tag: "CursorHookSetupError",
          code: "CURSOR_HOOK_DIAGNOSTIC_FAILED",
          message: "Cursor hook diagnostics failed.",
          provider: "cursor",
        }),
      },
    ];
  }
}

/**
 * ADAPTER
 *
 * Supplies Cursor launch, discovery, hook diagnostics, and event normalization through the harness port.
 */
export function createCursorHarnessProvider(
  options: CursorHarnessProviderOptions = {},
): HarnessProvider {
  return createTerminalBoundHarnessProvider(cursorSpec, options);
}
