import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type {
  StationTerminalDisposable,
  StationTerminalExit,
  StationTerminalProcess,
  StationTerminalSize,
} from "../types.js";
import { StationTerminalSpawnError } from "./errors.js";
import { TerminalProcessEmitter } from "./terminalProcessEmitter.js";

const MIN_COLS = 2;
const MIN_ROWS = 1;

type BunTerminal = {
  readonly closed: boolean;
  write(data: string | BufferSource): number;
  resize(cols: number, rows: number): void;
  close(): void;
};

type BunSubprocess = {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: string | number): void;
};

declare const Bun: {
  Terminal: new (options: {
    cols: number;
    rows: number;
    name: string;
    data(terminal: BunTerminal, data: Uint8Array): void;
    exit(terminal: BunTerminal, exitCode: number, signal: string | null): void;
  }) => BunTerminal;
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: Readonly<Record<string, string | undefined>>;
      terminal: BunTerminal;
    },
  ): BunSubprocess;
};

export const CTTY_HELPER_PATH = fileURLToPath(
  new URL("../../../dist/ctty-helper", import.meta.url),
);

export type BunTerminalProcessOptions = {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  name: string;
  size: StationTerminalSize;
  cttyHelperPath?: string;
};

export function createBunTerminalProcess(
  options: BunTerminalProcessOptions,
): BunTerminalProcess {
  const helperPath = options.cttyHelperPath;
  let spawnCommand: string[];
  if (helperPath === undefined) {
    spawnCommand = [options.command, ...options.args];
  } else {
    try {
      spawnCommand = [validateCttyHelper(helperPath), options.command, ...options.args];
    } catch (error) {
      throw helperSpawnError(options.command, helperPath, error);
    }
  }

  try {
    return new BunTerminalProcess(options, spawnCommand);
  } catch (error) {
    if (helperPath !== undefined && isHelperExecutionDenied(error, helperPath)) {
      throw helperSpawnError(options.command, helperPath, error);
    }
    throw new StationTerminalSpawnError(options.command, error);
  }
}

export class BunTerminalProcess implements StationTerminalProcess {
  readonly id: string;
  readonly command: string;

  #child: BunSubprocess;
  #terminal: BunTerminal;
  #events = new TerminalProcessEmitter();
  #size: StationTerminalSize;
  #disposed = false;

  constructor(options: BunTerminalProcessOptions, spawnCommand: string[]) {
    this.id = options.id;
    this.command = options.command;
    this.#size = clampSize(options.size);

    const decoder = new TextDecoder();
    const events = this.#events;
    let payloadExit: StationTerminalExit | undefined;
    let terminalExited = false;
    const emitPayloadExitAfterDrain = () => {
      if (!terminalExited || payloadExit === undefined) {
        return;
      }
      events.emitData(decoder.decode());
      events.emitExit(payloadExit);
    };
    const terminal = new Bun.Terminal({
      cols: this.#size.cols,
      rows: this.#size.rows,
      name: options.name,
      data(_terminal, data) {
        events.emitData(decoder.decode(data, { stream: true }));
      },
      exit(_terminal, exitCode) {
        terminalExited = true;
        if (exitCode !== 0 && !events.exited) {
          events.emitDiagnostic(`Bun terminal stream closed with status ${exitCode}.`);
        }
        emitPayloadExitAfterDrain();
      },
    });

    let child: BunSubprocess;
    try {
      child = Bun.spawn(spawnCommand, {
        cwd: options.cwd,
        env: options.env,
        terminal,
      });
    } catch (error) {
      terminal.close();
      throw error;
    }
    this.#terminal = terminal;
    this.#child = child;

    void child.exited.then(
      (exitCode) => {
        const event: StationTerminalExit = { exitCode };
        const signal = signalToNumber(child.signalCode);
        if (signal !== undefined) {
          event.signal = signal;
        }
        payloadExit = event;
        // Bun may settle the payload before the PTY drains its final bytes.
        if (options.cttyHelperPath === undefined && !terminal.closed) {
          setImmediate(() => {
            if (!terminal.closed) {
              terminal.close();
            }
          });
        }
        emitPayloadExitAfterDrain();
      },
      (error) => {
        events.emitDiagnostic(
          error instanceof Error ? error.message : "Bun failed while waiting for the terminal payload.",
        );
        payloadExit = { exitCode: 1 };
        if (!terminal.closed) {
          terminal.close();
        }
        emitPayloadExitAfterDrain();
      },
    );
  }

  get pid(): number {
    return this.#child.pid;
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
    this.#events.assertActive("write to terminal");
    if (!this.#events.exited) {
      this.#terminal.write(data);
    }
  }

  resize(size: StationTerminalSize): void {
    this.#events.assertActive("resize terminal");
    if (this.#events.exited) {
      return;
    }
    this.#size = clampSize(size);
    this.#terminal.resize(this.#size.cols, this.#size.rows);
  }

  kill(signal?: string): void {
    if (this.#disposed || this.#events.exited) {
      return;
    }
    this.#child.kill(signal);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const exited = this.#events.exited;
    this.#events.dispose();
    if (!exited) {
      try {
        this.#child.kill();
      } catch {
        // The payload may have exited between the state check and the signal.
      }
    }
    if (!this.#terminal.closed) {
      this.#terminal.close();
    }
  }
}

function validateCttyHelper(path: string): string {
  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new Error(`${path} is not a regular file.`);
  }
  accessSync(path, constants.X_OK);
  return path;
}

function helperSpawnError(command: string, helperPath: string, cause: unknown): Error {
  return new StationTerminalSpawnError(
    command,
    cause,
    `The controlling-terminal helper at ${helperPath} is unavailable. Run \`bun run build:ctty-helper\` from station/.`,
  );
}

function isHelperExecutionDenied(error: unknown, helperPath: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const systemError = error as Error & { code?: unknown; path?: unknown };
  return systemError.code === "EACCES" && systemError.path === helperPath;
}

function clampSize(size: StationTerminalSize): StationTerminalSize {
  return {
    cols: clampDimension(size.cols, MIN_COLS),
    rows: clampDimension(size.rows, MIN_ROWS),
  };
}

function clampDimension(value: number, minimum: number): number {
  return Number.isInteger(value) && value >= minimum ? value : minimum;
}

function signalToNumber(signal: NodeJS.Signals | null): number | undefined {
  if (signal === null) {
    return undefined;
  }
  const signalNumber = os.constants.signals[signal];
  return signalNumber === 0 ? undefined : signalNumber;
}
