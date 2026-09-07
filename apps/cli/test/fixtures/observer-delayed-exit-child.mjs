import { execFileSync } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.STATION_TEST_REPO_ROOT;
const [{ startProtocolServer }, { openObserverSqlite }] = await Promise.all([
  import(pathToFileURL(join(root, "packages/protocol/dist/index.js")).href),
  import(pathToFileURL(join(root, "apps/observer/dist/internal.js")).href),
]);
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const socketPath = value("--socket");
const stateDir = value("--state-dir");
const version = value("--build-version");
const startedAt = new Date().toISOString();
const sqlite = openObserverSqlite({ path: join(stateDir, "observer.sqlite") });
sqlite.database.exec("BEGIN IMMEDIATE");
const health = {
  schemaVersion: "0.13.0",
  status: "healthy",
  pid: process.pid,
  startedAt,
  version,
  socketPath,
  stateDir,
};
let stopping = false;
const server = await startProtocolServer({
  socketPath,
  api: {
    health: async () => health,
    getSessionRecoveryAssessment: async () => ({
      schemaVersion: 1,
      inventory: { schemaVersion: 1, sessions: [], recoveryHandles: [] },
      resumeEnabled: true,
      providerCapabilities: [],
      sessions: [],
    }),
    stop: async () => {
      if (!stopping) {
        stopping = true;
        setTimeout(async () => {
          await unlink(`${socketPath}.pid`);
          await server.close();
          await writeFile(
            join(stateDir, "lock-holder.json"),
            JSON.stringify({
              pid: process.pid,
              statement: "BEGIN IMMEDIATE",
              protocolClosed: true,
            }),
          );
          setTimeout(
            () => {
              sqlite.database.exec("ROLLBACK");
              sqlite.close();
              process.exit(0);
            },
            Number(process.env.STATION_TEST_STOP_DELAY_MS ?? 3000),
          );
        }, 20);
      }
      return { schemaVersion: "0.13.0", stopped: true, at: new Date().toISOString() };
    },
  },
});
await writeFile(
  `${socketPath}.pid`,
  JSON.stringify({
    pid: process.pid,
    osStartTime: execFileSync(
      process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps",
      ["-ww", "-p", String(process.pid), "-o", "lstart="],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
    ).trim(),
    processToken: value("--process-token"),
    version,
    socketPath,
  }),
  { mode: 0o600 },
);
