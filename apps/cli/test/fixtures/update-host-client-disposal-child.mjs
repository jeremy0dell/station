import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { emptyConfig, stationHostSocketPath } from "@station/config";
import { createUpdateHostRuntimeAdapter } from "../../dist/update/updateHostRuntimeAdapter.js";

const stateDir = process.env.STATION_TEST_UPDATE_HOST_STATE_DIR;
if (stateDir === undefined) throw new Error("Missing update Host fixture state directory.");

const buildIdentity = "a".repeat(64);
const config = emptyConfig();
config.observer = {
  stateDir,
  socketPath: join(stateDir, "run", "observer.sock"),
};
const socketPath = stationHostSocketPath(config);
await mkdir(dirname(socketPath), { recursive: true });

const server = createServer((socket) => {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      const request = JSON.parse(line);
      if (request.method === "host.clientShutdown") {
        socket.end();
        continue;
      }
      const result =
        request.method === "host.health"
          ? { ok: true, protocolVersion: 8, buildVersion: "1.0.0" }
          : request.method === "host.recoveryInventory"
            ? { buildIdentity, ptys: [] }
            : undefined;
      if (result === undefined)
        throw new Error(`Unexpected Host fixture method: ${request.method}`);
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    }
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});

const adapter = createUpdateHostRuntimeAdapter({
  config,
  buildInfo: () => ({ version: "1.0.0", buildIdentity, compiled: true }),
});
const evidence = await adapter.inspect({
  installed: { version: "1.0.0" },
  target: { version: "1.0.0" },
});
await new Promise((resolve, reject) => {
  server.close((error) => (error === undefined ? resolve() : reject(error)));
});
process.stdout.write(JSON.stringify(evidence));
