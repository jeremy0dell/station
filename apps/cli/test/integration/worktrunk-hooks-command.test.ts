import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { describe, expect, it } from "vitest";

describe("CLI Worktrunk hook commands", () => {
  it("plans Worktrunk hook changes without applying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-wt-hooks-"));
    const configPath = await writeConfig(root);
    const worktrunkConfigPath = join(root, "worktrunk", "config.toml");

    const result = await runCli([
      "--config",
      configPath,
      "worktrunk",
      "hooks",
      "plan",
      "--worktrunk-config",
      worktrunkConfigPath,
      "--hook-bin",
      "/opt/stn-ingress",
    ]);

    expect(result).toMatchObject({
      code: 0,
      output: {
        provider: "worktrunk",
        changed: true,
        configPath: worktrunkConfigPath,
        commands: {
          "post-create": `/opt/stn-ingress --socket ${join(root, "run", "observer.sock")} --state-dir ${join(root, "state")} --spool-dir ${join(root, "state", "spool", "hooks")} --config ${configPath} worktrunk post-create`,
        },
      },
    });
    await expect(readFile(worktrunkConfigPath, "utf8")).rejects.toThrow();
  });

  it("requires explicit confirmation before install", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-wt-hooks-"));
    const configPath = await writeConfig(root);

    await expect(runCli(["--config", configPath, "worktrunk", "hooks", "install"])).rejects.toThrow(
      "without --yes",
    );
  });

  it("falls back to the station-config worktrunk config_path when --worktrunk-config is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-wt-hooks-"));
    const worktrunkConfigPath = join(root, "configured", "worktrunk.toml");
    const configPath = join(root, "config.toml");
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(
      configPath,
      [
        "schema_version = 1",
        "projects = []",
        "",
        "[observer]",
        `socket_path = ${JSON.stringify(join(root, "run", "observer.sock"))}`,
        `state_dir = ${JSON.stringify(join(root, "state"))}`,
        "",
        "[defaults]",
        'worktree_provider = "worktrunk"',
        'terminal = "tmux"',
        'harness = "codex"',
        'layout = "agent-shell"',
        "",
        "[worktree.worktrunk]",
        'command = "wt"',
        `config_path = ${JSON.stringify(worktrunkConfigPath)}`,
        "",
      ].join("\n"),
    );

    const result = await runCli(["--config", configPath, "worktrunk", "hooks", "plan"]);

    expect(result).toMatchObject({
      code: 0,
      output: { provider: "worktrunk", configPath: worktrunkConfigPath },
    });
  });

  it("installs through both worktrunk hooks and generic hooks aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-wt-hooks-"));
    const configPath = await writeConfig(root);
    const worktrunkConfigPath = join(root, "worktrunk", "config.toml");

    const installed = await runCli([
      "--config",
      configPath,
      "worktrunk",
      "hooks",
      "install",
      "--yes",
      "--worktrunk-config",
      worktrunkConfigPath,
    ]);
    const uninstalled = await runCli([
      "--config",
      configPath,
      "hooks",
      "uninstall",
      "worktrunk",
      "--yes",
      "--worktrunk-config",
      worktrunkConfigPath,
    ]);

    expect(installed).toMatchObject({
      code: 0,
      output: {
        installed: true,
      },
    });
    expect(uninstalled).toMatchObject({
      code: 0,
      output: {
        installed: false,
      },
    });
  });

  it("plans and doctors through generic hooks aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-wt-hooks-"));
    const configPath = await writeConfig(root);
    const worktrunkConfigPath = join(root, "worktrunk", "config.toml");

    const planned = await runCli([
      "--config",
      configPath,
      "hooks",
      "plan",
      "worktrunk",
      "--worktrunk-config",
      worktrunkConfigPath,
    ]);
    const doctored = await runCli([
      "--config",
      configPath,
      "hooks",
      "doctor",
      "worktrunk",
      "--worktrunk-config",
      worktrunkConfigPath,
    ]);

    expect(planned).toMatchObject({
      code: 0,
      output: {
        provider: "worktrunk",
        changed: true,
      },
    });
    expect(doctored).toMatchObject({
      code: 1,
      output: {
        provider: "worktrunk",
        status: "warn",
      },
    });
  });
});

async function writeConfig(root: string): Promise<string> {
  const configPath = join(root, "config.toml");
  await mkdir(join(root, "state"), { recursive: true });
  await writeFile(
    configPath,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(join(root, "run", "observer.sock"))}`,
      `state_dir = ${JSON.stringify(join(root, "state"))}`,
      "",
      "[defaults]",
      'worktree_provider = "worktrunk"',
      'terminal = "tmux"',
      'harness = "codex"',
      'layout = "agent-shell"',
      "",
      "[worktree.worktrunk]",
      'command = "wt"',
      "",
    ].join("\n"),
  );
  return configPath;
}
