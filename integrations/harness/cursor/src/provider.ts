import type { HarnessCapabilities } from "@station/contracts";
import {
  type CommonHarnessProviderOptions,
  hookOptions,
  TerminalBoundHarnessProvider,
  type TerminalBoundHarnessProviderSpec,
} from "@station/harness-shared";
import { classifyCursorRunStatus } from "./classify.js";
import { normalizeCursorRawEvent } from "./events.js";
import { doctorCursorHooks } from "./hooks.js";
import { buildCursorLaunchPlan, type CursorLaunchOptions } from "./launch.js";

export type CursorHarnessProviderOptions = CommonHarnessProviderOptions & {
  configPath?: string;
};

type CursorHookOptions = Parameters<typeof doctorCursorHooks>[0];
type CursorHookResult = Awaited<ReturnType<typeof doctorCursorHooks>>;

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

const cursorProviderSpec = {
  id: "cursor",
  displayName: "Cursor",
  command: {
    envVar: "STATION_CURSOR_AGENT_BIN",
    fallback: "agent",
  },
  baseCapabilities,
  health: {
    args: ["--version"],
    unavailable: {
      code: "HARNESS_CURSOR_UNAVAILABLE",
      message: "Cursor Agent is not available.",
      hint: "Install Cursor Agent or configure [harness.cursor].command.",
    },
    diagnostics: () => ({
      command: "agent --version succeeded",
      observation: "hooks",
    }),
  },
  hooks: {
    doctor: doctorCursorHooks,
    buildOptions: (options, context) => hookOptions(options, context),
    checkName: "cursor-hooks",
    failure: {
      tag: "CursorHookSetupError",
      code: "CURSOR_HOOK_DIAGNOSTIC_FAILED",
      message: "Cursor hook diagnostics failed.",
    },
    formatCheckMessage: (result) =>
      `${result.message} Hooks: ${result.hooksPath}. Script: ${result.hookScriptPath}.`,
  },
  buildLaunchOptions: (_options, command) => ({ command }),
  buildLaunch: buildCursorLaunchPlan,
  classifyRun: (run) => classifyCursorRunStatus(run),
  normalizeEvent: normalizeCursorRawEvent,
} satisfies TerminalBoundHarnessProviderSpec<
  CursorHarnessProviderOptions,
  CursorLaunchOptions,
  CursorHookOptions,
  CursorHookResult
>;

export class CursorHarnessProvider extends TerminalBoundHarnessProvider<
  CursorHarnessProviderOptions,
  CursorLaunchOptions,
  CursorHookOptions,
  CursorHookResult
> {
  constructor(options: CursorHarnessProviderOptions = {}) {
    super(cursorProviderSpec, options);
  }
}
