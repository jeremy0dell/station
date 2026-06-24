import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeWorktrunkProjectRoot,
  writeFakeWorktrunkBin,
} from "../support/fake-external-tools/worktrunk-bin";

describe("manual smoke CLI flow", () => {
  const configPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      configPaths
        .splice(0)
        .map((configPath) =>
          runCli(["--config", configPath, "observer", "stop"]).catch(() => undefined),
        ),
    );
  });

  it("starts observer, reconciles fake Worktrunk rows, and returns a JSON snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-manual-smoke-"));
    const configPath = await writeManualSmokeConfig(root);
    configPaths.push(configPath);

    await expect(
      runCli(["--config", configPath, "reconcile", "--reason", "manual-smoke"]),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        snapshot: {
          counts: { projects: 2, worktrees: 2 },
        },
      },
    });

    await expect(runCli(["--config", configPath, "snapshot", "--json"])).resolves.toMatchObject({
      code: 0,
      output: {
        rows: [
          expect.objectContaining({ projectId: "station", branch: "main" }),
          expect.objectContaining({ projectId: "germstack", branch: "main" }),
        ],
      },
    });
  }, 60_000);
});

async function writeManualSmokeConfig(root: string): Promise<string> {
  const stateDir = join(root, "state");
  const socketPath = join(root, "run", "observer.sock");
  const configPath = join(root, "config.toml");
  const wt = await writeFakeWorktrunkBin(root);
  const stationRoot = fakeWorktrunkProjectRoot(root, "station");
  const germstackRoot = fakeWorktrunkProjectRoot(root, "germstack");
  await mkdir(stationRoot, { recursive: true });
  await mkdir(germstackRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(socketPath)}`,
      `state_dir = ${JSON.stringify(stateDir)}`,
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "noop-terminal"',
      'harness = "noop-harness"',
      'layout = "agent-shell"',
      "",
      "[worktree.worktrunk]",
      `command = ${JSON.stringify(wt)}`,
      "use_lifecycle_hooks = false",
      'hook_mode = "disabled"',
      "",
      "[[projects]]",
      'id = "station"',
      'label = "station"',
      `root = ${JSON.stringify(stationRoot)}`,
      "",
      "[projects.defaults]",
      'harness = "noop-harness"',
      'terminal = "noop-terminal"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      "",
      "[[projects]]",
      'id = "germstack"',
      'label = "GermStack"',
      `root = ${JSON.stringify(germstackRoot)}`,
      "",
      "[projects.defaults]",
      'harness = "noop-harness"',
      'terminal = "noop-terminal"',
      'layout = "agent-shell"',
      "",
      "[projects.worktrunk]",
      "enabled = true",
      'base = "main"',
      "",
    ].join("\n"),
  );
  return configPath;
}
