import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { observerSpawnArgv } from "../../../src/observerProcess/spawn.js";
import { selfExecArgv } from "../../../src/selfExec.js";

const paths = {
  socketPath: "/tmp/station/run/observer.sock",
  stateDir: "/tmp/station",
  hookSpoolDir: "/tmp/station/spool/hooks",
};

describe("observer spawn argv", () => {
  it("keeps the source entry prefix and observer flag order", () => {
    const observerEntry = fileURLToPath(new URL("../../../dist/observerMain.js", import.meta.url));

    expect(observerSpawnArgv({ paths })).toEqual([
      process.execPath,
      observerEntry,
      "--socket",
      paths.socketPath,
      "--state-dir",
      paths.stateDir,
    ]);
    expect(observerSpawnArgv({ paths, configPath: "/tmp/station/config.toml" })).toEqual([
      process.execPath,
      observerEntry,
      "--socket",
      paths.socketPath,
      "--state-dir",
      paths.stateDir,
      "--config",
      "/tmp/station/config.toml",
    ]);
  });

  it("maps the compiled observer prefix without claiming compiled spawn coverage", () => {
    expect(
      selfExecArgv("observer", ["node", "observerMain.js"], {
        compiled: true,
        execPath: "/opt/station/stn",
      }),
    ).toEqual(["/opt/station/stn", "__observer"]);
  });
});
