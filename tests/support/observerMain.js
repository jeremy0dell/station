import { execFileSync } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { STATION_SCHEMA_VERSION } from "../../packages/contracts/dist/index.js";
import { startProtocolServer } from "../../packages/protocol/dist/index.js";

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
    pidfileVersion: undefined,
    mode: "graceful",
    stopDelayMs: 100,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--socket" && value !== undefined) result.socketPath = value;
    else if (arg === "--state-dir" && value !== undefined) result.stateDir = value;
    else if (arg === "--version" && value !== undefined) result.version = value;
    else if (arg === "--pidfile-version" && value !== undefined) result.pidfileVersion = value;
    else if (arg === "--mode" && value !== undefined) result.mode = value;
    else if (arg === "--stop-delay-ms" && value !== undefined) result.stopDelayMs = Number(value);
    else continue;
    index += 1;
  }
  if (
    typeof result.socketPath !== "string" ||
    typeof result.stateDir !== "string" ||
    typeof result.version !== "string" ||
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
  }).trim();
}
