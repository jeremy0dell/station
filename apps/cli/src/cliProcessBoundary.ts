import { randomUUID } from "node:crypto";
import { isSafeError, type RuntimeSafeError } from "@station/runtime";
import type { CliProcessDeps } from "./cliProcessTypes.js";
import type { CliRunOptions } from "./cliTypes.js";
import type { CliEnv } from "./env.js";
import { escapeTerminalBytes, formatCliJson } from "./terminalOutput.js";

export type CliProcessIo = {
  stdoutWrite(value: string): void;
  stderrWrite(value: string): void;
  exit(code: number): void;
  setExitCode(code: number): void;
};

export function createCliProcessIo(deps: CliProcessDeps): CliProcessIo {
  return {
    stdoutWrite: deps.stdoutWrite ?? ((value) => process.stdout.write(value)),
    stderrWrite: deps.stderrWrite ?? ((value) => process.stderr.write(value)),
    exit: deps.exit ?? ((code) => process.exit(code)),
    setExitCode:
      deps.setExitCode ??
      ((code) => {
        process.exitCode = code;
      }),
  };
}

export function resolveCliProcessEnv(options: CliRunOptions): CliEnv {
  return options.env ?? options.popupDeps?.env ?? options.tuiDeps?.env ?? process.env;
}

export function formatCliError(error: unknown): string {
  if (isSafeError(error)) return formatSafeError(error);
  if (error instanceof Error) return escapeTerminalBytes(error.message);
  if (typeof error === "object" && error !== null) {
    try {
      return formatCliJson(error);
    } catch {
      return escapeTerminalBytes(String(error));
    }
  }
  return escapeTerminalBytes(String(error));
}

function formatSafeError(error: RuntimeSafeError): string {
  const lines = [`${escapeTerminalBytes(error.message)} (${escapeTerminalBytes(error.code)})`];
  if (error.hint !== undefined) lines.push(`Hint: ${escapeTerminalBytes(error.hint)}`);
  if (error.diagnosticId !== undefined) {
    lines.push(`Diagnostic: ${escapeTerminalBytes(error.diagnosticId)}`);
  }
  if (error.commandId !== undefined) {
    lines.push(`Command: ${escapeTerminalBytes(error.commandId)}`);
  }
  if (error.traceId !== undefined) lines.push(`Trace: ${escapeTerminalBytes(error.traceId)}`);
  return lines.join("\n");
}

export function safeCliProcessNow(clock: { now(): Date }): Date {
  try {
    return clock.now();
  } catch {
    return new Date();
  }
}

export function safeCliProcessInvocationId(create: (() => string) | undefined): string {
  try {
    return (create ?? randomUUID)();
  } catch {
    return randomUUID();
  }
}
