import type { TerminalOutputCompatibility } from "@station/contracts";

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
  size?: Partial<StationTerminalSize>;
  outputCompatibility?: TerminalOutputCompatibility;
};

export type StationTerminalDisposable = {
  dispose(): void;
};

export type StationTerminalReplayEvent =
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Recorded history handed over on (re)attach with its ordered geometry. */
export type StationTerminalReplay = {
  initialSize: StationTerminalSize;
  events: readonly StationTerminalReplayEvent[];
};

export type StationTerminalProcess = {
  readonly id: StationTerminalId;
  readonly command: string;
  readonly pid: number;
  readonly size: StationTerminalSize;
  /**
   * The last ordered geometry barrier consumed from the backing PTY, when the
   * transport provides them. `size` is the pane's asserted size; a persistent
   * gap between the two is geometry divergence.
   */
  readonly ackedSize?: StationTerminalSize | undefined;
  onData(listener: (data: string) => void): StationTerminalDisposable;
  onExit(listener: (event: StationTerminalExit) => void): StationTerminalDisposable;
  /** Transport/bridge diagnostics; never terminal output. */
  onDiagnostic(listener: (message: string) => void): StationTerminalDisposable;
  /**
   * Replayed snapshot delivery. When wired, snapshot events bypass onData and
   * the terminal awaits the listener before streaming live data, so the consumer
   * can apply every recorded resize before parsing later bytes.
   */
  onReplay?(
    listener: (replay: StationTerminalReplay) => void | Promise<void>,
  ): StationTerminalDisposable;
  /**
   * Ordered backing-PTY geometry. The terminal awaits listeners before emitting
   * later data so consumers parse every byte at the size that produced it.
   */
  onGeometry?(
    listener: (size: StationTerminalSize) => void | Promise<void>,
  ): StationTerminalDisposable;
  write(data: string): void;
  resize(size: StationTerminalSize): void;
  kill(signal?: string): void;
  dispose(): void;
};
