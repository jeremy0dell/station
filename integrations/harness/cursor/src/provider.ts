import type {
  BuildHarnessLaunchRequest,
  HarnessCapabilities,
  HarnessHooksStatus,
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
  harnessHooksStatusFrom,
  hookDoctorCheck,
  type TerminalBoundHarnessCommandDefinition,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { runExternalCommand, safeErrorFromUnknown } from "@station/runtime";
import { z } from "zod";
import { cursorProviderErrorFromUnknown } from "./errors.js";
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
  canReceivePrompt: false,
  canResume: false,
  canStop: false,
  canRunNonInteractive: false,
  canExposeApprovalState: false,
  supportsModifiedEnterSoftNewline: false,
};

export const cursorHarnessCommandDefinition = {
  id: "cursor",
  displayName: "Cursor",
  commandEnvVar: "STATION_CURSOR_AGENT_BIN",
  commandFallback: "agent",
} as const satisfies TerminalBoundHarnessCommandDefinition;

const CursorAuthStatusSchema = z
  .object({
    status: z.enum(["authenticated", "unauthenticated"]),
    isAuthenticated: z.boolean(),
    hasAccessToken: z.boolean(),
    hasRefreshToken: z.boolean(),
    message: z.string().optional(),
    userInfo: z.unknown().optional(),
  })
  .strict();

const cursorSpec: TerminalBoundHarnessProviderSpec<CursorHarnessProviderOptions> = {
  ...cursorHarnessCommandDefinition,
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
  unknownStatusReason: "Cursor run has no reliable Cursor hook status signal yet.",
  doctorChecks,
  hooksStatus,
};

function command(options: CursorHarnessProviderOptions): string {
  return harnessCommand(
    options,
    cursorHarnessCommandDefinition.commandEnvVar,
    cursorHarnessCommandDefinition.commandFallback,
  );
}

function buildLaunch(
  options: CursorHarnessProviderOptions,
  request: BuildHarnessLaunchRequest,
): HarnessLaunchPlan {
  const launchOptions: CursorLaunchOptions = { command: command(options) };
  if (options.configPath !== undefined) launchOptions.configPath = options.configPath;
  if (options.observerSocketPath !== undefined) {
    launchOptions.observerSocketPath = options.observerSocketPath;
  }
  if (options.stateDir !== undefined) launchOptions.stateDir = options.stateDir;
  if (options.hookSpoolDir !== undefined) launchOptions.hookSpoolDir = options.hookSpoolDir;
  return buildCursorLaunchPlan(request, launchOptions);
}

async function doctorChecks(
  options: CursorHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<ProviderDoctorCheck[]> {
  const checks: ProviderDoctorCheck[] = [];
  try {
    const result = await runExternalCommand(
      {
        command: command(options),
        args: ["status", "--format", "json"],
        timeoutMs: options.timeoutMs ?? 5000,
        maxOutputChars: 4096,
      },
      options.runner,
    );
    const auth = CursorAuthStatusSchema.parse(JSON.parse(result.stdout));
    checks.push(
      auth.isAuthenticated
        ? {
            name: "cursor.auth",
            status: "ok",
            message: "Cursor Agent authentication is available.",
          }
        : {
            name: "cursor.auth",
            status: "warn",
            message:
              "Cursor Agent is not logged in. Run `agent login` in the configured Cursor home before launching.",
          },
    );
  } catch (cause) {
    checks.push({
      name: "cursor.auth",
      status: "warn",
      message: "Cursor Agent authentication status could not be determined.",
      error: safeErrorFromUnknown(cause, {
        tag: "HarnessProviderError",
        code: "HARNESS_CURSOR_UNAVAILABLE",
        message: "Cursor Agent authentication diagnostics failed.",
        provider: "cursor",
      }),
    });
  }

  checks.push(
    await hookDoctorCheck({
      name: "cursor-hooks",
      run: () => doctorCursorHooks(cursorHookDoctorOptions(options, context)),
      describe: (result) =>
        `${result.message} Hooks: ${result.hooksPath}. Script: ${result.hookScriptPath}.`,
      failure: {
        tag: "CursorHookSetupError",
        code: "CURSOR_HOOK_DIAGNOSTIC_FAILED",
        message: "Cursor hook diagnostics failed.",
        provider: "cursor",
      },
    }),
  );
  return checks;
}

function cursorHookDoctorOptions(
  options: CursorHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Parameters<typeof doctorCursorHooks>[0] {
  const hookOptions = harnessHookDoctorOptions(options, context);
  if (
    context?.providerHookRuntime === undefined &&
    hookOptions.stationConfigPath === undefined &&
    options.configPath !== undefined
  ) {
    hookOptions.stationConfigPath = options.configPath;
  }
  return hookOptions;
}

async function hooksStatus(
  options: CursorHarnessProviderOptions,
  context?: ProviderDoctorContext,
): Promise<HarnessHooksStatus> {
  const hookResult = await doctorCursorHooks(cursorHookDoctorOptions(options, context));
  return harnessHooksStatusFrom("cursor", options.installHooks === true, hookResult);
}

/**
 * ADAPTER
 *
 * Supplies Cursor launch, discovery, hook-installation status, diagnostics, and event normalization
 * through the harness port.
 */
export function createCursorHarnessProvider(
  options: CursorHarnessProviderOptions = {},
): HarnessProvider {
  return createTerminalBoundHarnessProvider(cursorSpec, options);
}
