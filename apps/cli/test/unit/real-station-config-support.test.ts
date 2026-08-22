import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRealStationConfig } from "../../../../tests/support/real-station/config.js";
import type { RealE2eEnvironment } from "../../../../tests/support/real-station/env.js";
import type { RealTempRepo } from "../../../../tests/support/real-station/repo.js";

describe("real Station config support", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("creates private Observer directories and writes scripted harness config", async () => {
    root = await mkdtemp(join(tmpdir(), "station-real-config-support-"));
    const repo: RealTempRepo = {
      root,
      repoPath: join(root, "repo"),
      realE2eDir: join(root, "repo", ".station-real-e2e"),
      baseBranch: "main",
      cleanup: async () => undefined,
    };
    const env: RealE2eEnvironment = {
      repoRoot: "/station",
      stationBin: "/station/bin/stn",
      stationIngressBin: "/station/bin/stn-ingress",
      worktrunkBin: "/usr/local/bin/wt",
    };

    const fixture = await writeRealStationConfig({
      env,
      repo,
      harnessProvider: "scripted",
      scriptedCommand: "/usr/local/bin/node",
    });

    await expect(directoryMode(fixture.stateDir)).resolves.toBe(0o700);
    await expect(directoryMode(join(root, "run"))).resolves.toBe(0o700);
    await expect(readFile(fixture.configPath, "utf8")).resolves.toContain(
      '[harness.scripted]\nenabled = true\ncommand = "/usr/local/bin/node"',
    );
  });
});

async function directoryMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}
