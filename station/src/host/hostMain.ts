import { startStationHost } from "./startHost.js";
import type { PreparedPtyRuntime } from "../bin/packagedAssets.js";

export type RunStationHostMainOptions = {
  /** Compiled entrypoint seam: prepare embedded PTY assets for the parsed state dir. */
  preparePtyRuntime?: (stateDir: string) => Promise<PreparedPtyRuntime>;
};

function parseArgs(argv: readonly string[]): { socketPath: string; stateDir: string } {
  let socketPath: string | undefined;
  let stateDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--socket") {
      socketPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--state-dir") {
      stateDir = argv[i + 1];
      i += 1;
    }
  }
  if (socketPath === undefined || stateDir === undefined) {
    process.stderr.write("station-station-host requires --socket <path> --state-dir <dir>\n");
    process.exit(2);
  }
  return { socketPath, stateDir };
}

/**
 * Standalone station-station-host daemon entry, spawned detached by the
 * observer-side station provider. Parses raw --socket/--state-dir arguments and
 * shuts down cleanly on signal. Compiled startup may inject packaged PTY
 * preparation without changing the source-host default.
 */
export async function runStationHostMain(
  argv: readonly string[],
  options: RunStationHostMainOptions = {},
): Promise<void> {
  const { socketPath, stateDir } = parseArgs(argv);
  const ptyRuntime = await options.preparePtyRuntime?.(stateDir);
  let host;
  try {
    host = await startStationHost({
      socketPath,
      stateDir,
      ...(ptyRuntime === undefined
        ? {}
        : {
            ptyImplementation: ptyRuntime.implementation,
            ptyTableOptions: { createTerminal: ptyRuntime.createTerminal },
          }),
    });
  } catch (error) {
    ptyRuntime?.dispose();
    throw error;
  }

  const shutdown = () => {
    void host.close().finally(() => {
      ptyRuntime?.dispose();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) {
  await runStationHostMain(process.argv.slice(2));
}
