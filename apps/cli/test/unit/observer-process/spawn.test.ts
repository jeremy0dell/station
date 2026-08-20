import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { observerSpawnArgv, observerSpawnEnvironment } from "../../../src/observerProcess/spawn.js";
import { selfExecArgv } from "../../../src/selfExec.js";

const paths = {
  socketPath: "/tmp/station/run/observer.sock",
  stateDir: "/tmp/station",
  dbPath: "/tmp/station/observer.sqlite",
  logDir: "/tmp/station/logs",
  diagnosticsDir: "/tmp/station/diagnostics",
  hookSpoolDir: "/tmp/station/spool/hooks",
};
const buildVersion = `1.2.3+station.${"a".repeat(64)}`;
const processToken = ["a47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");

describe("observer spawn argv", () => {
  it("keeps the source entry prefix and observer flag order", () => {
    const observerEntry = fileURLToPath(new URL("../../../dist/observerMain.js", import.meta.url));

    expect(
      observerSpawnArgv({ paths, startupTimeoutMs: 4321, buildVersion, processToken }),
    ).toEqual([
      process.execPath,
      observerEntry,
      "--socket",
      paths.socketPath,
      "--state-dir",
      paths.stateDir,
      "--startup-timeout-ms",
      "4321",
      "--build-version",
      buildVersion,
      "--process-token",
      processToken,
    ]);
    expect(
      observerSpawnArgv({
        paths,
        configPath: "/tmp/station/config.toml",
        startupTimeoutMs: 9876,
        buildVersion,
        processToken,
      }),
    ).toEqual([
      process.execPath,
      observerEntry,
      "--socket",
      paths.socketPath,
      "--state-dir",
      paths.stateDir,
      "--config",
      "/tmp/station/config.toml",
      "--startup-timeout-ms",
      "9876",
      "--build-version",
      buildVersion,
      "--process-token",
      processToken,
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

  it("keeps generic startup fail-closed and opts only exact activation into preservation", () => {
    const inherited = {
      PATH: "/usr/bin",
      STATION_OBSERVER_STARTUP_POLICY: "preserve-incumbent",
    };

    expect(observerSpawnEnvironment({}, inherited)).toEqual({ PATH: "/usr/bin" });
    expect(observerSpawnEnvironment({ incumbentPolicy: "preserve" }, inherited)).toEqual({
      PATH: "/usr/bin",
      STATION_OBSERVER_STARTUP_POLICY: "preserve-incumbent",
    });
  });

  it("keeps real Worktrunk hook auto-start on the CLI observer entry", async () => {
    const source = await readFile(
      resolve(process.cwd(), "tests/e2e/real/real-worktrunk-hooks.test.ts"),
      "utf8",
    );

    expect(source).toContain('join(env.repoRoot, "apps", "cli", "dist", "observerMain.js")');
  });
});
