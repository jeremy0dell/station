import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  ChildProcessLike,
  SpawnStationHostInput,
  StationHostCommand,
} from "@station/terminal";

const fixtureEntry = fileURLToPath(
  new URL("../fixtures/listening-station-host.mjs", import.meta.url),
);

export function listeningStationHostCommand(): StationHostCommand {
  return [process.execPath, fixtureEntry];
}

export function createListeningStationHostFixture(): {
  spawnHost(input: SpawnStationHostInput): ChildProcessLike;
  stop(): Promise<void>;
} {
  let child: ChildProcess | undefined;
  let settled: Promise<void> | undefined;
  return {
    spawnHost(input) {
      const [command, ...args] = input.argv;
      child = spawn(command, args, input.spawnOptions);
      settled = new Promise((resolve) => {
        child?.once("exit", () => resolve());
        child?.once("close", () => resolve());
        child?.once("error", () => resolve());
      });
      return child;
    },
    async stop() {
      if (child === undefined || settled === undefined || child.exitCode !== null) return;
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        settled.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      if (!stopped && child.exitCode === null) {
        child.kill("SIGKILL");
        await settled;
      }
    },
  };
}
