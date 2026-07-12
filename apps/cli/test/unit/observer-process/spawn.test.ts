import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

    expect(observerSpawnArgv({ paths, startupTimeoutMs: 4321 })).toEqual([
      process.execPath,
      observerEntry,
      "--socket",
      paths.socketPath,
      "--state-dir",
      paths.stateDir,
      "--startup-timeout-ms",
      "4321",
    ]);
    expect(
      observerSpawnArgv({
        paths,
        configPath: "/tmp/station/config.toml",
        startupTimeoutMs: 9876,
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

  it("keeps real Worktrunk hook auto-start on the CLI observer entry", async () => {
    const source = await readFile(
      resolve(process.cwd(), "tests/e2e/real/real-worktrunk-hooks.test.ts"),
      "utf8",
    );

    expect(source).toContain('join(env.repoRoot, "apps", "cli", "dist", "observerMain.js")');
  });
});
