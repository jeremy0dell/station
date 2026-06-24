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

export type StationTerminalProcess = {
  readonly id: StationTerminalId;
  readonly command: string;
  readonly pid: number;
  readonly size: StationTerminalSize;
  onData(listener: (data: string) => void): StationTerminalDisposable;
  onExit(listener: (event: StationTerminalExit) => void): StationTerminalDisposable;
  /** Transport/bridge diagnostics; never terminal output. */
  onDiagnostic(listener: (message: string) => void): StationTerminalDisposable;
  write(data: string): void;
  resize(size: StationTerminalSize): void;
  kill(signal?: string): void;
  dispose(): void;
};
