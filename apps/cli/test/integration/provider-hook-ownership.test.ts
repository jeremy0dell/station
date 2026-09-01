import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "@station/cli";
import type { ProviderHookArtifactOwner } from "@station/contracts";
import { providerHookOwnerMarker } from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("provider hook ownership across Station runtimes", () => {
  it("refuses, transfers, and repairs a Codex hook between installed and source launchers", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-hook-owner-runtimes-"));
    const configPath = await writeConfig(root);
    const hookDir = join(root, "state", "hooks");
    const hookScriptPath = join(hookDir, "station-codex-hook.sh");
    const installedOwner = artifactOwner("/opt/station/bin/stn-ingress", "compiled", "a");
    const runtimeDir = join(root, "runtime");
    const libraryOptions = {
      env: { CODEX_HOME: join(root, "codex-home") },
      providerHookIngressLauncher: installedOwner.launcher,
      providerHookArtifactOwner: installedOwner,
    };
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: join(root, "home"),
      CODEX_HOME: join(root, "codex-home"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_RUNTIME_DIR: runtimeDir,
      NO_COLOR: "1",
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    };
    await mkdir(runtimeDir, { recursive: true });

    const installedRepair = await runCli(
      ["--config", configPath, "hooks", "install", "codex", "--yes"],
      libraryOptions,
    );
    expect(installedRepair).toMatchObject({
      code: 0,
      output: {
        status: "ok",
        verified: true,
        ownership: { status: "same-owner", requested: installedOwner },
        doctor: {
          status: "ok",
          installed: true,
          ownership: { status: "same-owner", requested: installedOwner },
        },
      },
    });
    const installedScript = await readFile(hookScriptPath, "utf8");
    const installedEntries = await readdir(hookDir);

    const refused = await runSourceCli(
      ["--config", configPath, "hooks", "install", "codex", "--yes"],
      processEnv,
    );
    expect(refused.exitCode).toBe(1);
    expect(`${refused.stdout}\n${refused.stderr}`).toContain(
      "stn hooks install codex --yes --takeover",
    );
    await expect(readFile(hookScriptPath, "utf8")).resolves.toBe(installedScript);
    expect(await readdir(hookDir)).toEqual(installedEntries);

    const sourceDoctor = await runSourceCli(
      ["--config", configPath, "hooks", "doctor", "codex"],
      processEnv,
    );
    expect(sourceDoctor.exitCode).toBe(1);
    const sourceConflict = JSON.parse(sourceDoctor.stdout) as {
      ownership: {
        status: string;
        requested: ProviderHookArtifactOwner;
        current: ProviderHookArtifactOwner;
      };
    };
    expect(sourceConflict.ownership).toMatchObject({
      status: "different-owner",
      current: installedOwner,
      requested: {
        launcher: join(process.cwd(), "bin", "stn-ingress"),
        runtimeKind: "source",
      },
    });

    const takeover = await runSourceCli(
      ["--config", configPath, "hooks", "install", "codex", "--yes", "--takeover"],
      processEnv,
    );
    expect(takeover.exitCode, `${takeover.stdout}\n${takeover.stderr}`).toBe(0);
    const sourceRepair = JSON.parse(takeover.stdout) as {
      status: string;
      verified: boolean;
      ownership: { requested: ProviderHookArtifactOwner };
      doctor: { installed: boolean; ownership: { requested: ProviderHookArtifactOwner } };
    };
    expect(sourceRepair).toMatchObject({
      status: "ok",
      verified: true,
      ownership: {
        requested: {
          launcher: join(process.cwd(), "bin", "stn-ingress"),
          runtimeKind: "source",
        },
      },
      doctor: {
        installed: true,
        ownership: {
          requested: {
            launcher: join(process.cwd(), "bin", "stn-ingress"),
            runtimeKind: "source",
          },
        },
      },
    });
    const sourceScript = await readFile(hookScriptPath, "utf8");
    expect(sourceScript).not.toBe(installedScript);
    expect(sourceScript).toContain(join(process.cwd(), "bin", "stn-ingress"));
    expect(sourceScript).not.toContain(providerHookOwnerMarker(installedOwner));
    await expect(
      runSourceCli(["--config", configPath, "hooks", "doctor", "codex"], processEnv),
    ).resolves.toMatchObject({ exitCode: 0 });

    await expect(
      runCli(["--config", configPath, "hooks", "install", "codex", "--yes"], libraryOptions),
    ).rejects.toMatchObject({ code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT" });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toBe(sourceScript);

    const installedTakeover = await runCli(
      ["--config", configPath, "hooks", "install", "codex", "--yes", "--takeover"],
      libraryOptions,
    );
    expect(installedTakeover).toMatchObject({
      code: 0,
      output: {
        status: "ok",
        verified: true,
        ownership: { status: "same-owner", requested: installedOwner },
        doctor: {
          status: "ok",
          installed: true,
          ownership: { status: "same-owner", requested: installedOwner },
        },
      },
    });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toContain(
      providerHookOwnerMarker(installedOwner),
    );
    const entriesAfterTakeover = await readdir(hookDir);
    const repeatedRepair = await runCli(
      ["--config", configPath, "hooks", "install", "codex", "--yes"],
      libraryOptions,
    );
    expect(repeatedRepair).toMatchObject({
      code: 0,
      output: {
        status: "ok",
        verified: true,
        changed: false,
        ownership: { status: "same-owner", requested: installedOwner },
        doctor: {
          status: "ok",
          installed: true,
          ownership: { status: "same-owner", requested: installedOwner },
        },
      },
    });
    expect(repeatedRepair.output).not.toHaveProperty("backupPath");
    expect(repeatedRepair.output).not.toHaveProperty("backupPaths");
    expect(await readdir(hookDir)).toEqual(entriesAfterTakeover);
    await expect(
      runCli(["--config", configPath, "hooks", "doctor", "codex"], libraryOptions),
    ).resolves.toMatchObject({
      code: 0,
      output: { ownership: { status: "same-owner", requested: installedOwner } },
    });
    await expect(
      runSourceCli(["--config", configPath, "hooks", "doctor", "codex"], processEnv),
    ).resolves.toMatchObject({ exitCode: 1 });
  });
});

async function runSourceCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(join(process.cwd(), "bin", "stn"), [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

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
      "[harness.codex]",
      'command = "codex"',
      "install_hooks = true",
      "",
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

function artifactOwner(
  launcher: string,
  runtimeKind: "compiled" | "source",
  digit: string,
): ProviderHookArtifactOwner {
  return {
    schemaVersion: 1,
    launcher,
    runtimeKind,
    version: runtimeKind === "compiled" ? "0.7.1" : "0.0.0-pre-alpha.13",
    buildIdentity: digit.repeat(64),
  };
}
