import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runExternalCommand } from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/update-host-client-disposal-child.mjs",
);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("update Host default client ownership", () => {
  it("closes the default per-inspection client so the source process exits", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-update-host-client-"));
    directories.push(stateDir);
    const result = await runExternalCommand({
      command: process.execPath,
      args: [fixture],
      env: { STATION_TEST_UPDATE_HOST_STATE_DIR: stateDir },
      timeoutMs: 5_000,
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "inspected",
      relation: "matching-target",
      compatibility: "reuse",
      terminals: [],
    });
  });
});
