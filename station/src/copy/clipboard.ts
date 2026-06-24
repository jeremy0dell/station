import { buildOsc52Sequence } from "./osc52.js";
import type { InternalClipboard } from "./internalClipboard.js";

/**
 * Where a yank is delivered. All three run by default; `platform` is the only
 * one that can't cross an SSH boundary, so it's skipped on remote sessions
 * (OSC 52 covers that case). Not yet user-configurable — the set is fixed here.
 */
export type CopySink = "internal" | "osc52" | "platform";
export const DEFAULT_COPY_SINKS: readonly CopySink[] = ["internal", "osc52", "platform"];

export type ClipboardEffects = {
  setInternal(text: string): void;
  writeOsc52(text: string): void;
  copyToPlatform(text: string): void;
  isRemoteSession(): boolean;
};

/** Toast summary for a yank: line count when multiline, else char count. */
export function copyToastMessage(text: string): string {
  const lineCount = text.split("\n").length;
  if (lineCount > 1) {
    return `Copied ${lineCount} lines`;
  }
  return `Copied ${text.length} ${text.length === 1 ? "char" : "chars"}`;
}

export type CopyResult = { copied: boolean; sinks: CopySink[] };

/** Fan a yank out to the enabled sinks. Empty text is a no-op. */
export function copyToClipboard(
  text: string,
  sinks: readonly CopySink[],
  effects: ClipboardEffects,
): CopyResult {
  if (text.length === 0) {
    return { copied: false, sinks: [] };
  }
  const ran: CopySink[] = [];
  for (const sink of sinks) {
    switch (sink) {
      case "internal":
        effects.setInternal(text);
        ran.push(sink);
        break;
      case "osc52":
        effects.writeOsc52(text);
        ran.push(sink);
        break;
      case "platform":
        // A platform tool (pbcopy/wl-copy/xclip) only reaches the local box;
        // over SSH the OSC 52 sink is the one that crosses the wire.
        if (effects.isRemoteSession()) {
          break;
        }
        effects.copyToPlatform(text);
        ran.push(sink);
        break;
    }
  }
  return { copied: ran.length > 0, sinks: ran };
}

export type ClipboardCommand = { command: string; args: readonly string[] };

/** The clipboard CLI for the host platform, or null when none is available. */
export function resolvePlatformClipboardCommand(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): ClipboardCommand | null {
  if (platform === "darwin") {
    return { command: "pbcopy", args: [] };
  }
  if (platform === "win32") {
    return { command: "clip", args: [] };
  }
  if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== "") {
    return { command: "wl-copy", args: [] };
  }
  if (env.DISPLAY !== undefined && env.DISPLAY !== "") {
    return { command: "xclip", args: ["-selection", "clipboard"] };
  }
  return null;
}

export function isRemoteSession(env: Record<string, string | undefined>): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

export type ClipboardEffectsDeps = {
  internal: InternalClipboard;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  writeToHost(sequence: string): void;
  spawnClipboard(command: ClipboardCommand, text: string): void;
};

/** Wire the real sinks (host stdout for OSC 52, a spawned CLI for platform). */
export function createClipboardEffects(deps: ClipboardEffectsDeps): ClipboardEffects {
  return {
    setInternal: (text) => deps.internal.set(text),
    writeOsc52: (text) => deps.writeToHost(buildOsc52Sequence(text)),
    copyToPlatform: (text) => {
      const command = resolvePlatformClipboardCommand(deps.platform, deps.env);
      if (command === null) {
        return;
      }
      deps.spawnClipboard(command, text);
    },
    isRemoteSession: () => isRemoteSession(deps.env),
  };
}
