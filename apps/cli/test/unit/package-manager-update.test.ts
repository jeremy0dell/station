import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createHomebrewUpdateChannel } from "../../src/update/homebrewUpdate.js";
import { createMiseUpdateChannel } from "../../src/update/miseUpdate.js";
import { createNpmGlobalUpdateChannel } from "../../src/update/npmGlobalUpdate.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("package-manager update channels", () => {
  it("detects a Homebrew formula by physical ownership and defers its upgrade", async () => {
    const root = await tempRoot();
    const prefix = join(root, "homebrew");
    const runtimePath = join(prefix, "Cellar", "station", "1.0.0", "bin", "stn");
    const brewPath = await executable(join(root, "bin", "brew"));
    await executable(runtimePath);
    await mkdir(join(prefix, "bin"), { recursive: true });
    await symlink(runtimePath, join(prefix, "bin", "stn"));
    const commands: ExternalCommandInput[] = [];
    const channel = createHomebrewUpdateChannel({
      runtimePath,
      pathEnv: dirname(brewPath),
      commandRunner: async (input) => {
        commands.push(input);
        if (input.args?.[0] === "--prefix") return result(input, `${prefix}\n`);
        if (input.args?.[0] === "info") {
          return result(
            input,
            JSON.stringify({
              formulae: [
                {
                  name: "station",
                  full_name: "jeremy0dell/station/station",
                  versions: { stable: "1.1.0" },
                  installed: [{ version: "1.0.0" }],
                },
              ],
              casks: [],
            }),
          );
        }
        throw new Error(`Unexpected brew command: ${input.args?.join(" ")}`);
      },
    });

    const detection = await channel.detect();
    expect(detection).toMatchObject({ kind: "formula", currentVersion: "1.0.0" });
    if (detection === undefined) throw new Error("expected Homebrew detection");
    const plan = await channel.plan(detection);
    expect(plan).toMatchObject({
      status: "update-available",
      targetVersion: "1.1.0",
      managerCommand: [brewPath, "upgrade", "--formula", "jeremy0dell/station/station"],
    });
    expect(await channel.apply(plan)).toMatchObject({
      status: "deferred",
      installedVersion: "1.0.0",
    });
    expect(commands.some(({ args }) => args?.[0] === "upgrade")).toBe(false);
  });

  it("detects a scoped npm global package from its stn bin entry", async () => {
    const root = await tempRoot();
    const prefix = join(root, "npm-prefix");
    const packageRoot = join(prefix, "lib", "node_modules");
    const packageDir = join(packageRoot, "@station", "cli");
    const entryPath = await executable(join(packageDir, "bin", "stn"));
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@station/cli", version: "1.0.0", bin: { stn: "bin/stn" } }),
    );
    await mkdir(join(prefix, "bin"), { recursive: true });
    await symlink(entryPath, join(prefix, "bin", "stn"));
    const npmPath = await executable(join(root, "bin", "npm"));
    const commands: ExternalCommandInput[] = [];
    const channel = createNpmGlobalUpdateChannel({
      runtimePath: entryPath,
      pathEnv: dirname(npmPath),
      commandRunner: async (input) => {
        commands.push(input);
        if (input.args?.join(" ") === "root --global") return result(input, `${packageRoot}\n`);
        if (input.args?.join(" ") === "prefix --global") return result(input, `${prefix}\n`);
        if (input.args?.[0] === "view") return result(input, JSON.stringify("1.2.0"));
        throw new Error(`Unexpected npm command: ${input.args?.join(" ")}`);
      },
    });

    const detection = await channel.detect();
    expect(detection).toMatchObject({ packageName: "@station/cli", currentVersion: "1.0.0" });
    if (detection === undefined) throw new Error("expected npm detection");
    const plan = await channel.plan(detection);
    expect(plan).toMatchObject({
      targetVersion: "1.2.0",
      managerCommand: [npmPath, "install", "--global", "@station/cli@1.2.0"],
    });
    await channel.apply(plan);
    expect(commands.some(({ args }) => args?.[0] === "install")).toBe(false);
  });

  it("detects an active mise tool and preserves its configured upgrade range", async () => {
    const root = await tempRoot();
    const installPath = join(root, "mise", "installs", "station", "1.0.0");
    const runtimePath = await executable(join(installPath, "bin", "stn"));
    const misePath = await executable(join(root, "bin", "mise"));
    const commands: ExternalCommandInput[] = [];
    const channel = createMiseUpdateChannel({
      runtimePath,
      pathEnv: dirname(misePath),
      commandRunner: async (input) => {
        commands.push(input);
        if (input.args?.[0] === "ls") {
          return result(
            input,
            JSON.stringify({ station: [{ version: "1.0.0", install_path: installPath }] }),
          );
        }
        if (input.args?.[0] === "outdated") {
          return result(input, JSON.stringify({ station: { current: "1.0.0", latest: "1.4.0" } }));
        }
        throw new Error(`Unexpected mise command: ${input.args?.join(" ")}`);
      },
    });

    const detection = await channel.detect();
    expect(detection).toMatchObject({ tool: "station", currentVersion: "1.0.0" });
    if (detection === undefined) throw new Error("expected mise detection");
    const plan = await channel.plan(detection);
    expect(plan).toMatchObject({
      targetVersion: "1.4.0",
      managerCommand: [misePath, "upgrade", "station"],
      successorCli: [misePath, "exec", "--", "stn"],
    });
    await expect(
      channel.apply(
        { ...plan, managerCommand: [misePath, "upgrade", "another-tool"] },
        { drivePackageManager: true },
      ),
    ).rejects.toMatchObject({ code: "UPDATE_PLAN_INVALID" });
    expect(commands.some(({ args }) => args?.[0] === "upgrade")).toBe(false);
  });

  it("fails visibly when an installed manager returns malformed data", async () => {
    const root = await tempRoot();
    const runtimePath = await executable(join(root, "runtime", "stn"));
    const misePath = await executable(join(root, "bin", "mise"));
    const channel = createMiseUpdateChannel({
      runtimePath,
      pathEnv: dirname(misePath),
      commandRunner: async (input) => result(input, "not-json"),
    });

    await expect(channel.detect()).rejects.toMatchObject({
      code: "UPDATE_CHANNEL_DETECT_FAILED",
    });
  });
});

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "station-manager-update-test-"));
  cleanup.push(path);
  return path;
}

async function executable(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
