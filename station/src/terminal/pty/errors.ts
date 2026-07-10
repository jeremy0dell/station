export class StationTerminalSpawnError extends Error {
  readonly tag = "StationTerminalError";
  readonly code = "STATION_TERMINAL_SPAWN_FAILED";
  readonly command: string;

  constructor(command: string, cause: unknown, detail?: string) {
    super(`Failed to spawn terminal for ${command}.${detail === undefined ? "" : ` ${detail}`}`, {
      cause,
    });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.command = command;
  }
}
