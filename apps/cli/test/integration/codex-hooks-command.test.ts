import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@station/cli";
import {
  commandLine,
  providerHookOwnerMarker,
  providerHookScriptRoutesByStationEnv,
} from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("CLI Codex hook commands", () => {
  it("plans Codex hook changes without applying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "codex", "station.config.toml");
    const baseConfigPath = join(root, "codex-home", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");

    const result = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "plan",
        "codex",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
        "--hook-bin",
        "/opt/stn-ingress",
      ],
      { env },
    );

    expect(result).toMatchObject({
      code: 0,
      output: {
        provider: "codex",
        changed: true,
        configPath: codexConfigPath,
        profileName: "station",
        profileConfigPath: codexConfigPath,
        baseConfigPath,
        hookScriptPath,
      },
    });
    await expect(readFile(codexConfigPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("requires explicit confirmation before install", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);

    await expect(runCli(["--config", configPath, "hooks", "install", "codex"])).rejects.toThrow(
      "without --yes",
    );
  });

  it("uses the composed ingress launcher when --hook-bin is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const providerHookIngressLauncher = join(root, "installed", "stn-ingress");
    const options = { env, providerHookIngressLauncher };

    await runCli(["--config", configPath, "hooks", "install", "codex", "--yes"], options);

    await expect(readFile(hookScriptPath, "utf8")).resolves.toContain(providerHookIngressLauncher);
    await expect(
      runCli(["--config", configPath, "hooks", "doctor", "codex"], options),
    ).resolves.toMatchObject({ code: 0, output: { installed: true, status: "ok" } });

    await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "codex",
        "--yes",
        "--hook-bin",
        "/explicit/stn-ingress",
      ],
      options,
    );
    const overriddenScript = await readFile(hookScriptPath, "utf8");
    expect(overriddenScript).toContain("/explicit/stn-ingress");
    expect(overriddenScript).not.toContain(providerHookIngressLauncher);
  });

  it("treats an explicit hook executable as the requested artifact owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hook-bin-owner-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const defaultOwner = artifactOwner(join(root, "installed", "stn-ingress"), "compiled", "a");
    const customHookBin = join(root, "custom-stn-ingress");
    await writeFile(customHookBin, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(customHookBin, 0o700);
    const options = {
      env,
      providerHookIngressLauncher: defaultOwner.launcher,
      providerHookArtifactOwner: defaultOwner,
    };

    await runCli(["--config", configPath, "hooks", "install", "codex", "--yes"], options);
    const beforeConflict = await readFile(hookScriptPath, "utf8");

    await expect(
      runCli(
        ["--config", configPath, "hooks", "install", "codex", "--yes", "--hook-bin", customHookBin],
        options,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT" });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toBe(beforeConflict);
    expect(
      (await readdir(join(root, "state", "hooks"))).some((name) => name.includes(".bak")),
    ).toBe(false);

    const takeover = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "codex",
        "--yes",
        "--takeover",
        "--hook-bin",
        customHookBin,
      ],
      options,
    );
    const customOwner = { ...defaultOwner, launcher: customHookBin };
    expect(takeover).toMatchObject({
      code: 0,
      output: { ownership: { status: "same-owner", requested: customOwner } },
    });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toContain(
      providerHookOwnerMarker(customOwner),
    );
    await expect(
      runCli(
        ["--config", configPath, "hooks", "doctor", "codex", "--hook-bin", customHookBin],
        options,
      ),
    ).resolves.toMatchObject({
      code: 0,
      output: { status: "ok", ownership: { status: "same-owner", requested: customOwner } },
    });
    await expect(
      runCli(["--config", configPath, "hooks", "doctor", "codex"], options),
    ).resolves.toMatchObject({
      code: 1,
      output: { status: "warn", ownership: { status: "different-owner" } },
    });

    await runCli(
      ["--config", configPath, "hooks", "install", "codex", "--yes", "--takeover"],
      options,
    );
    await expect(
      runCli(["--config", configPath, "hooks", "doctor", "codex"], options),
    ).resolves.toMatchObject({ code: 0, output: { ownership: { status: "same-owner" } } });
  });

  it("rejects an unresolved explicit hook executable before writing artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-missing-hook-bin-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const owner = artifactOwner(join(root, "installed", "stn-ingress"), "compiled", "a");

    await expect(
      runCli(
        [
          "--config",
          configPath,
          "hooks",
          "install",
          "codex",
          "--yes",
          "--hook-bin",
          join(root, "missing-stn-ingress"),
        ],
        {
          env,
          providerHookIngressLauncher: owner.launcher,
          providerHookArtifactOwner: owner,
        },
      ),
    ).rejects.toThrow("executable could not be resolved");
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("refuses cross-runtime overwrite until explicit takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-owner-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const installedOwner = artifactOwner(join(root, "installed", "stn-ingress"), "compiled", "a");
    const sourceOwner = artifactOwner(join(root, "source", "bin", "stn-ingress"), "source", "b");

    await runCli(["--config", configPath, "hooks", "install", "codex", "--yes"], {
      env,
      providerHookIngressLauncher: installedOwner.launcher,
      providerHookArtifactOwner: installedOwner,
    });
    const installedScript = await readFile(hookScriptPath, "utf8");

    await expect(
      runCli(["--config", configPath, "hooks", "plan", "codex"], {
        env,
        providerHookIngressLauncher: sourceOwner.launcher,
        providerHookArtifactOwner: sourceOwner,
      }),
    ).resolves.toMatchObject({
      code: 0,
      output: {
        ownership: {
          status: "different-owner",
          current: installedOwner,
          requested: sourceOwner,
        },
      },
    });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toBe(installedScript);

    await expect(
      runCli(["--config", configPath, "hooks", "install", "codex", "--yes"], {
        env,
        providerHookIngressLauncher: sourceOwner.launcher,
        providerHookArtifactOwner: sourceOwner,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_HOOK_OWNERSHIP_CONFLICT",
      message: expect.stringContaining("stn hooks install codex --yes --takeover"),
    });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toBe(installedScript);

    await expect(
      runCli(["--config", configPath, "hooks", "install", "codex", "--takeover"], {
        env,
        providerHookIngressLauncher: sourceOwner.launcher,
        providerHookArtifactOwner: sourceOwner,
      }),
    ).rejects.toThrow("without --yes");

    await expect(
      runCli(["--config", configPath, "hooks", "doctor", "codex"], {
        env,
        providerHookIngressLauncher: sourceOwner.launcher,
        providerHookArtifactOwner: sourceOwner,
      }),
    ).resolves.toMatchObject({
      code: 1,
      output: {
        status: "warn",
        installed: false,
        ownership: { status: "different-owner" },
        message: expect.stringContaining("--yes --takeover"),
      },
    });

    const takeover = await runCli(
      ["--config", configPath, "hooks", "install", "codex", "--yes", "--takeover"],
      {
        env,
        providerHookIngressLauncher: sourceOwner.launcher,
        providerHookArtifactOwner: sourceOwner,
      },
    );
    expect(takeover).toMatchObject({
      code: 0,
      output: { ownership: { status: "same-owner", requested: sourceOwner } },
    });
    const sourceScript = await readFile(hookScriptPath, "utf8");
    expect(sourceScript).toContain(sourceOwner.launcher);
    expect(sourceScript).toContain(providerHookOwnerMarker(sourceOwner));
  });

  it("installs and uninstalls through the generic hooks command", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "codex", "station.config.toml");
    const baseConfigPath = join(root, "codex-home", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    await mkdir(join(root, "codex"), { recursive: true });
    await mkdir(join(root, "codex-home"), { recursive: true });
    await writeFile(codexConfigPath, obsoleteSubagentStopHook(hookScriptPath), "utf8");
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath, true), "utf8");

    const staleDoctor = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "doctor",
        "codex",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );
    expect(staleDoctor).toMatchObject({
      code: 1,
      output: {
        status: "warn",
        message: expect.stringContaining("SubagentStop"),
      },
    });

    const installed = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "codex",
        "--yes",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
        "--hook-bin",
        "/opt/stn-ingress",
      ],
      { env },
    );
    expect(installed).toMatchObject({
      code: 0,
      output: {
        provider: "codex",
        installed: true,
        profileConfigPath: codexConfigPath,
        baseConfigPath,
        generatedGlobalCleanup: {
          changed: true,
          stale: ["PreToolUse", "SubagentStop"],
        },
      },
    });
    const secondInstall = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "codex",
        "--yes",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
        "--hook-bin",
        "/opt/stn-ingress",
      ],
      { env },
    );
    expect(secondInstall).toMatchObject({
      code: 0,
      output: {
        changed: false,
      },
    });
    const script = await readFile(hookScriptPath, "utf8");
    expect(providerHookScriptRoutesByStationEnv(script, "codex")).toBe(true);
    expect(script).toContain(`SOCKET_ARG=(--socket ${join(root, "run", "observer.sock")})`);
    expect(script).toContain(`STATE_DIR_ARG=(--state-dir ${join(root, "state")})`);
    expect(script).toContain(
      `SPOOL_DIR_ARG=(--spool-dir ${join(root, "state", "spool", "hooks")})`,
    );
    expect(script).toContain(`CONFIG_ARG=(--config ${configPath})`);
    await expect(readFile(codexConfigPath, "utf8")).resolves.toContain("echo user subagent stop");
    await expect(readFile(baseConfigPath, "utf8")).resolves.toContain("echo user subagent stop");
    await expect(readFile(baseConfigPath, "utf8")).resolves.not.toContain("Notify station");
    const installedProfile = await readFile(codexConfigPath, "utf8");
    await writeFile(
      codexConfigPath,
      `${installedProfile}\n${obsoleteSubagentStopHook(hookScriptPath)}`,
      "utf8",
    );
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath, true), "utf8");
    const uninstalled = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "uninstall",
        "codex",
        "--yes",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );

    expect(uninstalled).toMatchObject({
      code: 0,
      output: {
        provider: "codex",
        installed: false,
        generatedGlobalChanged: true,
      },
    });
    await expect(readFile(codexConfigPath, "utf8")).resolves.toContain("echo user subagent stop");
    await expect(readFile(codexConfigPath, "utf8")).resolves.not.toContain("Notify station");
    await expect(readFile(baseConfigPath, "utf8")).resolves.toContain("echo user subagent stop");
    await expect(readFile(baseConfigPath, "utf8")).resolves.not.toContain(hookScriptPath);
    await expect(readFile(baseConfigPath, "utf8")).resolves.not.toContain("Notify station");
  });

  it("warns on doctor only when install_hooks requested Codex hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const requestedConfigPath = await writeConfig(join(root, "requested"), true);
    const passiveConfigPath = await writeConfig(join(root, "passive"), false);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "codex", "station.config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");

    const requested = await runCli(
      [
        "--config",
        requestedConfigPath,
        "hooks",
        "doctor",
        "codex",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );
    const passive = await runCli(
      [
        "--config",
        passiveConfigPath,
        "hooks",
        "doctor",
        "codex",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
      ],
      { env },
    );

    expect(requested).toMatchObject({
      code: 1,
      output: {
        provider: "codex",
        status: "warn",
      },
    });
    expect(passive).toMatchObject({
      code: 0,
      output: {
        provider: "codex",
        status: "ok",
      },
    });
  });

  it("warns when doctor finds stale generated global Codex hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, true);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "custom codex", "station.config.toml");
    const defaultCodexConfigPath = join(root, "codex-home", "station.config.toml");
    const baseConfigPath = join(root, "codex-home", "config.toml");
    const hookScriptPath = join(root, "custom state", "hooks", "station-codex-hook.sh");
    const defaultHookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const remediationArgs = [
      "stn",
      "--config",
      configPath,
      "hooks",
      "install",
      "codex",
      "--yes",
      "--codex-config",
      codexConfigPath,
      "--hook-script",
      hookScriptPath,
      "--hook-bin",
      "/opt/custom-stn-ingress",
    ];
    await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "install",
        "codex",
        "--yes",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
        "--hook-bin",
        "/opt/custom-stn-ingress",
      ],
      { env },
    );
    await mkdir(join(root, "codex-home"), { recursive: true });
    const installedProfile = await readFile(codexConfigPath, "utf8");
    await writeFile(
      codexConfigPath,
      `${installedProfile}\n${obsoleteSubagentStopHook(hookScriptPath)}`,
      "utf8",
    );
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath, true), "utf8");

    const doctor = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "doctor",
        "codex",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
        "--hook-bin",
        "/opt/custom-stn-ingress",
      ],
      { env },
    );

    expect(doctor).toMatchObject({
      code: 1,
      output: {
        provider: "codex",
        status: "warn",
        installed: true,
        generatedGlobalCleanup: {
          changed: true,
          stale: ["PreToolUse", "SubagentStop"],
        },
        message: expect.stringContaining(`Run \`${commandLine(remediationArgs)}\``),
      },
    });

    const remediation = await runCli(remediationArgs.slice(1), { env });
    expect(remediation).toMatchObject({
      code: 0,
      output: {
        profileConfigPath: codexConfigPath,
        hookScriptPath,
      },
    });
    const repairedConfig = await readFile(codexConfigPath, "utf8");
    expect(repairedConfig).toContain("echo user subagent stop");
    expect(repairedConfig.match(/\[\[hooks\.SubagentStop\.hooks\]\]/g)).toHaveLength(1);
    await expect(readFile(defaultCodexConfigPath, "utf8")).rejects.toThrow();
    await expect(readFile(defaultHookScriptPath, "utf8")).rejects.toThrow();
    const repairedDoctor = await runCli(
      [
        "--config",
        configPath,
        "hooks",
        "doctor",
        "codex",
        "--codex-config",
        codexConfigPath,
        "--hook-script",
        hookScriptPath,
        "--hook-bin",
        "/opt/custom-stn-ingress",
      ],
      { env },
    );
    expect(repairedDoctor).toMatchObject({
      code: 0,
      output: {
        status: "ok",
      },
    });
  });

  it("removes obsolete custom hooks instead of enabling hooks disabled by config", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cli-codex-hooks-"));
    const configPath = await writeConfig(root, false);
    const env = codexEnv(root);
    const codexConfigPath = join(root, "custom codex", "station.config.toml");
    const defaultCodexConfigPath = join(root, "codex-home", "station.config.toml");
    const baseConfigPath = join(root, "codex-home", "config.toml");
    const hookScriptPath = join(root, "custom state", "hooks", "station-codex-hook.sh");
    const defaultHookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const hookPathArgs = [
      "--codex-config",
      codexConfigPath,
      "--hook-script",
      hookScriptPath,
      "--hook-bin",
      "/opt/custom-stn-ingress",
    ];
    await runCli(["--config", configPath, "hooks", "install", "codex", "--yes", ...hookPathArgs], {
      env,
    });
    const installedProfile = await readFile(codexConfigPath, "utf8");
    await writeFile(
      codexConfigPath,
      `${installedProfile}\n${obsoleteSubagentStopHook(hookScriptPath)}`,
      "utf8",
    );
    await mkdir(join(root, "codex-home"), { recursive: true });
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath, true), "utf8");

    const remediationArgs = [
      "stn",
      "--config",
      configPath,
      "hooks",
      "uninstall",
      "codex",
      "--yes",
      "--codex-config",
      codexConfigPath,
      "--hook-script",
      hookScriptPath,
      "--hook-bin",
      "/opt/custom-stn-ingress",
    ];
    const doctor = await runCli(
      ["--config", configPath, "hooks", "doctor", "codex", ...hookPathArgs],
      { env },
    );
    expect(doctor).toMatchObject({
      code: 1,
      output: {
        status: "warn",
        installed: false,
        message: expect.stringContaining(`Run \`${commandLine(remediationArgs)}\``),
      },
    });

    const remediation = await runCli(remediationArgs.slice(1), { env });
    expect(remediation).toMatchObject({
      code: 0,
      output: {
        installed: false,
        profileConfigPath: codexConfigPath,
        hookScriptPath,
      },
    });
    const repairedProfile = await readFile(codexConfigPath, "utf8");
    const repairedBase = await readFile(baseConfigPath, "utf8");
    expect(repairedProfile).toContain("echo user subagent stop");
    expect(repairedProfile.match(/\[\[hooks\.SubagentStop\.hooks\]\]/g)).toHaveLength(1);
    expect(repairedBase).toContain("echo user subagent stop");
    expect(repairedBase.match(/\[\[hooks\.SubagentStop\.hooks\]\]/g)).toHaveLength(1);
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
    await expect(readFile(defaultCodexConfigPath, "utf8")).rejects.toThrow();
    await expect(readFile(defaultHookScriptPath, "utf8")).rejects.toThrow();
    await expect(
      runCli(["--config", configPath, "hooks", "doctor", "codex", ...hookPathArgs], { env }),
    ).resolves.toMatchObject({
      code: 0,
      output: { status: "ok", installed: false },
    });
  });
});

function artifactOwner(launcher: string, runtimeKind: "compiled" | "source", digit: string) {
  return {
    schemaVersion: 1 as const,
    launcher,
    runtimeKind,
    version: runtimeKind === "compiled" ? "0.7.1" : "0.0.0-pre-alpha.4",
    buildIdentity: digit.repeat(64),
  };
}

function codexEnv(root: string): Record<string, string> {
  return { CODEX_HOME: join(root, "codex-home") };
}

async function writeConfig(root: string, installHooks: boolean): Promise<string> {
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
      `install_hooks = ${installHooks ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
  return configPath;
}

function generatedGlobalCodexConfig(hookScriptPath: string, includeObsolete = false): string {
  const lines = [
    "[[hooks.PreToolUse]]",
    'matcher = ".*"',
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(hookScriptPath)}`,
    "timeout = 30",
    'statusMessage = "Notify station"',
    "",
  ];
  if (includeObsolete) {
    lines.push(obsoleteSubagentStopHook("/legacy/state/hooks/station-codex-hook.sh"));
  }
  return lines.join("\n");
}

function obsoleteSubagentStopHook(generatedCommand: string): string {
  return [
    "[[hooks.SubagentStop]]",
    'matcher = ".*"',
    'owner = "user"',
    "[[hooks.SubagentStop.hooks]]",
    'type = "command"',
    'command = "echo user subagent stop"',
    "timeout = 10",
    "",
    "[[hooks.SubagentStop.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(generatedCommand)}`,
    "timeout = 30",
    'statusMessage = "Notify station"',
    "",
  ].join("\n");
}
