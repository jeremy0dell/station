import os from "node:os";

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

type SpawnOptions = {
  cols: number;
  rows: number;
  name: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  cttyHelperPath?: string;
};

type ExitEvent = { exitCode: number; signal: number };

/** Bun.Terminal adapter for the existing parkable node-pty bridge process. */
export function spawn(command: string, args: readonly string[], options: SpawnOptions) {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: ExitEvent) => void>();
  const pendingData: string[] = [];
  const pausedData: string[] = [];
  const decoder = new TextDecoder();
  let paused = false;
  let exitEvent: ExitEvent | undefined;
  let payloadExitCode: number | undefined;
  let terminalExited = false;

  const emitData = (data: string) => {
    if (data.length === 0) return;
    if (paused) {
      pausedData.push(data);
    } else if (dataListeners.size === 0) {
      pendingData.push(data);
    } else {
      for (const listener of dataListeners) listener(data);
    }
  };
  const emitExit = () => {
    if (!terminalExited || payloadExitCode === undefined || exitEvent !== undefined) return;
    emitData(decoder.decode());
    exitEvent = {
      exitCode: payloadExitCode,
      signal: signalToNumber(child.signalCode),
    };
    for (const listener of exitListeners) listener(exitEvent);
  };

  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    name: options.name,
    data(_terminal, data) {
      emitData(decoder.decode(data, { stream: true }));
    },
    exit() {
      terminalExited = true;
      emitExit();
    },
  });
  const child = Bun.spawn(
    [
      ...(options.cttyHelperPath === undefined ? [] : [options.cttyHelperPath]),
      command,
      ...args,
    ],
    { cwd: options.cwd, env: options.env, terminal },
  );
  void child.exited.then(
    (code) => {
      payloadExitCode = code;
      setTimeout(() => {
        if (!terminal.closed) terminal.close();
      }, 0);
      emitExit();
    },
    () => {
      payloadExitCode = 1;
      if (!terminal.closed) terminal.close();
      emitExit();
    },
  );

  return {
    pid: child.pid,
    onData(listener: (data: string) => void) {
      dataListeners.add(listener);
      for (const data of pendingData.splice(0)) listener(data);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener: (event: ExitEvent) => void) {
      exitListeners.add(listener);
      if (exitEvent !== undefined) listener(exitEvent);
      return { dispose: () => exitListeners.delete(listener) };
    },
    write(data: string) {
      terminal.write(data);
    },
    resize(cols: number, rows: number) {
      terminal.resize(cols, rows);
    },
    kill(signal?: string) {
      child.kill(signal);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const data of pausedData.splice(0)) emitData(data);
    },
  };
}

function signalToNumber(signal: NodeJS.Signals | null): number {
  return signal === null ? 0 : (os.constants.signals[signal] ?? 0);
}
