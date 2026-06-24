import { readFile, writeFile } from "node:fs/promises";
import {
  appendObserverEventHookBlock,
  removeObserverEventHookBlocksById,
  type StationConfig,
} from "@station/config";
import type { ObserverEventHookConfig } from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandRunner } from "@station/runtime";
import { runExternalCommand, safeErrorFromUnknown } from "@station/runtime";
import type { CliEnv } from "../env.js";

export type EventHooksCommandOptions = {
  config?: StationConfig;
  configPath?: string;
  commandRunner?: ExternalCommandRunner;
  env?: CliEnv;
};

export type EventHookPlanResult = {
  category: "observer-event-hook";
  hookId: string;
  configPath: string;
  changed: boolean;
  installed: boolean;
  before: string;
  after: string;
};

export type EventHookInstallResult = EventHookPlanResult & {
  installed: boolean;
};

export type EventHookDoctorResult = {
  category: "observer-event-hook";
  status: "ok" | "warn";
  installed: boolean;
  hooks: string[];
  message: string;
  commandCheck?: EventHookCommandCheck;
};

export type EventHookCommandCheck = {
  status: "ok" | "warn";
  command: string;
  message: string;
  error?: string;
};

export type EventHooksCommandResult =
  | EventHookPlanResult
  | EventHookInstallResult
  | EventHookDoctorResult;

type ParsedFlags = {
  yes: boolean;
  force: boolean;
};

const builtInHookName = "notify-turn-completion";
const builtInHookId = "notify-agent-idle";
const builtInHookTimeoutMs = 8000;
const builtInHookFilter = {
  agentState: "idle",
  changeSource: "harness_event_report",
  harnessEventType: "Stop",
} satisfies NonNullable<ObserverEventHookConfig["filter"]>;

async function planBuiltInEventHook(
  options: EventHooksCommandOptions,
  flags: ParsedFlags,
): Promise<EventHookPlanResult> {
  const configPath = requiredConfigPath(options);
  const before = await readFile(configPath, "utf8");
  const hooks = options.config?.hooks?.event ?? [];
  const installed = hooks.some((hook) => hook.id === builtInHookId);
  const current = builtInHookIsCurrent(hooks, configPath);
  if (current && !flags.force) {
    return {
      category: "observer-event-hook",
      hookId: builtInHookId,
      configPath,
      changed: false,
      installed: true,
      before,
      after: before,
    };
  }
  const base = installed ? removeObserverEventHookBlocksById(before, builtInHookId) : before;
  const after = appendObserverEventHookBlock(base, builtInEventHookToml(configPath));
  return {
    category: "observer-event-hook",
    hookId: builtInHookId,
    configPath,
    changed: after !== before,
    installed,
    before,
    after,
  };
}

async function doctorEventHooks(options: EventHooksCommandOptions): Promise<EventHookDoctorResult> {
  const config = options.config;
  const hooks = config?.hooks?.event ?? [];
  const ids = hooks.map((hook) => hook.id);
  const builtInHooks = hooks.filter((candidate) => candidate.id === builtInHookId);
  if (builtInHooks.length === 0) {
    return {
      category: "observer-event-hook",
      status: "warn",
      installed: false,
      hooks: ids,
      message: "Built-in turn completion notification event hook is not installed.",
    };
  }
  if (builtInHooks.length > 1) {
    return {
      category: "observer-event-hook",
      status: "warn",
      installed: true,
      hooks: ids,
      commandCheck: {
        status: "warn",
        command: builtInHooks.map(formatHookCommand).join(" ; "),
        message: "Built-in turn completion notification event hook is installed more than once.",
      },
      message:
        "Built-in turn completion notification event hook has duplicate config entries. Run install to replace them.",
    };
  }
  const hook = builtInHooks[0];
  if (hook === undefined) {
    throw new Error("Expected built-in event hook.");
  }
  if (options.configPath !== undefined && !hookMatchesBuiltIn(hook, options.configPath)) {
    return {
      category: "observer-event-hook",
      status: "warn",
      installed: true,
      hooks: ids,
      commandCheck: {
        status: "warn",
        command: formatHookCommand(hook),
        message:
          "Configured notification command does not match the current built-in turn completion notification hook.",
      },
      message:
        "Built-in turn completion notification event hook is stale. Run install to update it.",
    };
  }
  const notifyCommandInput: {
    command: string;
    args: string[];
    timeoutMs: number;
    commandRunner?: ExternalCommandRunner;
    env?: CliEnv;
  } = {
    command: hook.command,
    args: hook.args ?? [],
    timeoutMs: hook.timeoutMs ?? 3000,
  };
  if (options.commandRunner !== undefined) {
    notifyCommandInput.commandRunner = options.commandRunner;
  }
  if (options.env !== undefined) {
    notifyCommandInput.env = options.env;
  }
  const commandCheck = await checkBuiltInNotifyCommand(notifyCommandInput);
  if (commandCheck.status === "warn") {
    return {
      category: "observer-event-hook",
      status: "warn",
      installed: true,
      hooks: ids,
      commandCheck,
      message:
        "Built-in turn completion notification event hook is installed, but its command is not usable.",
    };
  }
  return {
    category: "observer-event-hook",
    status: "ok",
    installed: true,
    hooks: ids,
    commandCheck,
    message: "Built-in turn completion notification event hook is installed.",
  };
}

async function checkBuiltInNotifyCommand(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  commandRunner?: ExternalCommandRunner;
  env?: CliEnv;
}): Promise<EventHookCommandCheck> {
  if (input.command !== "stn") {
    return checkCommandAvailable(input.command, input.args, input.env);
  }
  const invocation = {
    schemaVersion: "0.5.0",
    hookId: `${builtInHookId}-doctor-check`,
    observedAt: "2026-01-01T00:00:00.000Z",
    event: {
      type: "worktree.agentStateChanged",
      worktreeId: "wt_event_hook_doctor_check",
      changeSource: "harness_event_report",
      harnessEventType: "Stop",
      reportId: "report_event_hook_doctor_check",
      agent: {
        harness: "event-hook-doctor",
        state: "working",
        runId: "run_event_hook_doctor_check",
        confidence: "high",
        reason: "Event hook doctor command check.",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  try {
    const commandInput: ExternalCommandInput = {
      command: input.command,
      args: input.args,
      timeoutMs: Math.min(input.timeoutMs, 3000),
      stdin: `${JSON.stringify(invocation)}\n`,
      maxOutputChars: 2000,
    };
    const env = envForExternalCommand(input.env);
    if (env !== undefined) commandInput.env = env;
    await runExternalCommand(commandInput, input.commandRunner);
    return {
      status: "ok",
      command: [input.command, ...input.args].join(" "),
      message: "Configured notification command accepts event hook invocations.",
    };
  } catch (error) {
    const safeError = safeErrorFromUnknown(error, {
      tag: "EventHookError",
      code: "EVENT_HOOK_COMMAND_UNUSABLE",
      message: "Configured notification command is not usable.",
    });
    return {
      status: "warn",
      command: [input.command, ...input.args].join(" "),
      message: "Configured notification command failed the doctor check.",
      error: safeError.message,
    };
  }
}

async function checkCommandAvailable(
  command: string,
  args: string[],
  env: CliEnv | undefined,
): Promise<EventHookCommandCheck> {
  try {
    const commandInput: ExternalCommandInput = {
      command: "sh",
      args: ["-c", 'command -v "$1" >/dev/null', "sh", command],
      timeoutMs: 3000,
      maxOutputChars: 2000,
    };
    const externalEnv = envForExternalCommand(env);
    if (externalEnv !== undefined) commandInput.env = externalEnv;
    await runExternalCommand(commandInput);
    return {
      status: "ok",
      command: [command, ...args].join(" "),
      message: "Configured notification command is available.",
    };
  } catch (error) {
    const safeError = safeErrorFromUnknown(error, {
      tag: "EventHookError",
      code: "EVENT_HOOK_COMMAND_UNUSABLE",
      message: "Configured notification command is not available.",
    });
    return {
      status: "warn",
      command: [command, ...args].join(" "),
      message: "Configured notification command failed the doctor check.",
      error: safeError.message,
    };
  }
}

function envForExternalCommand(env: CliEnv | undefined): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function builtInEventHookToml(configPath: string): string {
  const args = builtInEventHookArgs(configPath);
  return [
    "[[hooks.event]]",
    `id = ${JSON.stringify(builtInHookId)}`,
    'events = ["worktree.agentStateChanged"]',
    'command = "stn"',
    `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    `timeout_ms = ${builtInHookTimeoutMs}`,
    "",
    "[hooks.event.filter]",
    `agent_state = ${JSON.stringify(builtInHookFilter.agentState)}`,
    `change_source = ${JSON.stringify(builtInHookFilter.changeSource)}`,
    `harness_event_type = ${JSON.stringify(builtInHookFilter.harnessEventType)}`,
  ].join("\n");
}

function builtInEventHookArgs(configPath: string): string[] {
  return ["--config", configPath, "notify", "turn-completion"];
}

function builtInHookIsCurrent(hooks: ObserverEventHookConfig[], configPath: string): boolean {
  const matches = hooks.filter((hook) => hook.id === builtInHookId);
  if (matches.length !== 1) {
    return false;
  }
  const hook = matches[0];
  return hook !== undefined && hookMatchesBuiltIn(hook, configPath);
}

function hookMatchesBuiltIn(hook: ObserverEventHookConfig, configPath: string): boolean {
  return (
    hook.id === builtInHookId &&
    hook.command === "stn" &&
    sameStringList(hook.args ?? [], builtInEventHookArgs(configPath)) &&
    sameStringList(hook.events, ["worktree.agentStateChanged"]) &&
    hook.timeoutMs === builtInHookTimeoutMs &&
    hookFilterMatchesBuiltIn(hook.filter)
  );
}

function hookFilterMatchesBuiltIn(filter: ObserverEventHookConfig["filter"]): boolean {
  return (
    filter?.agentState === builtInHookFilter.agentState &&
    filter.harness === undefined &&
    filter.changeSource === builtInHookFilter.changeSource &&
    filter.harnessEventType === builtInHookFilter.harnessEventType
  );
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatHookCommand(hook: ObserverEventHookConfig): string {
  return [hook.command, ...(hook.args ?? [])].join(" ");
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { yes: false, force: false };
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--force") {
      flags.force = true;
      continue;
    }
    throw new Error(`Unknown event hook option: ${arg}`);
  }
  return flags;
}

function requiredConfigPath(options: EventHooksCommandOptions): string {
  if (options.configPath === undefined || options.configPath.length === 0) {
    throw new Error("Event hook installation requires a station config path.");
  }
  return options.configPath;
}

export async function runEventHooksCommand(
  args: string[],
  options: EventHooksCommandOptions = {},
): Promise<EventHooksCommandResult> {
  const [action, name] = args;
  const flags = parseFlags(args.slice(2));
  if (action === "doctor") {
    return doctorEventHooks(options);
  }
  if (name !== builtInHookName) {
    throw new Error(`Unknown event hook example: ${name ?? ""}`);
  }
  if (action === "plan") {
    return planBuiltInEventHook(options, flags);
  }
  if (action === "install") {
    if (!flags.yes) {
      throw new Error("Refusing to install event hook without --yes.");
    }
    const plan = await planBuiltInEventHook(options, flags);
    if (plan.changed) {
      await writeFile(plan.configPath, plan.after, "utf8");
    }
    return { ...plan, installed: true };
  }
  throw new Error(
    "Usage: station event-hooks plan|install notify-turn-completion [--yes] or station event-hooks doctor",
  );
}
