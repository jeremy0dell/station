import { describe, expect, it } from "bun:test";
import {
  copyToClipboard,
  createClipboardEffects,
  DEFAULT_COPY_SINKS,
  isRemoteSession,
  resolvePlatformClipboardCommand,
  type ClipboardEffects,
} from "./clipboard.js";
import { createInternalClipboard } from "./internalClipboard.js";

function recordingEffects(overrides?: Partial<ClipboardEffects>): {
  effects: ClipboardEffects;
  calls: string[];
} {
  const calls: string[] = [];
  const effects: ClipboardEffects = {
    setInternal: (text) => calls.push(`internal:${text}`),
    writeOsc52: (text) => calls.push(`osc52:${text}`),
    copyToPlatform: (text) => calls.push(`platform:${text}`),
    isRemoteSession: () => false,
    ...overrides,
  };
  return { effects, calls };
}

describe("copyToClipboard", () => {
  it("fans a yank out to every default sink locally", () => {
    const { effects, calls } = recordingEffects();
    const result = copyToClipboard("hello", DEFAULT_COPY_SINKS, effects);
    expect(result).toEqual({ copied: true, sinks: ["internal", "osc52", "platform"] });
    expect(calls).toEqual(["internal:hello", "osc52:hello", "platform:hello"]);
  });

  it("skips the platform sink on a remote session but keeps the others", () => {
    const { effects, calls } = recordingEffects({ isRemoteSession: () => true });
    const result = copyToClipboard("hello", DEFAULT_COPY_SINKS, effects);
    expect(result.sinks).toEqual(["internal", "osc52"]);
    expect(calls).toEqual(["internal:hello", "osc52:hello"]);
  });

  it("is a no-op for empty text", () => {
    const { effects, calls } = recordingEffects();
    expect(copyToClipboard("", DEFAULT_COPY_SINKS, effects)).toEqual({ copied: false, sinks: [] });
    expect(calls).toEqual([]);
  });
});

describe("resolvePlatformClipboardCommand", () => {
  it("uses pbcopy on macOS", () => {
    expect(resolvePlatformClipboardCommand("darwin", {})).toEqual({ command: "pbcopy", args: [] });
  });

  it("prefers wl-copy under Wayland and xclip under X11", () => {
    expect(resolvePlatformClipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({
      command: "wl-copy",
      args: [],
    });
    expect(resolvePlatformClipboardCommand("linux", { DISPLAY: ":0" })).toEqual({
      command: "xclip",
      args: ["-selection", "clipboard"],
    });
  });

  it("returns null on a headless Linux box", () => {
    expect(resolvePlatformClipboardCommand("linux", {})).toBeNull();
  });
});

describe("isRemoteSession", () => {
  it("detects SSH via the usual env vars", () => {
    expect(isRemoteSession({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" })).toBe(true);
    expect(isRemoteSession({})).toBe(false);
  });
});

describe("createClipboardEffects", () => {
  it("routes OSC 52 to the host and the platform command to spawn", () => {
    const internal = createInternalClipboard();
    const host: string[] = [];
    const spawned: Array<{ command: string; text: string }> = [];
    const effects = createClipboardEffects({
      internal,
      env: {},
      platform: "darwin",
      writeToHost: (sequence) => host.push(sequence),
      spawnClipboard: (command, text) => spawned.push({ command: command.command, text }),
    });

    copyToClipboard("yank", DEFAULT_COPY_SINKS, effects);
    expect(internal.get()).toBe("yank");
    expect(host[0]?.startsWith("\x1b]52;c;")).toBe(true);
    expect(spawned).toEqual([{ command: "pbcopy", text: "yank" }]);
  });
});
