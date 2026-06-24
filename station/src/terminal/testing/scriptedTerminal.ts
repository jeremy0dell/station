import type {
  StationTerminalExit,
  StationTerminalProcess,
  StationTerminalSize,
} from "../types.js";

export type ScriptedTerminal = {
  terminal: StationTerminalProcess;
  helpers: {
    writes: string[];
    resizes: StationTerminalSize[];
    spawnSize: StationTerminalSize;
    isDisposed(): boolean;
    emitData(data: string): void;
    emitExit(event: StationTerminalExit): void;
  };
};

/** Fake PTY process: records writes/resizes, lets tests script data/exit. */
export function createScriptedTerminal(
  initialSize: StationTerminalSize = { cols: 36, rows: 8 },
): ScriptedTerminal {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: StationTerminalExit) => void>();
  const writes: string[] = [];
  const resizes: StationTerminalSize[] = [];
  let size = initialSize;
  let disposed = false;

  const terminal: StationTerminalProcess = {
    id: "scripted-terminal",
    command: "/bin/scripted",
    pid: 4242,
    get size() {
      return size;
    },
    onData(listener) {
      dataListeners.add(listener);
      return {
        dispose: () => {
          dataListeners.delete(listener);
        },
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return {
        dispose: () => {
          exitListeners.delete(listener);
        },
      };
    },
    onDiagnostic() {
      return { dispose: () => {} };
    },
    write(data) {
      writes.push(data);
    },
    resize(next) {
      size = next;
      resizes.push(next);
    },
    kill() {},
    dispose() {
      disposed = true;
    },
  };

  return {
    terminal,
    helpers: {
      writes,
      resizes,
      spawnSize: initialSize,
      isDisposed: () => disposed,
      emitData: (data) => {
        for (const listener of [...dataListeners]) {
          listener(data);
        }
      },
      emitExit: (event) => {
        for (const listener of [...exitListeners]) {
          listener(event);
        }
      },
    },
  };
}
