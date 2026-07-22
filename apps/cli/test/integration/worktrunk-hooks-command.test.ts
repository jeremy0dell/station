import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import { loadConfig } from "@station/config";
import { providerHookCommandLine } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../../src/observerProviders";

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
          "post-create": providerHookCommandLine(
            "worktrunk",
            {
              hookBin: "/opt/stn-ingress",
              observerSocketPath: join(root, "run", "observer.sock"),
              stateDir: join(root, "state"),
              hookSpoolDir: join(root, "state", "spool", "hooks"),
              stationConfigPath: configPath,
            },
            "post-create",
          ),
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

  it("uses one composed expectation for install and standalone doctor", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-wt-hooks-"));
    const worktrunkCommand = join(root, "wt");
    await writeFile(
      worktrunkCommand,
      '#!/bin/sh\ncase "$*" in\n  "--version") echo "wt 0.68.0" ;;\n  *) echo "--no-hooks --yes" ;;\nesac\n',
    );
    await chmod(worktrunkCommand, 0o700);
    const configPath = await writeConfig(root, worktrunkCommand);
    const worktrunkConfigPath = join(root, "worktrunk", "config.toml");
    const ingressLauncher = join(root, "installed", "stn-ingress");
    const cliOptions = { providerHookIngressLauncher: ingressLauncher };

    const installed = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "worktrunk",
        "--yes",
        "--worktrunk-config",
        worktrunkConfigPath,
      ],
      cliOptions,
    );
    const doctored = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "doctor",
        "worktrunk",
        "--worktrunk-config",
        worktrunkConfigPath,
      ],
      cliOptions,
    );

    expect(installed).toMatchObject({ code: 0, output: { installed: true } });
    expect(doctored).toMatchObject({
      code: 0,
      output: {
        status: "ok",
        commands: {
          "post-create": expect.stringContaining(ingressLauncher),
        },
      },
    });
    await expect(readFile(worktrunkConfigPath, "utf8")).resolves.toContain(ingressLauncher);

    const loaded = await loadConfig(configPath);
    const registry = createProviderRegistry(loaded.config, {
      configPath: loaded.configPath,
      providerHookIngressLauncher: ingressLauncher,
    });
    await expect(registry.worktree.doctorChecks?.()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "worktrunk-hooks", status: "ok" })]),
    );
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

async function writeConfig(root: string, worktrunkCommand = "wt"): Promise<string> {
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
      `command = ${JSON.stringify(worktrunkCommand)}`,
      `config_path = ${JSON.stringify(join(root, "worktrunk", "config.toml"))}`,
      "",
    ].join("\n"),
  );
  return configPath;
}
