import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access as defaultAccess, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { runRuntimeBoundary, runRuntimeBoundaryWithTimeout } from "./boundary.js";
import {
  type ExternalCommandError,
  isSafeError,
  type RuntimeSafeError,
  type RuntimeSafeErrorFallback,
  safeErrorFromUnknown,
} from "./errors.js";

const execFileAsync = promisify(execFile);
const outputSnippetMaxChars = 2000;
const redactedValue = "[REDACTED]";
const redactedSecret = "[REDACTED_SECRET]";

const secretAssignmentKeyPattern =
  /(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|auth|credential|private[-_]?key)/i;

export type ExternalCommandResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ExternalCommandRunner = (input: ExternalCommandInput) => Promise<ExternalCommandResult>;

export type ExternalCommandInput = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  unsetEnv?: readonly string[];
  timeoutMs?: number;
  maxOutputChars?: number;
  stdin?: string;
  signal?: AbortSignal;
  allowedExitCodes?: number[];
  stdio?: "pipe" | "inherit";
};

export type ResolveExecutablePathOptions = {
  pathEnv?: string;
  access?: (path: string) => Promise<void>;
};

type NormalizedProcessError = {
  code?: string | number;
  exitCode?: number;
  name?: string;
  signal?: string;
  stderr?: string;
  stderrSnippet?: string;
  stdout?: string;
  stdoutSnippet?: string;
};

export async function runExternalCommand(
  input: ExternalCommandInput,
  runner: ExternalCommandRunner = nodeExternalCommandRunner,
): Promise<ExternalCommandResult> {
  const task = async ({ signal }: { signal: AbortSignal }) => {
    // Merge caller cancellation with the runtime timeout signal so execFile aborts on either.
    const linked = linkAbortSignals(input.signal, signal);
    try {
      try {
        return await runner({
          ...input,
          ...(linked.signal === undefined ? {} : { signal: linked.signal }),
        });
      } catch (error) {
        const allowedResult = allowedExitCodeResultFromUnknown(error, input);
        if (allowedResult !== undefined) {
          return allowedResult;
        }
        throw externalCommandErrorFromUnknown(
          error,
          input,
          await missingWorkingDirectory(error, input.cwd),
        );
      }
    } finally {
      linked.cleanup();
    }
  };

  const result =
    input.timeoutMs === undefined
      ? await runRuntimeBoundary(
          {
            operation: `externalCommand.${input.command}`,
            error: externalCommandFallback("EXTERNAL_COMMAND_FAILED", "External command failed."),
          },
          task,
        )
      : await runRuntimeBoundaryWithTimeout(
          {
            operation: `externalCommand.${input.command}`,
            timeoutMs: input.timeoutMs,
            error: externalCommandFallback("EXTERNAL_COMMAND_FAILED", "External command failed."),
            timeoutError: externalCommandFallback(
              "EXTERNAL_COMMAND_TIMEOUT",
              "External command timed out.",
            ),
          },
          task,
        );

  if (result.ok) {
    return result.value;
  }

  throw externalCommandErrorFromUnknown(result.error, input);
}

export async function nodeExternalCommandRunner(
  input: ExternalCommandInput,
): Promise<ExternalCommandResult> {
  if (input.stdio === "inherit") {
    return nodeExternalCommandRunnerWithInheritedStdio(input);
  }
  if (input.stdin !== undefined) {
    return nodeExternalCommandRunnerWithStdin(input);
  }
  const args = input.args ?? [];
  const result = await execFileAsync(input.command, args, {
    cwd: input.cwd,
    env: externalCommandEnvironment(input),
    maxBuffer: input.maxOutputChars ?? 64 * 1024,
    signal: input.signal,
  });
  return {
    command: input.command,
    args,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: 0,
  };
}

async function nodeExternalCommandRunnerWithInheritedStdio(
  input: ExternalCommandInput,
): Promise<ExternalCommandResult> {
  if (input.stdin !== undefined) {
    throw new Error("External command inherited stdio runner does not support stdin input.");
  }
  const args = input.args ?? [];
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, args, {
      cwd: input.cwd,
      env: externalCommandEnvironment(input),
      signal: input.signal,
      stdio: "inherit",
    });

    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("close", (exitCode, signal) => {
      settle(() => {
        if (exitCode === 0) {
          resolve({
            command: input.command,
            args,
            stdout: "",
            stderr: "",
            exitCode: 0,
          });
          return;
        }
        const error = Object.assign(new Error("External command failed."), {
          ...(exitCode === null ? {} : { exitCode }),
          ...(signal === null ? {} : { signal }),
          stdout: "",
          stderr: "",
        });
        reject(error);
      });
    });
  });
}

async function nodeExternalCommandRunnerWithStdin(
  input: ExternalCommandInput,
): Promise<ExternalCommandResult> {
  const args = input.args ?? [];
  const stdin = input.stdin;
  if (stdin === undefined) {
    throw new Error("External command stdin runner requires stdin input.");
  }
  const tempDir = await mkdtemp(join(tmpdir(), "station-command-stdin-"));
  const stdinPath = join(tempDir, "stdin");
  await writeFile(stdinPath, stdin, "utf8");
  try {
    const result = await execFileAsync(
      "sh",
      [
        "-c",
        'stdin_path=$1; shift; exec "$@" < "$stdin_path"',
        "sh",
        stdinPath,
        input.command,
        ...args,
      ],
      {
        cwd: input.cwd,
        env: externalCommandEnvironment(input),
        maxBuffer: input.maxOutputChars ?? 64 * 1024,
        signal: input.signal,
      },
    );
    return {
      command: input.command,
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function createFakeExternalCommandRunner(
  handler: (input: ExternalCommandInput) => ExternalCommandResult | Promise<ExternalCommandResult>,
): ExternalCommandRunner {
  return async (input) => handler(input);
}

export async function resolveExecutablePath(
  command: string,
  options: ResolveExecutablePathOptions = {},
): Promise<string | undefined> {
  // Resolve only executables the caller can actually run. A file that exists but
  // lacks the execute bit (partial install, wrong perms, broken symlink target)
  // must not resolve as a usable tool — the function name promises an *executable*
  // path. Tests inject `access` and are unaffected.
  const access =
    options.access ?? ((candidate: string) => defaultAccess(candidate, fsConstants.X_OK));
  if (isPathLikeCommand(command)) {
    return (await canAccess(command, access)) ? command : undefined;
  }

  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter).filter((part) => part.length > 0)) {
    const candidate = join(directory, command);
    if (await canAccess(candidate, access)) {
      return candidate;
    }
  }
  return undefined;
}

export function externalCommandErrorFromUnknown(
  error: unknown,
  input: Pick<ExternalCommandInput, "command" | "args" | "cwd">,
  cwdMissing = false,
): ExternalCommandError {
  const fallback = externalCommandFallback("EXTERNAL_COMMAND_FAILED", "External command failed.");
  const safeError = safeErrorFromUnknown(error, fallback);
  const cause = normalizeProcessError(error);
  const normalized: ExternalCommandError = {
    tag: "ExternalCommandError",
    code: cwdMissing
      ? "EXTERNAL_COMMAND_CWD_NOT_FOUND"
      : externalCommandCode(error, cause, safeError),
    message: externalCommandMessage(error, safeError),
    command: formatCommandForError(input),
  };

  copySafeErrorContext(normalized, safeError);

  if (input.cwd !== undefined) {
    normalized.cwd = input.cwd;
  }

  const exitCode = cause.exitCode ?? (typeof cause.code === "number" ? cause.code : undefined);
  if (exitCode !== undefined) {
    normalized.exitCode = exitCode;
  }

  if (cause.signal !== undefined) {
    normalized.signal = cause.signal;
  }

  const stdoutSnippet = commandOutputSnippet(cause.stdout ?? cause.stdoutSnippet);
  if (stdoutSnippet !== undefined) {
    normalized.stdoutSnippet = stdoutSnippet;
  }

  const stderrSnippet = commandOutputSnippet(cause.stderr ?? cause.stderrSnippet);
  if (stderrSnippet !== undefined) {
    normalized.stderrSnippet = stderrSnippet;
  }

  normalized.diagnosticDetails = [externalCommandDiagnosticDetail(normalized)];

  return normalized;
}

function externalCommandEnvironment(input: Pick<ExternalCommandInput, "env" | "unsetEnv">) {
  const env = { ...process.env };
  for (const key of input.unsetEnv ?? []) {
    delete env[key];
  }
  Object.assign(env, input.env);
  return env;
}

async function missingWorkingDirectory(error: unknown, cwd: string | undefined): Promise<boolean> {
  if (cwd === undefined || normalizeProcessError(error).code !== "ENOENT") {
    return false;
  }
  try {
    await defaultAccess(cwd);
    return false;
  } catch (cause) {
    return normalizeProcessError(cause).code === "ENOENT";
  }
}

function externalCommandFallback(code: string, message: string): RuntimeSafeErrorFallback {
  return {
    tag: "ExternalCommandError",
    code,
    message,
  };
}

function externalCommandCode(
  error: unknown,
  cause: NormalizedProcessError,
  safeError: RuntimeSafeError,
): string {
  if (isAbortLikeError(error)) {
    return "EXTERNAL_COMMAND_ABORTED";
  }
  return typeof cause.code === "string" ? cause.code : safeError.code;
}

function externalCommandMessage(error: unknown, safeError: RuntimeSafeError): string {
  return isAbortLikeError(error) ? "External command was aborted." : safeError.message;
}

function formatCommandForError(input: Pick<ExternalCommandInput, "command" | "args">): string {
  const parts = [input.command, ...(input.args ?? [])];
  const redacted: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const previous = parts[index - 1];
    const part = parts[index] ?? "";
    if (previous !== undefined && !previous.includes("=") && isSecretFlag(previous)) {
      redacted.push(redactedValue);
      continue;
    }
    redacted.push(redactCommandPart(part));
  }

  return redacted.join(" ");
}

function commandOutputSnippet(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const redacted = redactCommandOutput(value).slice(0, outputSnippetMaxChars);
  return redacted.length === 0 ? undefined : redacted;
}

function allowedExitCodeResultFromUnknown(
  error: unknown,
  input: Pick<ExternalCommandInput, "allowedExitCodes" | "args" | "command">,
): ExternalCommandResult | undefined {
  if (isAbortLikeError(error)) {
    return undefined;
  }
  const cause = normalizeProcessError(error);

  const exitCode = cause.exitCode ?? (typeof cause.code === "number" ? cause.code : undefined);
  if (exitCode === undefined || input.allowedExitCodes?.includes(exitCode) !== true) {
    return undefined;
  }

  return {
    command: input.command,
    args: input.args ?? [],
    stdout: cause.stdout ?? "",
    stderr: cause.stderr ?? "",
    exitCode,
  };
}

function copySafeErrorContext(target: ExternalCommandError, safeError: RuntimeSafeError): void {
  if (safeError.hint !== undefined) target.hint = safeError.hint;
  if (safeError.commandId !== undefined) target.commandId = safeError.commandId;
  if (safeError.projectId !== undefined) target.projectId = safeError.projectId;
  if (safeError.worktreeId !== undefined) target.worktreeId = safeError.worktreeId;
  if (safeError.sessionId !== undefined) target.sessionId = safeError.sessionId;
  if (safeError.provider !== undefined) target.provider = safeError.provider;
  if (safeError.traceId !== undefined) target.traceId = safeError.traceId;
  if (safeError.diagnosticId !== undefined) target.diagnosticId = safeError.diagnosticId;
}

function externalCommandDiagnosticDetail(error: ExternalCommandError) {
  const detail: NonNullable<RuntimeSafeError["diagnosticDetails"]>[number] = {
    type: "external_command",
    operation: `externalCommand.${error.command.split(" ")[0] ?? "command"}`,
    command: error.command,
  };
  if (error.provider !== undefined) detail.provider = error.provider;
  if (error.cwd !== undefined) detail.cwd = error.cwd;
  if (error.exitCode !== undefined) detail.exitCode = error.exitCode;
  if (error.signal !== undefined) detail.signal = error.signal;
  if (error.stdoutSnippet !== undefined) detail.stdoutSnippet = error.stdoutSnippet;
  if (error.stderrSnippet !== undefined) detail.stderrSnippet = error.stderrSnippet;
  return detail;
}

function redactCommandPart(value: string): string {
  const assignment = value.match(/^([^=]+)=(.*)$/);
  if (assignment !== null) {
    const key = assignment[1] ?? "";
    if (isSecretAssignmentKey(key)) {
      return `${key}=${redactedValue}`;
    }
  }
  return redactCommandOutput(value);
}

function isSecretFlag(value: string): boolean {
  const key = value.split("=")[0] ?? value;
  return key.startsWith("-") && isSecretAssignmentKey(key);
}

function isSecretAssignmentKey(value: string): boolean {
  return secretAssignmentKeyPattern.test(value);
}

async function canAccess(path: string, access: (path: string) => Promise<void>): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isPathLikeCommand(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal | undefined;
  cleanup(): void;
} {
  // Reuse a single source signal when possible; allocate a controller only to merge sources.
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return { signal: undefined, cleanup: () => undefined };
  }
  if (activeSignals.length === 1) {
    return { signal: activeSignals[0], cleanup: () => undefined };
  }

  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      continue;
    }
    const listener = () => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push(() => signal.removeEventListener("abort", listener));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (isSafeError(error)) {
    return error.tag === "CancellationError" || error.code === "EXTERNAL_COMMAND_ABORTED";
  }
  const cause = normalizeProcessError(error);
  return cause.name === "AbortError" || cause.code === "ABORT_ERR";
}

export function redactCommandOutput(value: string): string {
  return value
    .replace(
      /([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*)=([^\s]+)/gi,
      `$1=${redactedValue}`,
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${redactedValue}`)
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g,
      redactedSecret,
    );
}

function normalizeProcessError(error: unknown): NormalizedProcessError {
  if (error === null || error === undefined) {
    return {};
  }
  const source = Object(error) as Record<string, unknown>;
  const normalized: NormalizedProcessError = {};
  if (
    (typeof source.code === "string" && source.code.length > 0) ||
    (typeof source.code === "number" && Number.isFinite(source.code))
  ) {
    normalized.code = source.code;
  }
  if (typeof source.exitCode === "number" && Number.isFinite(source.exitCode)) {
    normalized.exitCode = source.exitCode;
  }
  if (typeof source.name === "string") normalized.name = source.name;
  if (typeof source.signal === "string") normalized.signal = source.signal;
  if (typeof source.stderr === "string") normalized.stderr = source.stderr;
  if (typeof source.stderrSnippet === "string") {
    normalized.stderrSnippet = source.stderrSnippet;
  }
  if (typeof source.stdout === "string") normalized.stdout = source.stdout;
  if (typeof source.stdoutSnippet === "string") {
    normalized.stdoutSnippet = source.stdoutSnippet;
  }
  return normalized;
}
