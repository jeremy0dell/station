import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type {
  StationTerminalDisposable,
  StationTerminalExit,
  StationTerminalProcess,
  StationTerminalSize,
  StationTerminalSpawnOptions,
} from "../types.js";
import {
  CTTY_HELPER_PATH,
  createBunTerminalProcess,
  type BunTerminalProcessOptions,
} from "./bunTerminalProcess.js";
import {
  createStationChildPtyEnvironment,
  STATION_CHILD_TERMINAL_ENV,
} from "./childPtyEnvironment.js";
import { StationTerminalSpawnError } from "./errors.js";
import { TerminalProcessEmitter } from "./terminalProcessEmitter.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 2;
const MIN_ROWS = 1;
const BRIDGE_PATH = fileURLToPath(new URL("./localPtyBridge.cjs", import.meta.url));
let nextTerminalSequence = 0;

type BridgeMessage =
  | {
      type: "ready";
      pid: number;
    }
  | {
      type: "data";
      data: string;
    }
  | {
      type: "exit";
      exitCode: number;
      signal?: number;
    }
  | {
      type: "error";
      message: string;
    };

// node-pty ships its macOS/Linux `spawn-helper` without the execute bit in the
// bun-extracted layout, and a later `bun install` re-clears it. When it isn't
// executable node-pty fails with "posix_spawnp failed" and every local pane
// reads "terminal exited 1". Re-assert it before EVERY spawn (only the path
// resolution is cached): a reinstall mid-session can clear the bit again, so a
// once-per-process check would silently wedge every later pane.
let spawnHelperCandidates: readonly string[] | undefined;
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    if (spawnHelperCandidates === undefined) {
      const ptyDir = path.dirname(
        path.dirname(createRequire(import.meta.url).resolve("node-pty")),
      );
      spawnHelperCandidates = [
        path.join(ptyDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
        path.join(ptyDir, "build", "Release", "spawn-helper"),
      ];
    }
    for (const helper of spawnHelperCandidates) {
      if (!existsSync(helper)) {
        continue;
      }
      const mode = statSync(helper).mode;
      if ((mode & 0o111) === 0) {
        chmodSync(helper, mode | 0o755);
      }
    }
  } catch {
    // Best-effort: an unusual node-pty layout still falls back to the repair script.
  }
}

/** Spawns a native PTY after applying Station's child-terminal environment policy. */
export function createLocalPtyTerminal(
  options: StationTerminalSpawnOptions = {},
  runtime: LocalPtyTerminalRuntime = {},
): StationTerminalProcess {
  const size = normalizeSize(options.size);
  const env = createStationChildPtyEnvironment(process.env, options.env);
  const command = options.command ?? defaultShell();
  const args = options.args === undefined ? defaultShellArgs() : [...options.args];
  let implementation: PtyImplementation;
  try {
    implementation =
      runtime.implementation ?? resolvePtyImplementation(process.env.STATION_PTY_IMPL);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "STATION_PTY_IMPL selects an unsupported value.";
    throw new StationTerminalSpawnError(command, error, detail);
  }
  const id = options.id ?? createTerminalId();
  const cwd = options.cwd ?? process.cwd();
  const name = STATION_CHILD_TERMINAL_ENV.TERM;

  if (implementation !== "bridge") {
    const bunOptions: BunTerminalProcessOptions = {
      id,
      command,
      args,
      cwd,
      env,
      name,
      size,
    };
    if (implementation === "bun") {
      bunOptions.cttyHelperPath = runtime.cttyHelperPath ?? CTTY_HELPER_PATH;
    }
    return createBunTerminalProcess(bunOptions);
  }

  ensureSpawnHelperExecutable();
  const bridgeOptions = {
    args,
    cols: size.cols,
    command,
    cwd,
    env,
    name,
    rows: size.rows,
  };

  try {
    const bridge = spawn(resolveNodeCommand(), [
      BRIDGE_PATH,
      Buffer.from(JSON.stringify(bridgeOptions), "utf8").toString("base64url"),
    ]);

    return new LocalPtyTerminalProcess(
      id,
      command,
      size,
      bridge,
    );
  } catch (error) {
    throw new StationTerminalSpawnError(command, error);
  }
}

class LocalPtyTerminalProcess implements StationTerminalProcess {
  readonly id: string;
  readonly command: string;

  #bridge: ChildProcessWithoutNullStreams;
  #events = new TerminalProcessEmitter();
  #stdoutBuffer = "";
  #pid: number;
  #size: StationTerminalSize;

  constructor(
    id: string,
    command: string,
    size: StationTerminalSize,
    bridge: ChildProcessWithoutNullStreams,
  ) {
    this.id = id;
    this.command = command;
    this.#size = size;
    this.#bridge = bridge;
    this.#pid = bridge.pid ?? 0;

    bridge.stdout.setEncoding("utf8");
    bridge.stdout.on("data", (chunk: string) => {
      this.handleBridgeOutput(chunk);
    });
    // Bridge stderr is Node diagnostics (warnings, crashes), not terminal
    // output: injected into the data stream it would render as screen content
    // and could corrupt VT parser state mid-escape-sequence.
    bridge.stderr.setEncoding("utf8");
    bridge.stderr.on("data", (chunk: string) => {
      this.emitDiagnostic(chunk);
    });
    // Writes raced against bridge death (EPIPE) surface here; without a
    // listener they are uncaught exceptions that crash Station.
    bridge.stdin.on("error", (error) => {
      this.emitDiagnostic(`bridge stdin error: ${error.message}`);
    });
    bridge.on("error", (error) => {
      this.emitExit({
        exitCode: 1,
      });
      this.emitData(error.message);
    });
    bridge.on("exit", (code, signal) => {
      // An abnormal bridge death (signal kill, code null) must not read as a
      // clean "exited 0" in the pane title.
      const signalNumber = signal === null ? undefined : signalToNumber(signal);
      const event: StationTerminalExit = {
        exitCode: code ?? (signalNumber !== undefined ? 128 + signalNumber : 1),
      };
      if (signalNumber !== undefined) {
        event.signal = signalNumber;
      }
      this.emitExit(event);
    });
  }

  get pid(): number {
    return this.#pid;
  }

  get size(): StationTerminalSize {
    return this.#size;
  }

  onData(listener: (data: string) => void): StationTerminalDisposable {
    return this.#events.onData(listener);
  }

  onExit(listener: (event: StationTerminalExit) => void): StationTerminalDisposable {
    return this.#events.onExit(listener);
  }

  onDiagnostic(listener: (message: string) => void): StationTerminalDisposable {
    return this.#events.onDiagnostic(listener);
  }

  write(data: string): void {
    this.assertActive("write to terminal");
    // After exit the bridge stdin pipe is dead; a keystroke or forwarded VT
    // query reply must drop silently instead of raising EPIPE.
    if (this.#events.exited) {
      return;
    }
    this.sendBridgeCommand({
      type: "write",
      data,
    });
  }

  resize(size: StationTerminalSize): void {
    this.assertActive("resize terminal");
    if (this.#events.exited) {
      return;
    }
    const nextSize = normalizeSize(size);
    this.#size = nextSize;
    this.sendBridgeCommand({
      type: "resize",
      cols: nextSize.cols,
      rows: nextSize.rows,
    });
  }

  kill(signal?: string): void {
    if (this.#events.disposed || this.#events.exited) {
      return;
    }

    this.sendBridgeCommand({
      type: "kill",
      signal,
    });
  }

  dispose(): void {
    if (this.#events.disposed) {
      return;
    }

    const exited = this.#events.exited;
    this.#events.dispose();

    if (!exited) {
      // Closing stdin arms the bridge's stdin-close kill backstop, which
      // covers children that trap the SIGHUP a plain SIGTERM path delivers.
      this.#bridge.stdin.end();
      this.#bridge.kill();
    }
  }

  private handleBridgeOutput(chunk: string): void {
    this.#stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.#stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.#stdoutBuffer.slice(0, newlineIndex);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      let message: BridgeMessage;
      try {
        message = JSON.parse(line) as BridgeMessage;
      } catch {
        // One stray non-JSON line (dependency noise on the bridge's stdout)
        // must not take the whole pipeline down.
        this.emitDiagnostic(`unparseable bridge line: ${line.slice(0, 200)}`);
        continue;
      }
      this.handleBridgeMessage(message);
    }
  }

  private handleBridgeMessage(message: BridgeMessage): void {
    switch (message.type) {
      case "ready":
        this.#pid = message.pid;
        return;
      case "data":
        this.emitData(message.data);
        return;
      case "error":
        this.emitDiagnostic(`bridge command error: ${message.message}`);
        return;
      case "exit": {
        const event: StationTerminalExit = {
          exitCode: message.exitCode,
        };
        if (message.signal !== undefined) {
          event.signal = message.signal;
        }
        this.emitExit(event);
      }
    }
  }

  private emitDiagnostic(message: string): void {
    this.#events.emitDiagnostic(message);
  }

  private emitData(data: string): void {
    this.#events.emitData(data);
  }

  private emitExit(event: StationTerminalExit): void {
    this.#events.emitExit(event);
  }

  private sendBridgeCommand(command: object): void {
    this.#bridge.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private assertActive(action: string): void {
    this.#events.assertActive(action);
  }
}

export type PtyImplementation = "bridge" | "bun" | "bun-nocctty";

export type LocalPtyTerminalRuntime = {
  /** A prepared runtime fixes the selector once at process startup. */
  implementation?: PtyImplementation;
  cttyHelperPath?: string;
};

export function resolvePtyImplementation(
  value: string | undefined,
  defaultImplementation: PtyImplementation = "bridge",
): PtyImplementation {
  switch (value) {
    case undefined:
    case "":
      return defaultImplementation;
    case "bridge":
      return "bridge";
    case "bun":
    case "bun-nocctty":
      return value;
    default:
      throw new Error(
        `Unsupported STATION_PTY_IMPL value ${JSON.stringify(value)}. Expected bridge, bun, or bun-nocctty.`,
      );
  }
}

function createTerminalId(): string {
  nextTerminalSequence += 1;
  return `terminal-${nextTerminalSequence}`;
}

function resolveNodeCommand(): string {
  return process.env.STATION_NODE ?? "node";
}

/** The shell a plain pane spawns when no explicit command is given. Exported so
 * the host-placed aux shell path spawns the same shell (host.spawn requires an explicit
 * command, where the local bridge would have defaulted it). */
export function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }

  return process.env.SHELL ?? "/bin/zsh";
}

export function defaultShellArgs(): string[] {
  if (process.platform === "win32") {
    return [];
  }

  return ["-i"];
}

function normalizeSize(size: Partial<StationTerminalSize> | undefined): StationTerminalSize {
  return {
    cols: normalizeDimension(size?.cols, DEFAULT_COLS, MIN_COLS),
    rows: normalizeDimension(size?.rows, DEFAULT_ROWS, MIN_ROWS),
  };
}

function normalizeDimension(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Number.isInteger(value) && value >= minimum ? value : minimum;
}

function signalToNumber(signal: NodeJS.Signals): number {
  return os.constants.signals[signal] ?? 0;
}
