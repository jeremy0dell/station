import type { StationTerminalExit } from "../types.js";

/** Messages every bridge transport shares, whether owner stdio pipe or adoption control socket. */
export type PtyBridgeDataMessage = { type: "data"; data: string };
export type PtyBridgeExitMessage = { type: "exit"; exitCode: number; signal?: number };
export type PtyBridgeErrorMessage = { type: "error"; message: string; code?: string };
export type PtyBridgeStreamMessage =
  | PtyBridgeDataMessage
  | PtyBridgeExitMessage
  | PtyBridgeErrorMessage;

/**
 * Reassembles newline-delimited frames across arbitrary chunk boundaries; a
 * partial line is retained until its newline arrives. Both bridge transports
 * (owner stdio pipe, adoption control socket) frame messages identically.
 */
export function createJsonLineFeed(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line);
    }
  };
}

/**
 * Parses one bridge frame. A stray non-JSON line (dependency noise on the
 * bridge's stdout) degrades to a diagnostic instead of taking the pipeline down.
 */
export function parseBridgeLine<T>(
  line: string,
  onDiagnostic: (message: string) => void,
): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    onDiagnostic(`unparseable bridge line: ${line.slice(0, 200)}`);
    return undefined;
  }
}

/** Shapes the typed exit event; `signal` stays absent (not undefined) when the PTY exited by code. */
export function toTerminalExit(exitCode: number, signal?: number): StationTerminalExit {
  const event: StationTerminalExit = { exitCode };
  if (signal !== undefined) {
    event.signal = signal;
  }
  return event;
}
