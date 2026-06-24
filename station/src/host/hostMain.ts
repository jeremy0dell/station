import { startStationHost } from "./startHost.js";

/**
 * Standalone station-station-host daemon entry, spawned detached by the
 * observer-side station provider. Parses --socket/--state-dir and shuts down
 * cleanly on signal.
 */
function parseArgs(argv: string[]): { socketPath: string; stateDir: string } {
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

async function main(): Promise<void> {
  const { socketPath, stateDir } = parseArgs(process.argv.slice(2));
  const host = await startStationHost({ socketPath, stateDir });

  const shutdown = () => {
    void host.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
