import { describe, expect, it } from "bun:test";
import { playStationAttentionSound } from "./attentionSound.js";

describe("playStationAttentionSound", () => {
  it("skips outside macOS", () => {
    const result = playStationAttentionSound({
      platform: "linux",
      existsSync: () => {
        throw new Error("should not stat files");
      },
      spawn: () => {
        throw new Error("should not spawn");
      },
    });

    expect(result).toEqual({ status: "skipped", reason: "unsupported-platform" });
  });

  it("skips when the macOS sound player is missing", () => {
    const result = playStationAttentionSound({
      platform: "darwin",
      existsSync: (path) => path !== "/usr/bin/afplay",
      spawn: () => {
        throw new Error("should not spawn");
      },
    });

    expect(result).toEqual({ status: "skipped", reason: "missing-player" });
  });

  it("skips when the macOS sound file is missing", () => {
    const result = playStationAttentionSound({
      platform: "darwin",
      existsSync: (path) => path === "/usr/bin/afplay",
      spawn: () => {
        throw new Error("should not spawn");
      },
    });

    expect(result).toEqual({ status: "skipped", reason: "missing-sound" });
  });

  it("starts afplay with fixed arguments and no shell", () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { detached: true; stdio: "ignore" };
    }> = [];
    let errorHandlerAttached = false;
    let unrefCalled = false;

    const result = playStationAttentionSound({
      platform: "darwin",
      existsSync: () => true,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return {
          on: (event) => {
            errorHandlerAttached = event === "error";
          },
          unref: () => {
            unrefCalled = true;
          },
        };
      },
    });

    expect(result).toEqual({
      status: "started",
      command: "/usr/bin/afplay",
      soundPath: "/System/Library/Sounds/Ping.aiff",
    });
    expect(calls).toEqual([
      {
        command: "/usr/bin/afplay",
        args: ["/System/Library/Sounds/Ping.aiff"],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
    expect(errorHandlerAttached).toBe(true);
    expect(unrefCalled).toBe(true);
  });
});
