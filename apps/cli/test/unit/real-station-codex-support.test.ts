import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexSentinel,
  createRealCodexFixture,
} from "../../../../tests/support/real-station/codex.js";
import type { RealE2eEnvironment } from "../../../../tests/support/real-station/env.js";
import type { RealTempRepo } from "../../../../tests/support/real-station/repo.js";

describe("real Station Codex support", () => {
  it("targets an explicit worktree in the prompt and sentinel path", () => {
    const repo: RealTempRepo = {
      root: "/tmp/station-real-e2e",
      repoPath: "/tmp/station-real-e2e/repo",
      realE2eDir: "/tmp/station-real-e2e/repo/.station-real-e2e",
      baseBranch: "main",
      cleanup: async () => undefined,
    };
    const targetRoot = "/tmp/station-real-e2e/worktrees/existing";

    const sentinel = createCodexSentinel(repo, "start-agent", targetRoot);

    expect(sentinel.absolutePath).toBe(join(targetRoot, sentinel.relativePath));
    expect(sentinel.prompt.split("\n")).toContain(
      `Create or overwrite only ${sentinel.absolutePath}.`,
    );
  });

  it("wraps Station and Codex with the same private Codex home", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-real-codex-support-"));
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
      codexBin: "/usr/local/bin/codex",
    };

    try {
      const fixture = await createRealCodexFixture({ env, repo });

      expect(fixture.codexHome).toBe(join(root, "codex-home"));
      await expect(readFile(fixture.env.stationBin, "utf8")).resolves.toContain(
        `export CODEX_HOME='${fixture.codexHome}'`,
      );
      await expect(readFile(fixture.codexCommand, "utf8")).resolves.toContain(
        `export CODEX_HOME='${fixture.codexHome}'`,
      );
      await expect(readFile(join(fixture.codexHome, "config.toml"), "utf8")).resolves.toContain(
        "hooks = true",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
