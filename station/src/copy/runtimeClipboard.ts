import { spawn } from "node:child_process";
import {
  createClipboardEffects,
  type ClipboardCommand,
  type ClipboardEffects,
} from "./clipboard.js";
import { createInternalClipboard } from "./internalClipboard.js";

export type RuntimeClipboardEffectsOptions = {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  writeToHost(sequence: string): void;
  spawnClipboard?: (command: ClipboardCommand, text: string) => void;
};

/** Build the real clipboard sinks shared by native Station and the standalone dashboard. */
export function createRuntimeClipboardEffects(
  options: RuntimeClipboardEffectsOptions,
): ClipboardEffects {
  return createClipboardEffects({
    internal: createInternalClipboard(),
    env: options.env,
    platform: options.platform,
    writeToHost: options.writeToHost,
    spawnClipboard: options.spawnClipboard ?? spawnClipboard,
  });
}

// A missing clipboard executable or early exit must not break the UI because
// the internal and OSC 52 sinks have already received the same copy.
function spawnClipboard(command: ClipboardCommand, text: string): void {
  try {
    const child = spawn(command.command, [...command.args], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  } catch {
    // Best-effort platform sink; the other clipboard sinks remain available.
  }
}
