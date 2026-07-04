export type StationTerminalId = string;

export type StationTerminalSize = {
  cols: number;
  rows: number;
};

export type StationTerminalExit = {
  exitCode: number;
  signal?: number;
};

export type StationTerminalSpawnOptions = {
  id?: StationTerminalId;
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  name?: string;
  size?: Partial<StationTerminalSize>;
};

export type StationTerminalDisposable = {
  dispose(): void;
};

/** Recorded history handed over on (re)attach, with the size it was painted for. */
export type StationTerminalReplay = {
  size: StationTerminalSize;
  chunks: readonly string[];
};

export type StationTerminalProcess = {
  readonly id: StationTerminalId;
  readonly command: string;
  readonly pid: number;
  readonly size: StationTerminalSize;
  /**
   * The last size the backing PTY acknowledged applying, when the transport
   * confirms resizes (host-attached terminals). `size` is the pane's asserted
   * size; a persistent gap between the two is geometry divergence.
   */
  readonly ackedSize?: StationTerminalSize | undefined;
  onData(listener: (data: string) => void): StationTerminalDisposable;
  onExit(listener: (event: StationTerminalExit) => void): StationTerminalDisposable;
  /** Transport/bridge diagnostics; never terminal output. */
  onDiagnostic(listener: (message: string) => void): StationTerminalDisposable;
  /**
   * Replayed snapshot delivery. When wired, snapshot bytes bypass onData and the
   * terminal awaits the listener before streaming live data, so the consumer can
   * parse the replay at its recorded size and reflow before live bytes arrive.
   * Terminals without replayable history never emit this.
   */
  onReplay?(
    listener: (replay: StationTerminalReplay) => void | Promise<void>,
  ): StationTerminalDisposable;
  write(data: string): void;
  resize(size: StationTerminalSize): void;
  kill(signal?: string): void;
  dispose(): void;
};
