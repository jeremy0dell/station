import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";

type SpawnedSoundProcess = {
  on(event: "error", listener: () => void): unknown;
  unref(): void;
};

type SpawnSound = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore" },
) => SpawnedSoundProcess;

export type AttentionSoundResult =
  | { status: "started"; command: string; soundPath: string }
  | { status: "skipped"; reason: "unsupported-platform" | "missing-player" | "missing-sound" }
  | { status: "failed"; reason: "spawn-failed" };

export type AttentionSoundOptions = {
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  spawn?: SpawnSound;
};

// macOS ships afplay and system alert sounds at stable absolute paths. Check
// both before spawning so the UI degrades quietly on unusual installations.
const macAttentionSound = {
  player: "/usr/bin/afplay",
  soundPath: "/System/Library/Sounds/Ping.aiff",
} as const;

export function playStationAttentionSound(
  options: AttentionSoundOptions = {},
): AttentionSoundResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { status: "skipped", reason: "unsupported-platform" };
  }

  const existsSync = options.existsSync ?? nodeExistsSync;
  if (!existsSync(macAttentionSound.player)) {
    return { status: "skipped", reason: "missing-player" };
  }
  if (!existsSync(macAttentionSound.soundPath)) {
    return { status: "skipped", reason: "missing-sound" };
  }

  const spawn = options.spawn ?? defaultSpawnSound;
  try {
    const child = spawn(macAttentionSound.player, [macAttentionSound.soundPath], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return {
      status: "started",
      command: macAttentionSound.player,
      soundPath: macAttentionSound.soundPath,
    };
  } catch {
    return { status: "failed", reason: "spawn-failed" };
  }
}

const defaultSpawnSound: SpawnSound = (command, args, options) => nodeSpawn(command, args, options);
