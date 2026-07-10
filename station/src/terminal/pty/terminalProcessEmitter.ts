import type {
  StationTerminalDisposable,
  StationTerminalExit,
} from "../types.js";

export class TerminalProcessEmitter {
  #dataListeners = new Set<(data: string) => void>();
  #exitListeners = new Set<(event: StationTerminalExit) => void>();
  #diagnosticListeners = new Set<(message: string) => void>();
  #pendingData: string[] = [];
  #exit: StationTerminalExit | undefined;
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  get exited(): boolean {
    return this.#exit !== undefined;
  }

  onData(listener: (data: string) => void): StationTerminalDisposable {
    this.assertActive("subscribe to terminal data");
    this.#dataListeners.add(listener);
    const pendingData = this.#pendingData;
    this.#pendingData = [];
    for (const data of pendingData) {
      listener(data);
    }
    return {
      dispose: () => {
        this.#dataListeners.delete(listener);
      },
    };
  }

  onExit(listener: (event: StationTerminalExit) => void): StationTerminalDisposable {
    this.assertActive("subscribe to terminal exit");
    if (this.#exit !== undefined) {
      listener(this.#exit);
      return { dispose() {} };
    }
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

  emitData(data: string): void {
    if (this.#disposed || data.length === 0) {
      return;
    }
    if (this.#dataListeners.size === 0) {
      this.#pendingData.push(data);
      return;
    }
    for (const listener of [...this.#dataListeners]) {
      listener(data);
    }
  }

  emitExit(event: StationTerminalExit): void {
    if (this.#disposed || this.#exit !== undefined) {
      return;
    }
    this.#exit = event;
    for (const listener of [...this.#exitListeners]) {
      listener(event);
    }
  }

  emitDiagnostic(message: string): void {
    if (this.#disposed) {
      return;
    }
    for (const listener of [...this.#diagnosticListeners]) {
      listener(message);
    }
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
  }

  assertActive(action: string): void {
    if (this.#disposed) {
      throw new Error(`Cannot ${action} after terminal events are disposed.`);
    }
  }
}
