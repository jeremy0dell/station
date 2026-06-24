import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type ObserverPaths, resolveObserverPaths, resolvePath } from "@station/config";
import type { ProviderHookReceipt } from "@station/contracts";
import { ProviderHookReceiptSchema, STATION_SCHEMA_VERSION } from "@station/contracts";
import { systemClock, toIsoTimestamp } from "@station/runtime";
import {
  type ProviderHookSenderDeps,
  type ProviderHookSenderOptions,
  sendClaudeHookPayload,
  sendCodexHookPayload,
  sendCrushHookPayload,
  sendCursorHookPayload,
  sendPiHookPayload,
  sendWorktrunkHookEvent,
} from "./sender.js";
import { readStdinIfAvailable } from "./stdin.js";

export type ProviderIngressCommandOptions = {
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  observerEntryPath?: string;
};

export type ProviderIngressMainResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type ParsedOptions = {
  providerArgs: string[];
  paths: ObserverPaths;
  configPath?: string;
  observerEntryPath?: string;
  autoStart?: boolean;
  deliveryTimeoutMs?: number;
  startupTimeoutMs?: number;
  rateLimitMs?: number;
};

export async function runProviderIngressCommand(
  argv = process.argv.slice(2),
  options: ProviderIngressCommandOptions = {},
  deps: ProviderHookSenderDeps = {},
): Promise<ProviderHookReceipt> {
  const parsed = await parseArgs(argv);
  const [provider, event] = parsed.providerArgs;
  if (provider === undefined) {
    throw new Error("Usage: stn-ingress [options] <provider> [event]");
  }
  const senderOptions = senderOptionsFromParsed(parsed, options);
  const stdin = options.stdin ?? (await readStdinIfAvailable());

  if (provider === "claude") {
    const payload = parseJsonPayload(stdin, "claude", "unknown", deps);
    if (!payload.ok) {
      return payload.receipt;
    }
    const hookInput: Parameters<typeof sendClaudeHookPayload>[0] = {
      ...senderOptions,
      payload: payload.value,
    };
    if (options.env !== undefined) {
      hookInput.env = options.env;
    }
    return sendClaudeHookPayload(hookInput, deps);
  }

  if (provider === "codex") {
    const payload = parseJsonPayload(stdin, "codex", "unknown", deps);
    if (!payload.ok) {
      return payload.receipt;
    }
    const hookInput: Parameters<typeof sendCodexHookPayload>[0] = {
      ...senderOptions,
      payload: payload.value,
    };
    if (options.env !== undefined) {
      hookInput.env = options.env;
    }
    return sendCodexHookPayload(hookInput, deps);
  }

  if (provider === "cursor") {
    const payload = parseJsonPayload(stdin, "cursor", event ?? "unknown", deps);
    if (!payload.ok) {
      return payload.receipt;
    }
    const hookInput: Parameters<typeof sendCursorHookPayload>[0] = {
      ...senderOptions,
      payload: payload.value,
    };
    if (options.env !== undefined) {
      hookInput.env = options.env;
    }
    return sendCursorHookPayload(hookInput, deps);
  }

  if (provider === "crush") {
    const payload = parseJsonPayload(stdin, "crush", event ?? "unknown", deps);
    if (!payload.ok) {
      return payload.receipt;
    }
    const hookInput: Parameters<typeof sendCrushHookPayload>[0] = {
      ...senderOptions,
      payload: payload.value,
    };
    if (options.env !== undefined) {
      hookInput.env = options.env;
    }
    return sendCrushHookPayload(hookInput, deps);
  }

  if (provider === "pi") {
    if (event === undefined) {
      throw new Error("Usage: stn-ingress [options] pi <event>");
    }
    const payload = parseJsonPayload(stdin, "pi", event, deps);
    if (!payload.ok) {
      return payload.receipt;
    }
    const hookInput: Parameters<typeof sendPiHookPayload>[0] = {
      ...senderOptions,
      eventType: event,
      payload: payload.value,
    };
    if (options.env !== undefined) {
      hookInput.env = options.env;
    }
    return sendPiHookPayload(hookInput, deps);
  }

  if (provider === "worktrunk") {
    if (event === undefined) {
      throw new Error("Usage: stn-ingress [options] worktrunk <event>");
    }
    const payload = parseOptionalJsonPayload(stdin, "worktrunk", event, deps);
    if (!payload.ok) {
      return payload.receipt;
    }
    return sendWorktrunkHookEvent(
      {
        ...senderOptions,
        event,
        ...(payload.value === undefined ? {} : { payload: payload.value }),
      },
      deps,
    );
  }

  throw new Error(`Unsupported provider hook sender: ${provider}`);
}

export async function runProviderIngressMain(
  argv = process.argv.slice(2),
  options: ProviderIngressCommandOptions = {},
): Promise<ProviderIngressMainResult> {
  try {
    const receipt = await runProviderIngressCommand(
      argv,
      {
        ...options,
        observerEntryPath: options.observerEntryPath ?? defaultObserverEntryPath(),
      },
      {},
    );
    if (receipt.status === "rejected") {
      return {
        code: 1,
        stdout: "",
        stderr: `${formatRejectedReceipt(receipt)}\n`,
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `${formatProviderIngressError(error)}\n`,
    };
  }
}

async function parseArgs(argv: string[]): Promise<ParsedOptions> {
  let stateDir: string | undefined;
  let socketPath: string | undefined;
  let spoolDir: string | undefined;
  let configPath: string | undefined;
  let observerEntryPath: string | undefined;
  let autoStart: boolean | undefined;
  let deliveryTimeoutMs: number | undefined;
  let startupTimeoutMs: number | undefined;
  let rateLimitMs: number | undefined;
  const providerArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--state-dir" && value !== undefined) {
      stateDir = resolvePath(value);
      index += 1;
      continue;
    }
    if (arg === "--socket" && value !== undefined) {
      socketPath = resolvePath(value);
      index += 1;
      continue;
    }
    if (arg === "--spool-dir" && value !== undefined) {
      spoolDir = resolvePath(value);
      index += 1;
      continue;
    }
    if (arg === "--config" && value !== undefined) {
      configPath = resolvePath(value);
      index += 1;
      continue;
    }
    if (arg === "--observer-entry" && value !== undefined) {
      observerEntryPath = resolvePath(value);
      index += 1;
      continue;
    }
    if (arg === "--delivery-timeout-ms" && value !== undefined) {
      deliveryTimeoutMs = parsePositiveInteger(value, arg);
      index += 1;
      continue;
    }
    if (arg === "--startup-timeout-ms" && value !== undefined) {
      startupTimeoutMs = parsePositiveInteger(value, arg);
      index += 1;
      continue;
    }
    if (arg === "--rate-limit-ms" && value !== undefined) {
      rateLimitMs = parsePositiveInteger(value, arg);
      index += 1;
      continue;
    }
    if (arg === "--no-auto-start") {
      autoStart = false;
      continue;
    }
    if (arg !== undefined) {
      providerArgs.push(arg);
    }
  }

  const defaults =
    configPath === undefined
      ? resolveObserverPaths()
      : resolveObserverPaths((await loadConfig(configPath)).config);
  const paths = {
    ...defaults,
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(spoolDir === undefined ? {} : { hookSpoolDir: spoolDir }),
  };
  if (stateDir !== undefined && spoolDir === undefined) {
    paths.hookSpoolDir = join(stateDir, "spool", "hooks");
  }

  const parsed: ParsedOptions = { providerArgs, paths };
  if (configPath !== undefined) parsed.configPath = configPath;
  if (observerEntryPath !== undefined) parsed.observerEntryPath = observerEntryPath;
  if (autoStart !== undefined) parsed.autoStart = autoStart;
  if (deliveryTimeoutMs !== undefined) parsed.deliveryTimeoutMs = deliveryTimeoutMs;
  if (startupTimeoutMs !== undefined) parsed.startupTimeoutMs = startupTimeoutMs;
  if (rateLimitMs !== undefined) parsed.rateLimitMs = rateLimitMs;
  return parsed;
}

function senderOptionsFromParsed(
  parsed: ParsedOptions,
  options: ProviderIngressCommandOptions,
): ProviderHookSenderOptions {
  const senderOptions: ProviderHookSenderOptions = {
    paths: parsed.paths,
  };
  if (parsed.configPath !== undefined) senderOptions.configPath = parsed.configPath;
  const observerEntryPath = options.observerEntryPath ?? parsed.observerEntryPath;
  if (observerEntryPath !== undefined) senderOptions.observerEntryPath = observerEntryPath;
  if (parsed.autoStart !== undefined) senderOptions.autoStart = parsed.autoStart;
  if (parsed.deliveryTimeoutMs !== undefined) {
    senderOptions.deliveryTimeoutMs = parsed.deliveryTimeoutMs;
  }
  if (parsed.startupTimeoutMs !== undefined)
    senderOptions.startupTimeoutMs = parsed.startupTimeoutMs;
  if (parsed.rateLimitMs !== undefined) senderOptions.rateLimitMs = parsed.rateLimitMs;
  return senderOptions;
}

function parseJsonPayload(
  stdin: string | undefined,
  provider: string,
  event: string,
  deps: ProviderHookSenderDeps,
):
  | { ok: true; value: unknown }
  | {
      ok: false;
      receipt: ProviderHookReceipt;
    } {
  const source = stdin?.trim();
  if (source === undefined || source.length === 0) {
    return {
      ok: false,
      receipt: invalidPayloadReceipt(provider, event, deps),
    };
  }
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return {
      ok: false,
      receipt: invalidPayloadReceipt(provider, event, deps),
    };
  }
}

function parseOptionalJsonPayload(
  stdin: string | undefined,
  provider: string,
  event: string,
  deps: ProviderHookSenderDeps,
):
  | { ok: true; value?: unknown }
  | {
      ok: false;
      receipt: ProviderHookReceipt;
    } {
  const source = stdin?.trim();
  if (source === undefined || source.length === 0) {
    return { ok: true };
  }
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return {
      ok: false,
      receipt: invalidPayloadReceipt(provider, event, deps),
    };
  }
}

function invalidPayloadReceipt(
  provider: string,
  event: string,
  deps: ProviderHookSenderDeps,
): ProviderHookReceipt {
  const clock = deps.clock ?? systemClock;
  return ProviderHookReceiptSchema.parse({
    schemaVersion: STATION_SCHEMA_VERSION,
    hookId: deps.hookId?.() ?? `hook_invalid_${Date.now()}`,
    provider,
    event,
    accepted: false,
    status: "rejected",
    receivedAt: toIsoTimestamp(clock.now()),
    error: {
      tag: "HookPayloadError",
      code: "HOOK_PAYLOAD_INVALID",
      message: "Hook stdin payload must be valid JSON.",
      provider,
    },
  });
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function defaultObserverEntryPath(): string {
  return fileURLToPath(new URL("../../../apps/cli/dist/observerMain.js", import.meta.url));
}

function formatRejectedReceipt(receipt: ProviderHookReceipt): string {
  const output: Record<string, unknown> = {
    status: receipt.status,
    provider: receipt.provider,
    event: receipt.event,
  };
  if (receipt.error !== undefined) {
    output.error = receipt.error;
  }
  return JSON.stringify(output);
}

function formatProviderIngressError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to String for values JSON cannot serialize.
  }
  return String(error);
}
