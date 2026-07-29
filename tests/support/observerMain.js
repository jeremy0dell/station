import { execFileSync } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.env.STATION_TEST_REPO_ROOT;
if (repoRoot === undefined) throw new Error("STATION_TEST_REPO_ROOT is required.");
const [{ STATION_SCHEMA_VERSION }, { startProtocolServer }] = await Promise.all([
  import(pathToFileURL(join(repoRoot, "packages/contracts/dist/index.js")).href),
  import(pathToFileURL(join(repoRoot, "packages/protocol/dist/index.js")).href),
]);

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const pidfilePath = `${options.socketPath}.pid`;
let server;
let closing = false;

const stop = async () => {
  if (options.mode === "graceful" && !closing) {
    closing = true;
    setTimeout(() => void closeAndExit(0), options.stopDelayMs).unref();
  }
  return {
    schemaVersion: STATION_SCHEMA_VERSION,
    stopped: true,
    at: new Date().toISOString(),
  };
};

server = await startProtocolServer({
  socketPath: options.socketPath,
  api: {
    health: async () => ({
      schemaVersion: STATION_SCHEMA_VERSION,
      status: "healthy",
      pid: process.pid,
      startedAt,
      version: options.version,
      socketPath: options.socketPath,
      stateDir: options.stateDir,
    }),
    stop,
  },
});

await writeFile(
  pidfilePath,
  `${JSON.stringify({
    pid: process.pid,
    osStartTime: readOsStartTime(process.pid),
    processToken: options.processToken,
    version: options.pidfileVersion ?? options.version,
    socketPath: options.socketPath,
  })}\n`,
  { mode: 0o600 },
);

process.on("SIGTERM", () => {
  if (options.mode === "graceful") void closeAndExit(0);
});
process.on("SIGINT", () => void closeAndExit(0));

async function closeAndExit(code) {
  if (!closing) closing = true;
  await unlink(pidfilePath).catch(() => undefined);
  await server?.close().catch(() => undefined);
  process.exit(code);
}

function parseArgs(argv) {
  const result = {
    socketPath: undefined,
    stateDir: undefined,
    version: undefined,
    processToken: undefined,
    startupTimeoutMs: undefined,
    pidfileVersion: process.env.STATION_TEST_PIDFILE_VERSION,
    mode: process.env.STATION_TEST_OBSERVER_MODE ?? "graceful",
    stopDelayMs: Number(process.env.STATION_TEST_STOP_DELAY_MS ?? 100),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--socket" && value !== undefined) result.socketPath = value;
    else if (arg === "--state-dir" && value !== undefined) result.stateDir = value;
    else if (arg === "--startup-timeout-ms" && value !== undefined) {
      result.startupTimeoutMs = Number(value);
    } else if (arg === "--build-version" && value !== undefined) result.version = value;
    else if (arg === "--process-token" && value !== undefined) result.processToken = value;
    else continue;
    index += 1;
  }
  if (
    typeof result.socketPath !== "string" ||
    typeof result.stateDir !== "string" ||
    typeof result.version !== "string" ||
    typeof result.processToken !== "string" ||
    !Number.isSafeInteger(result.startupTimeoutMs) ||
    result.startupTimeoutMs <= 0 ||
    (result.mode !== "graceful" && result.mode !== "wedged") ||
    !Number.isSafeInteger(result.stopDelayMs) ||
    result.stopDelayMs < 0
  ) {
    throw new Error("Invalid observer incumbent fixture arguments.");
  }
  return result;
}

function readOsStartTime(pid) {
  const psPath = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  return execFileSync(psPath, ["-ww", "-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}
