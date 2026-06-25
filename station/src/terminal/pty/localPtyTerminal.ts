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
import { StationTerminalSpawnError } from "./errors.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
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

export function createLocalPtyTerminal(
  options: StationTerminalSpawnOptions = {},
): StationTerminalProcess {
  ensureSpawnHelperExecutable();
  const size = normalizeSize(options.size);
  const env = createPtyEnv(options.env);
  const command = options.command ?? defaultShell();
  const args = options.args === undefined ? defaultShellArgs() : [...options.args];
  const bridgeOptions = {
    args,
    cols: size.cols,
    command,
    cwd: options.cwd ?? process.cwd(),
    env,
    name: options.name ?? env.TERM ?? "xterm-256color",
    rows: size.rows,
  };

  try {
    const bridge = spawn(resolveNodeCommand(), [
      BRIDGE_PATH,
      Buffer.from(JSON.stringify(bridgeOptions), "utf8").toString("base64url"),
    ]);

    return new LocalPtyTerminalProcess(
      options.id ?? createTerminalId(),
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
  #dataListeners = new Set<(data: string) => void>();
  #exitListeners = new Set<(event: StationTerminalExit) => void>();
  #diagnosticListeners = new Set<(message: string) => void>();
  #pendingData: string[] = [];
  #stdoutBuffer = "";
  #disposed = false;
  #exited = false;
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
      if (this.#exited) {
        return;
      }

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
    this.assertActive("subscribe to terminal data");
    this.#dataListeners.add(listener);
    for (const data of this.#pendingData) {
      listener(data);
    }
    this.#pendingData = [];
    return {
      dispose: () => {
        this.#dataListeners.delete(listener);
      },
    };
  }

  onExit(listener: (event: StationTerminalExit) => void): StationTerminalDisposable {
    this.assertActive("subscribe to terminal exit");
    this.#exitListeners.add(listener);
    return {
      dispose: () => {
        this.#exitListeners.delete(listener);
      },
    };
  }

  onDiagnostic(listener: (message: string) => void): StationTerminalDisposable {
    this.assertActive("subscribe to terminal diagnostics");
    this.#diagnosticListeners.add(listener);
    return {
      dispose: () => {
        this.#diagnosticListeners.delete(listener);
      },
    };
  }

  write(data: string): void {
    this.assertActive("write to terminal");
    // After exit the bridge stdin pipe is dead; a keystroke or forwarded VT
    // query reply must drop silently instead of raising EPIPE.
    if (this.#exited) {
      return;
    }
    this.sendBridgeCommand({
      type: "write",
      data,
    });
  }

  resize(size: StationTerminalSize): void {
    this.assertActive("resize terminal");
    if (this.#exited) {
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
    if (this.#disposed || this.#exited) {
      return;
    }

    this.sendBridgeCommand({
      type: "kill",
      signal,
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#pendingData = [];
    this.#dataListeners.clear();
    this.#exitListeners.clear();
    this.#diagnosticListeners.clear();

    if (!this.#exited) {
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
    if (this.#disposed) {
      return;
    }
    for (const listener of this.#diagnosticListeners) {
      listener(message);
    }
  }

  private emitData(data: string): void {
    // After dispose the listener set is empty by design; buffering into
    // #pendingData would grow without bound while a slow-dying child keeps
    // streaming.
    if (this.#disposed) {
      return;
    }
    if (this.#dataListeners.size === 0) {
      this.#pendingData.push(data);
      return;
    }

    for (const listener of this.#dataListeners) {
      listener(data);
    }
  }

  private emitExit(event: StationTerminalExit): void {
    this.#exited = true;
    for (const listener of this.#exitListeners) {
      listener(event);
    }
  }

  private sendBridgeCommand(command: object): void {
    this.#bridge.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private assertActive(action: string): void {
    if (this.#disposed) {
      throw new Error(`Cannot ${action} after terminal ${this.id} is disposed.`);
    }
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

export function createPtyEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string | undefined> {
  const nextEnv = {
    ...process.env,
    ...env,
  };

  // Station renders panes itself, so children should see stable xterm-style capabilities.
  nextEnv.TERM = env?.TERM ?? process.env.TERM ?? "xterm-256color";
  nextEnv.COLORTERM = env?.COLORTERM || process.env.COLORTERM || "truecolor";

  // The host owns terminal capabilities; a NO_COLOR/FORCE_COLOR leaked from the
  // observer's env would override the COLORTERM we just set, so drop both.
  delete nextEnv.NO_COLOR;
  delete nextEnv.FORCE_COLOR;

  return nextEnv;
}

function normalizeSize(size: Partial<StationTerminalSize> | undefined): StationTerminalSize {
  return {
    cols: normalizePositiveInteger(size?.cols, DEFAULT_COLS),
    rows: normalizePositiveInteger(size?.rows, DEFAULT_ROWS),
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return fallback;
  }

  return value;
}

function signalToNumber(signal: NodeJS.Signals): number {
  return os.constants.signals[signal] ?? 0;
}
