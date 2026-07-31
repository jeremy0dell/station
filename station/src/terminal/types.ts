import type {
  SemanticCopySnapshot,
  TerminalOutputCompatibility,
} from "@station/contracts";

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

/** Verbatim terminal data or a production-geometry barrier retained by raw replay. */
export type StationTerminalRawReplayEvent =
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number };

/**
 * Raw history, exact serialized VT plus semantic-copy restoration, or a
 * control-only reset. Variant-specific fields make invalid replay ordering
 * unrepresentable inside Station.
 */
export type StationTerminalReplay =
  | {
      kind: "raw-complete";
      initialSize: StationTerminalSize;
      events: readonly StationTerminalRawReplayEvent[];
    }
  | {
      kind: "semantic-truncation-recovery";
      initialSize: StationTerminalSize;
      serializedVt: string;
      semanticCopy: SemanticCopySnapshot;
    }
  | {
      kind: "live-reset-recovery";
      initialSize: StationTerminalSize;
      resetData: string;
    };

/** Attachment failure that does not prove the backing process exited. */
export type StationTerminalUnavailable = {
  code: string;
  message: string;
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
  /** Stops pane I/O without invoking process-exit lifecycle effects. */
  onUnavailable?(
    listener: (event: StationTerminalUnavailable) => void,
  ): StationTerminalDisposable;
  /**
   * Replayed snapshot delivery. Raw events, exact serialized VT plus semantic-copy
   * state, or control-only reset data bypass onData; the terminal awaits the listener
   * before streaming live data, so replay reaches VT idle and restores copy state
   * before queued output. Terminals without replayable history never emit this.
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
