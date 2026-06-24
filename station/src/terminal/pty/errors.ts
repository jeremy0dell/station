export class StationTerminalSpawnError extends Error {
  readonly tag = "StationTerminalError";
  readonly code = "STATION_TERMINAL_SPAWN_FAILED";
  readonly command: string;

  constructor(command: string, cause: unknown) {
    super(`Failed to spawn node-pty terminal for ${command}.`, { cause });
    Object.defineProperty(this, "name", {
      value: this.tag,
      enumerable: false,
      configurable: true,
    });
    this.command = command;
  }
}
