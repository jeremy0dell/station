import { spawn, spawnSync } from "node:child_process";
import { constants, mkdirSync, rmSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileProviderHooks } from "@station/observer/internal";
import { providerHookScriptRoutesByStationEnv } from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  doctorCodexHooks,
  expectedCodexHookScript,
  inspectCodexHookHealth,
  installCodexHooks,
  planCodexHooks,
  reconcileCodexHooks,
  repairCodexHooks,
  uninstallCodexHooks,
  verifyCodexHookInstall,
} from "../../src/hooks";
import {
  enableCodexHooksFeature,
  generatedStationHookEvents,
  parseTomlDocument,
  stringifyTomlDocument,
} from "../../src/hooks/hookConfigEditor";
import { CodexHookSetupError } from "../../src/hooks/hookErrors";
import { withCodexHookMutationLock } from "../../src/hooks/hookMutationLock";

describe("Codex hook setup", () => {
  it.each([
    ["a profile without the table", ""],
    ["a commented table", "[features] # retained comment\nhooks = false\n"],
    ["an indented table", "  [features]\nhooks = false\n"],
    ["a quoted table", '["features"]\nhooks = false\n'],
    ["an inline table", "features = { hooks = false, unified_exec = true }\n"],
  ])("enables hooks in an isolated profile from %s", (_name, source) => {
    const enabled = enableCodexHooksFeature(parseTomlDocument(source));
    const reparsed = parseTomlDocument(stringifyTomlDocument(enabled));

    expect(reparsed).toMatchObject({ features: { hooks: true } });
    if (source.includes("unified_exec")) {
      expect(reparsed).toMatchObject({ features: { unified_exec: true } });
    }
  });

  it("plans hook config and generated script without writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");

    const plan = await planCodexHooks({
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      hookBin: "/usr/local/bin/stn-ingress",
      env: { CODEX_HOME: codexHome },
    });

    expect(plan.changed).toBe(true);
    expect(plan.configPath).toBe(configPath);
    expect(plan.profileName).toBe("station");
    expect(plan.profileConfigPath).toBe(configPath);
    expect(plan.baseConfigPath).toBe(baseConfigPath);
    expect(plan.missing).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SubagentStart",
      "Stop",
    ]);
    expect(plan.commands.PreToolUse).toBe(`${hookScriptPath} --fast PreToolUse`);
    expect(plan.commands.PermissionRequest).toBe(`${hookScriptPath} PermissionRequest`);
    expect(plan.after).toContain("[[hooks.PreToolUse]]");
    expect(plan.after).not.toContain("[[hooks.SubagentStop]]");
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
    await expect(readFile(baseConfigPath, "utf8")).rejects.toThrow();
    await expect(readFile(hookScriptPath, "utf8")).rejects.toThrow();
  });

  it("warns read-only about obsolete generated profile and base hooks with remediation", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = { CODEX_HOME: codexHome };
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, codexConfigWithObsoleteHook(hookScriptPath), "utf8");
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath, true), "utf8");
    const profileBefore = await readFile(configPath, "utf8");
    const baseBefore = await readFile(baseConfigPath, "utf8");

    const doctor = await doctorCodexHooks({ hookScriptPath, enabled: true, env });

    expect(doctor).toMatchObject({
      status: "warn",
      generatedGlobalCleanup: {
        changed: true,
        stale: ["PreToolUse", "SubagentStop"],
      },
    });
    expect(doctor.message).toContain("SubagentStop");
    expect(doctor.message).toContain("stn hooks install codex --yes");
    await expect(readFile(configPath, "utf8")).resolves.toBe(profileBefore);
    await expect(readFile(baseConfigPath, "utf8")).resolves.toBe(baseBefore);
  });

  it("installs into the station profile, cleans generated global entries, and preserves unrelated hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = { CODEX_HOME: codexHome };
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, codexConfigWithObsoleteHook(hookScriptPath), "utf8");
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath, true), "utf8");

    const installOptions = {
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      env,
    };
    const installed = await installCodexHooks(installOptions);
    const verified = await verifyCodexHookInstall(installed, installOptions, true);
    const backupEntries = (await readdir(codexHome)).filter((entry) => entry.includes(".bak."));
    const second = await installCodexHooks(installOptions);
    const secondVerified = await verifyCodexHookInstall(second, installOptions, true);
    const config = await readFile(configPath, "utf8");
    const baseConfig = await readFile(baseConfigPath, "utf8");
    const script = await readFile(hookScriptPath, "utf8");
    const scriptMode = (await stat(hookScriptPath)).mode & 0o777;

    expect(installed.backupPath).toBeDefined();
    expect(installed.profileBackupPath).toBeDefined();
    expect(installed.baseBackupPath).toBeDefined();
    expect(installed.backupPaths).toHaveLength(2);
    expect(installed.generatedGlobalCleanup.stale).toEqual(["PreToolUse", "SubagentStop"]);
    expect(verified).toMatchObject({
      status: "ok",
      verified: true,
      doctor: {
        status: "ok",
        installed: true,
        profileConfigPath: configPath,
        baseConfigPath,
        hookScriptPath,
      },
    });
    expect(second.changed).toBe(false);
    expect(second.backupPaths).toBeUndefined();
    expect(secondVerified).toMatchObject({ status: "ok", verified: true, changed: false });
    expect((await readdir(codexHome)).filter((entry) => entry.includes(".bak."))).toEqual(
      backupEntries,
    );
    expect(config).toContain("echo existing");
    expect(config).toContain("echo user subagent stop");
    expect(config).toContain(hookScriptPath);
    expect(baseConfig).toContain("echo existing");
    expect(baseConfig).toContain("echo user subagent stop");
    expect(baseConfig).not.toContain(hookScriptPath);
    expect(baseConfig).not.toContain("Notify station");
    expect(generatedStationHookEvents(parseTomlDocument(config), installed.commands)).not.toContain(
      "SubagentStop",
    );
    expect(
      generatedStationHookEvents(parseTomlDocument(baseConfig), installed.commands),
    ).not.toContain("SubagentStop");
    expect(providerHookScriptRoutesByStationEnv(script, "codex")).toBe(true);
    expect(script).not.toContain("station-hook");
    expect(script).toContain("SOCKET_ARG=(--socket /tmp/station/run/observer.sock)");
    expect(script).toContain("CONFIG_ARG=(--config /tmp/station/config.toml)");
    expect(script).toContain("STATE_DIR_ARG=(--state-dir /tmp/station/state)");
    expect(script).toContain("SPOOL_DIR_ARG=(--spool-dir /tmp/station/state/spool/hooks)");
    // External sessions carry no station env; the script must deliver anyway
    // and leave scope decisions to the provider adapter.
    expect(script).not.toContain("STATION_SESSION_ID");
    expect(script).not.toContain("payload_file=");
    expect(script).toContain('codex "$@" > /dev/null');
    expect(scriptMode).toBe(0o700);
  });

  it("retains completed writes and backups when post-install doctor finds script drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = { CODEX_HOME: codexHome };
    const installOptions = {
      hookScriptPath,
      hookBin: "/opt/custom-stn-ingress",
      stationConfigPath: "/tmp/station/config.toml",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      env,
    };
    await mkdir(codexHome, { recursive: true });
    const profileBefore = codexConfigWithObsoleteHook(hookScriptPath);
    const baseBefore = generatedGlobalCodexConfig(hookScriptPath, true);
    await writeFile(configPath, profileBefore, "utf8");
    await writeFile(baseConfigPath, baseBefore, "utf8");

    const installed = await installCodexHooks(installOptions);
    await writeFile(hookScriptPath, "post-write drift\n", "utf8");
    const verification = await verifyCodexHookInstall(installed, installOptions, true);

    expect(verification).toMatchObject({
      status: "warn",
      verified: false,
      installed: true,
      changed: true,
      profileBackupPath: installed.profileBackupPath,
      baseBackupPath: installed.baseBackupPath,
      doctor: {
        status: "warn",
        installed: false,
        profileConfigPath: configPath,
        baseConfigPath,
        hookScriptPath,
        message: expect.stringContaining("script is missing or stale"),
      },
      message: expect.stringContaining("provider verification requires manual follow-up"),
    });
    if (!("doctor" in verification)) {
      throw new Error("Expected post-write drift to return the complete Codex doctor result.");
    }
    expect(verification.message).toContain(verification.doctor.message);
    expect(verification.message).toContain(
      "stn --config /tmp/station/config.toml hooks install codex",
    );
    expect(verification.message).toContain("hooks doctor codex");
    expect(verification.message).toContain(configPath);
    expect(verification.message).toContain(hookScriptPath);
    expect(verification.message).toContain("--hook-bin /opt/custom-stn-ingress");
    await expect(readFile(hookScriptPath, "utf8")).resolves.toBe("post-write drift\n");
    await expect(readFile(configPath, "utf8")).resolves.toContain(hookScriptPath);
    await expect(readFile(baseConfigPath, "utf8")).resolves.not.toContain("Notify station");
    if (installed.profileBackupPath === undefined || installed.baseBackupPath === undefined) {
      throw new Error("Expected changed Codex configs to retain both backups.");
    }
    await expect(readFile(installed.profileBackupPath, "utf8")).resolves.toBe(profileBefore);
    await expect(readFile(installed.baseBackupPath, "utf8")).resolves.toBe(baseBefore);
  });

  it("normalizes a post-install doctor exception without rolling back completed writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const installOptions = {
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      env: { CODEX_HOME: codexHome },
    };
    const installed = await installCodexHooks(installOptions);
    await writeFile(configPath, "not = [valid", "utf8");

    const verification = await verifyCodexHookInstall(installed, installOptions, true);

    expect(verification).toMatchObject({
      status: "warn",
      verified: false,
      installed: true,
      error: {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_INVALID_TOML",
        provider: "codex",
      },
      message: expect.stringContaining("provider verification requires manual follow-up"),
    });
    expect("doctor" in verification).toBe(false);
    expect(verification.message).toContain(configPath);
    expect(verification.message).toContain(hookScriptPath);
    expect(verification.message).toContain("/tmp/station/config.toml");
    expect(verification.message).toContain("Correct invalid configuration or ownership");
    await expect(readFile(configPath, "utf8")).resolves.toBe("not = [valid");
    await expect(readFile(hookScriptPath, "utf8")).resolves.toContain('codex "$@" > /dev/null');
  });

  it("rethrows cancellation and deadline from no-op verification without normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-noop-boundary-"));
    const options = {
      hookScriptPath: join(root, "state", "hooks", "station-codex-hook.sh"),
      env: codexEnv(root),
    };
    await installCodexHooks(options);
    const noOpInstall = await installCodexHooks(options);
    expect(noOpInstall.changed).toBe(false);

    await expect(
      verifyCodexHookInstall(noOpInstall, { ...options, timeoutMs: 0 }, true),
    ).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_RECONCILIATION_TIMEOUT",
    });

    const controller = new AbortController();
    const cancellation = new Error("cancel no-op verification");
    controller.abort(cancellation);
    await expect(
      verifyCodexHookInstall(noOpInstall, { ...options, signal: controller.signal }, true),
    ).rejects.toBe(cancellation);
  });

  it("preserves a post-write doctor failure when cancellation arrives after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-late-abort-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const options = {
      hookScriptPath: join(root, "state", "hooks", "station-codex-hook.sh"),
      env: { CODEX_HOME: codexHome },
    };
    const installed = await installCodexHooks(options);
    expect(installed.changed).toBe(true);
    await writeFile(configPath, "not = [valid", "utf8");
    const controller = new AbortController();
    controller.abort(new Error("late cancellation must not mask verification failure"));

    const verification = await verifyCodexHookInstall(
      installed,
      { ...options, signal: controller.signal },
      true,
    );

    expect(verification).toMatchObject({
      status: "warn",
      verified: false,
      changed: true,
      error: {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_INVALID_TOML",
      },
    });
  });

  it("generated script delivers to stn-ingress even without ownership env", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const env = codexEnv(root);
    const configPath = join(root, "codex", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const hookBin = join(root, "stn-ingress");
    const argsLog = join(root, "hook.args");
    await writeFile(
      hookBin,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$*" >> ${shellQuote(argsLog)}`,
        "cat > /dev/null",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    await installCodexHooks({
      codexConfigPath: configPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      hookBin,
      env,
    });

    const payload = JSON.stringify({ hook_event_name: "PreToolUse" });
    const result = await runHookScript(hookScriptPath, payload, { TMPDIR: root }, [
      "--fast",
      "PreToolUse",
    ]);

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(readFile(argsLog, "utf8")).resolves.toBe(
      "--config /tmp/station/config.toml codex --fast PreToolUse\n",
    );
  });

  it("generated script invokes stn-ingress with Codex stdin when ownership env is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const env = codexEnv(root);
    const configPath = join(root, "codex", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const hookBin = join(root, "stn-ingress");
    const argsLog = join(root, "hook.args");
    const stdinLog = join(root, "hook.stdin");
    await writeFile(
      hookBin,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' "$*" >> ${shellQuote(argsLog)}`,
        `cat >> ${shellQuote(stdinLog)}`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    await installCodexHooks({
      codexConfigPath: configPath,
      hookScriptPath,
      stationConfigPath: "/tmp/station/config.toml",
      hookBin,
      env,
    });

    const payload = JSON.stringify({ hook_event_name: "PreToolUse" });
    const result = await runHookScript(
      hookScriptPath,
      payload,
      {
        TMPDIR: root,
        STATION_SESSION_ID: "ses_web_task",
        STATION_WORKTREE_ID: "wt_web_task",
      },
      ["--fast", "PreToolUse"],
    );

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    await expect(readFile(argsLog, "utf8")).resolves.toBe(
      "--config /tmp/station/config.toml codex --fast PreToolUse\n",
    );
    await expect(readFile(stdinLog, "utf8")).resolves.toBe(payload);
  });

  it("uninstalls generated hooks without removing unrelated commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = { CODEX_HOME: codexHome };
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, existingCodexConfig(), "utf8");
    await installCodexHooks({ hookScriptPath, env });
    const installedProfile = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      `${installedProfile}\n${obsoleteSubagentStopHook(hookScriptPath)}`,
      "utf8",
    );
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath, true), "utf8");

    const removed = await uninstallCodexHooks({ hookScriptPath, env });
    const config = await readFile(configPath, "utf8");
    const baseConfig = await readFile(baseConfigPath, "utf8");

    expect(removed.installed).toBe(false);
    expect(removed.scriptRemoved).toBe(true);
    expect(removed.generatedGlobalChanged).toBe(true);
    expect(removed.profileBackupPath).toBeDefined();
    expect(removed.baseBackupPath).toBeDefined();
    expect(removed.backupPaths).toHaveLength(2);
    expect(config).toContain("echo existing");
    expect(config).toContain("echo user subagent stop");
    expect(config).not.toContain(hookScriptPath);
    expect(baseConfig).toContain("echo existing");
    expect(baseConfig).toContain("echo user subagent stop");
    expect(baseConfig).not.toContain(hookScriptPath);
    expect(config).not.toContain("Notify station");
    expect(baseConfig).not.toContain("Notify station");
    await expect(access(hookScriptPath)).rejects.toThrow();
  });

  it("only warns for missing hooks when install_hooks requested them", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const env = codexEnv(root);
    const configPath = join(root, "codex", "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");

    await expect(
      doctorCodexHooks({ codexConfigPath: configPath, hookScriptPath, enabled: false, env }),
    ).resolves.toMatchObject({
      status: "ok",
      installed: false,
    });
    await expect(
      doctorCodexHooks({ codexConfigPath: configPath, hookScriptPath, enabled: true, env }),
    ).resolves.toMatchObject({
      status: "warn",
      installed: false,
    });
  });

  it("maps disabled and missing hooks to strict provider-neutral health", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const options = {
      hookScriptPath: join(root, "state", "hooks", "station-codex-hook.sh"),
      env: codexEnv(root),
    };

    await expect(inspectCodexHookHealth({ ...options, enabled: false })).resolves.toEqual({
      provider: "codex",
      status: "configured-disabled",
      followUp: { action: "enable-hooks" },
    });
    await expect(inspectCodexHookHealth({ ...options, enabled: true })).resolves.toEqual({
      provider: "codex",
      status: "needs-repair",
      reason: "missing",
    });
  });

  it("fails enabled automatic reconciliation closed when no artifact owner is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-ownerless-"));
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = codexEnv(root);

    await expect(
      reconcileCodexHooks({ hookScriptPath, env, enabled: true }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      changed: false,
      verified: false,
      error: {
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_RECONCILIATION_OWNER_REQUIRED",
      },
      followUp: { action: "run-doctor" },
    });
    await expect(access(hookScriptPath)).rejects.toThrow();

    // Explicit/manual installation remains available for ownerless legacy callers.
    await expect(installCodexHooks({ hookScriptPath, env })).resolves.toMatchObject({
      changed: true,
      installed: true,
    });
  });

  it("repairs owned drift, verifies it, and makes the second reconciliation a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const artifactOwner = owner("/station/bin/stn-ingress", "a");
    const options = { hookScriptPath, artifactOwner, env: codexEnv(root), enabled: true };
    await installCodexHooks(options);
    const installedScript = await readFile(hookScriptPath, "utf8");
    await writeFile(hookScriptPath, `${installedScript}# owned drift\n`, "utf8");

    await expect(inspectCodexHookHealth(options)).resolves.toEqual({
      provider: "codex",
      status: "needs-repair",
      reason: "owned-drift",
    });
    await expect(reconcileCodexHooks(options)).resolves.toEqual({
      provider: "codex",
      status: "repaired",
      changed: true,
      verified: true,
    });
    await expect(reconcileCodexHooks(options)).resolves.toEqual({
      provider: "codex",
      status: "healthy",
      changed: false,
      verified: true,
    });
  });

  it("reports unchanged when reconciliation fails during the pre-write backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-backup-failure-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const configBefore = existingCodexConfig();
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, configBefore, "utf8");
    const beginMutation = vi.fn(() => {
      rmSync(configPath);
      mkdirSync(configPath);
    });

    await expect(
      reconcileCodexHooks({
        hookScriptPath,
        artifactOwner: owner("/station/bin/stn-ingress", "a"),
        env: { CODEX_HOME: codexHome },
        enabled: true,
        beginMutation,
      }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "write-failed",
      changed: false,
      verified: false,
      error: { code: "CODEX_HOOK_CONFIG_UNREADABLE" },
      followUp: { action: "retry" },
    });
    expect(beginMutation).toHaveBeenCalledOnce();
    await expect(access(hookScriptPath)).rejects.toThrow();
  });

  it("preserves a selected provider failure when cancellation becomes observable before catch", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-late-cancel-failure-"));
    const controller = new AbortController();
    const providerFailure = new CodexHookSetupError(
      "CODEX_HOOK_WRITE_FAILED",
      "Selected provider write failure.",
    );

    await expect(
      reconcileCodexHooks({
        hookScriptPath: join(root, "state", "hooks", "station-codex-hook.sh"),
        artifactOwner: owner("/station/bin/stn-ingress", "a"),
        env: codexEnv(root),
        enabled: true,
        signal: controller.signal,
        beginMutation: () => {
          controller.abort(new Error("late cancellation"));
          throw providerFailure;
        },
      }),
    ).resolves.toMatchObject({
      status: "write-failed",
      changed: false,
      error: { code: "CODEX_HOOK_WRITE_FAILED" },
      followUp: { action: "retry" },
    });
  });

  it("preserves an aborted signal reason through config-read error wrapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-wrapped-cancel-"));
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), "# provider config\n", "utf8");
    const controller = new AbortController();
    const cancellation = {
      tag: "CancellationError",
      code: "CODEX_HOOK_RECONCILIATION_CANCELLED",
      message: "Canonical caller cancellation.",
    };

    const result = reconcileProviderHooks("codex", () =>
      reconcileCodexHooks({
        hookScriptPath: join(root, "state", "hooks", "station-codex-hook.sh"),
        artifactOwner: owner("/station/bin/stn-ingress", "a"),
        env: { CODEX_HOME: codexHome },
        enabled: true,
        signal: controller.signal,
      }),
    );
    queueMicrotask(() => controller.abort(cancellation));

    await expect(result).resolves.toMatchObject({
      provider: "codex",
      status: "inspection-failed",
      error: cancellation,
    });
  });

  it("reports unchanged when the first artifact write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-first-write-failure-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const configBefore = existingCodexConfig();
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, configBefore, "utf8");
    const beginMutation = vi.fn(() => {
      mkdirSync(hookScriptPath, { recursive: true });
    });

    await expect(
      reconcileCodexHooks({
        hookScriptPath,
        artifactOwner: owner("/station/bin/stn-ingress", "a"),
        env: { CODEX_HOME: codexHome },
        enabled: true,
        beginMutation,
      }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "write-failed",
      changed: false,
      verified: false,
      error: { code: "CODEX_HOOK_WRITE_FAILED" },
      followUp: { action: "retry" },
    });
    expect(beginMutation).toHaveBeenCalledOnce();
    await expect(readFile(configPath, "utf8")).resolves.toBe(configBefore);
    expect((await stat(hookScriptPath)).isDirectory()).toBe(true);
  });

  it("reports a completed script write when a later base-config backup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-partial-write-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const artifactOwner = owner("/station/bin/stn-ingress", "a");
    const env = { CODEX_HOME: codexHome };
    await installCodexHooks({ hookScriptPath, artifactOwner, env });
    const configBefore = await readFile(configPath, "utf8");
    const installedScript = await readFile(hookScriptPath, "utf8");
    await writeFile(hookScriptPath, `${installedScript}# drift\n`, "utf8");
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath), "utf8");
    const beginMutation = vi.fn(() => {
      rmSync(baseConfigPath);
      mkdirSync(baseConfigPath);
    });

    await expect(
      reconcileCodexHooks({
        hookScriptPath,
        artifactOwner,
        env,
        enabled: true,
        beginMutation,
      }),
    ).resolves.toMatchObject({
      provider: "codex",
      status: "write-failed",
      changed: true,
      verified: false,
      error: { code: "CODEX_HOOK_CONFIG_UNREADABLE" },
      followUp: { action: "retry" },
    });
    expect(beginMutation).toHaveBeenCalledOnce();
    await expect(readFile(configPath, "utf8")).resolves.toBe(configBefore);
    await expect(readFile(hookScriptPath, "utf8")).resolves.toBe(installedScript);
  });

  it.each([
    0o600, 0o777,
  ])("reports Codex hook mode %# as drift and reconciles it to exact 0700", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-mode-"));
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const options = {
      hookScriptPath,
      artifactOwner: owner("/station/bin/stn-ingress", "a"),
      env: codexEnv(root),
      enabled: true,
    };
    await installCodexHooks(options);
    await chmod(hookScriptPath, mode);

    await expect(doctorCodexHooks(options)).resolves.toMatchObject({
      status: "warn",
      installed: false,
    });
    await expect(reconcileCodexHooks(options)).resolves.toEqual({
      provider: "codex",
      status: "repaired",
      changed: true,
      verified: true,
    });
    expect((await stat(hookScriptPath)).mode & 0o777).toBe(0o700);
    await expect(doctorCodexHooks(options)).resolves.toMatchObject({
      status: "ok",
      installed: true,
    });
  });

  it("fails closed on foreign ownership without exposing provider paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-secret-"));
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = codexEnv(root);
    await installCodexHooks({ hookScriptPath, artifactOwner: owner("/old/stn-ingress", "a"), env });

    const options = {
      hookScriptPath,
      artifactOwner: owner("/new/stn-ingress", "b"),
      env,
      enabled: true,
    };
    const health = await inspectCodexHookHealth(options);
    const reconciliation = await reconcileCodexHooks(options);

    expect(health).toEqual({
      provider: "codex",
      status: "ownership-conflict",
      ownership: "different-owner",
      followUp: { action: "run-explicit-takeover" },
    });
    expect(reconciliation).toEqual({
      provider: "codex",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    });
    expect(JSON.stringify({ health, reconciliation })).not.toContain(root);
  });

  it("requires explicit takeover for an existing empty hook script", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-empty-owner-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const artifactOwner = owner("/station/bin/stn-ingress", "a");
    const env = { CODEX_HOME: codexHome };
    await mkdir(join(root, "state", "hooks"), { recursive: true });
    await writeFile(hookScriptPath, "", { mode: 0o700 });
    const options = { hookScriptPath, artifactOwner, env, enabled: true };

    await expect(planCodexHooks(options)).resolves.toMatchObject({
      ownership: { status: "unknown-owner", requested: artifactOwner },
    });
    await expect(reconcileCodexHooks(options)).resolves.toEqual({
      provider: "codex",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toBe("");
    await expect(access(configPath)).rejects.toThrow();

    await expect(repairCodexHooks({ ...options, takeover: true }, true)).resolves.toMatchObject({
      status: "ok",
      verified: true,
      changed: true,
    });
    await expect(readFile(hookScriptPath, "utf8")).resolves.toContain(
      "station-provider-artifact-owner:v1:",
    );
  });

  it("refuses a foreign generated script referenced by a shared Codex home", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-shared-home-"));
    const codexHome = join(root, "codex-home");
    const firstStateDir = join(root, "state-a");
    const secondStateDir = join(root, "state-b");
    const firstScript = join(firstStateDir, "hooks", "station-codex-hook.sh");
    const secondScript = join(secondStateDir, "hooks", "station-codex-hook.sh");
    const profileConfig = join(codexHome, "station.config.toml");
    const env = { CODEX_HOME: codexHome };
    const firstOwner = owner("/station/a/stn-ingress", "a");
    const secondOwner = owner("/station/b/stn-ingress", "b");

    await installCodexHooks({ stateDir: firstStateDir, artifactOwner: firstOwner, env });
    const profileBefore = await readFile(profileConfig, "utf8");
    const firstScriptBefore = await readFile(firstScript, "utf8");

    const secondOptions = {
      stateDir: secondStateDir,
      artifactOwner: secondOwner,
      env,
      enabled: true,
    };
    await expect(planCodexHooks(secondOptions)).resolves.toMatchObject({
      ownership: { status: "different-owner", current: firstOwner, requested: secondOwner },
    });
    const doctor = await doctorCodexHooks(secondOptions);
    expect(doctor).toMatchObject({
      status: "warn",
      installed: false,
      ownership: { status: "different-owner" },
    });
    expect(doctor.message).toContain(
      `stn hooks install codex --yes --takeover --codex-config ${profileConfig} --hook-script ${secondScript}`,
    );
    await expect(reconcileCodexHooks(secondOptions)).resolves.toEqual({
      provider: "codex",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    });
    await expect(readFile(profileConfig, "utf8")).resolves.toBe(profileBefore);
    await expect(readFile(firstScript, "utf8")).resolves.toBe(firstScriptBefore);
    await expect(access(secondScript)).rejects.toThrow();

    await expect(
      repairCodexHooks({ ...secondOptions, takeover: true }, true),
    ).resolves.toMatchObject({
      status: "ok",
      verified: true,
      ownership: { status: "same-owner", requested: secondOwner },
    });
    await expect(readFile(profileConfig, "utf8")).resolves.toContain(secondScript);
    await expect(readFile(profileConfig, "utf8")).resolves.not.toContain(firstScript);
  });

  it("migrates a shared Codex home between state directories for the same launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-shared-launcher-"));
    const codexHome = join(root, "codex-home");
    const firstStateDir = join(root, "state-a");
    const secondStateDir = join(root, "state-b");
    const firstScript = join(firstStateDir, "hooks", "station-codex-hook.sh");
    const secondScript = join(secondStateDir, "hooks", "station-codex-hook.sh");
    const profileConfig = join(codexHome, "station.config.toml");
    const env = { CODEX_HOME: codexHome };
    const firstOwner = owner("/station/bin/stn-ingress", "a");
    const upgradedOwner = owner("/station/bin/stn-ingress", "b");

    await installCodexHooks({ stateDir: firstStateDir, artifactOwner: firstOwner, env });
    const firstScriptBefore = await readFile(firstScript, "utf8");
    await expect(
      reconcileCodexHooks({
        stateDir: secondStateDir,
        artifactOwner: upgradedOwner,
        env,
        enabled: true,
      }),
    ).resolves.toEqual({
      provider: "codex",
      status: "repaired",
      changed: true,
      verified: true,
    });

    await expect(readFile(profileConfig, "utf8")).resolves.toContain(secondScript);
    await expect(readFile(profileConfig, "utf8")).resolves.not.toContain(firstScript);
    await expect(readFile(secondScript, "utf8")).resolves.not.toBe(firstScriptBefore);
  });

  it.each([
    { name: "missing absolute", kind: "missing", location: "profile" },
    { name: "unmarked absolute", kind: "unmarked", location: "base" },
    { name: "relative", kind: "relative", location: "profile" },
  ] as const)("fails closed with byte-stable artifacts for a $name generated script reference", async ({
    kind,
    location,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-unknown-owner-"));
    const codexHome = join(root, "codex-home");
    const profileConfig = join(codexHome, "station.config.toml");
    const baseConfig = join(codexHome, "config.toml");
    const requestedScript = join(root, "requested-state", "hooks", "station-codex-hook.sh");
    const referencedScript =
      kind === "relative"
        ? "station-codex-hook.sh"
        : join(root, "incumbent-state", "hooks", "station-codex-hook.sh");
    await mkdir(codexHome, { recursive: true });
    if (kind === "unmarked") {
      await mkdir(join(root, "incumbent-state", "hooks"), { recursive: true });
      await writeFile(referencedScript, "#!/usr/bin/env bash\necho unmarked\n", "utf8");
    }
    const profileBefore =
      location === "profile" ? generatedGlobalCodexConfig(referencedScript) : existingCodexConfig();
    const baseBefore =
      location === "base" ? generatedGlobalCodexConfig(referencedScript) : existingCodexConfig();
    await writeFile(profileConfig, profileBefore, "utf8");
    await writeFile(baseConfig, baseBefore, "utf8");
    const referencedBefore =
      kind === "unmarked" ? await readFile(referencedScript, "utf8") : undefined;

    const options = {
      hookScriptPath: requestedScript,
      artifactOwner: owner("/station/bin/stn-ingress", "a"),
      env: { CODEX_HOME: codexHome },
      enabled: true,
    };
    await expect(planCodexHooks(options)).resolves.toMatchObject({
      ownership: { status: "unknown-owner" },
    });
    await expect(reconcileCodexHooks(options)).resolves.toEqual({
      provider: "codex",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    });

    await expect(readFile(profileConfig, "utf8")).resolves.toBe(profileBefore);
    await expect(readFile(baseConfig, "utf8")).resolves.toBe(baseBefore);
    await expect(access(requestedScript)).rejects.toThrow();
    expect((await readdir(codexHome)).filter((entry) => entry.includes(".bak."))).toEqual([]);
    if (referencedBefore !== undefined) {
      await expect(readFile(referencedScript, "utf8")).resolves.toBe(referencedBefore);
    }
  });

  it("serializes concurrent reconciliation through one writer and one backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, existingCodexConfig(), "utf8");
    const options = {
      hookScriptPath: join(root, "state", "hooks", "station-codex-hook.sh"),
      artifactOwner: owner("/station/bin/stn-ingress", "a"),
      env: { CODEX_HOME: codexHome },
      enabled: true,
    };

    const results = await Promise.all([
      reconcileCodexHooks(options),
      reconcileCodexHooks(options),
      reconcileCodexHooks(options),
    ]);

    expect(results.filter((result) => result.status === "repaired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "healthy")).toHaveLength(2);
    expect((await readdir(codexHome)).filter((entry) => entry.includes(".bak."))).toHaveLength(1);
    expect((await readdir(codexHome)).filter((entry) => entry.endsWith(".lock"))).toEqual([]);
  });

  it("ignores runtime-injected takeover when ownership changes before the locked replan", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-takeover-race-"));
    const codexHome = join(root, "codex-home");
    const profileConfig = join(codexHome, "station.config.toml");
    const baseConfig = join(codexHome, "config.toml");
    const hookScript = join(root, "state", "hooks", "station-codex-hook.sh");
    const requestedOwner = owner("/station/bin/stn-ingress", "a");
    const foreignOwner = owner("/other/bin/stn-ingress", "b");
    const env = { CODEX_HOME: codexHome };
    await installCodexHooks({ hookScriptPath: hookScript, artifactOwner: requestedOwner, env });

    let releaseHolder!: () => void;
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withCodexHookMutationLock([profileConfig, baseConfig, hookScript], async () => {
      markHeld();
      await release;
    });
    await held;

    let markLockAttempted!: () => void;
    const lockAttempted = new Promise<void>((resolve) => {
      markLockAttempted = resolve;
    });
    const realNow = performance.now.bind(performance);
    let marked = false;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      if (!marked) {
        marked = true;
        markLockAttempted();
      }
      return realNow();
    });
    const beginMutation = vi.fn();
    const runtimeOptions = {
      hookScriptPath: hookScript,
      artifactOwner: requestedOwner,
      env,
      enabled: true,
      takeover: true,
      beginMutation,
    } as unknown as Parameters<typeof reconcileCodexHooks>[0];
    const reconciliation = reconcileCodexHooks(runtimeOptions);
    const foreignScript = expectedCodexHookScript({
      hookScriptPath: hookScript,
      artifactOwner: foreignOwner,
    });
    try {
      await lockAttempted;
      await writeFile(hookScript, foreignScript, { mode: 0o700 });
    } finally {
      nowSpy.mockRestore();
      releaseHolder();
      await holder;
    }

    const result = await reconciliation;
    expect(result).toEqual({
      provider: "codex",
      status: "ownership-conflict",
      changed: false,
      verified: false,
      followUp: { action: "run-explicit-takeover" },
    });
    expect(beginMutation).not.toHaveBeenCalled();
    await expect(readFile(hookScript, "utf8")).resolves.toBe(foreignScript);
  });

  it("spends outer inspection time from the lock's remaining deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-deadline-"));
    const codexHome = join(root, "codex-home");
    const profileConfig = join(codexHome, "station.config.toml");
    const baseConfig = join(codexHome, "config.toml");
    const hookScript = join(root, "state", "hooks", "station-codex-hook.sh");
    const artifactPaths = [profileConfig, baseConfig, hookScript];
    let releaseHolder!: () => void;
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withCodexHookMutationLock(artifactPaths, async () => {
      markHeld();
      await release;
    });
    await held;

    const realNow = performance.now.bind(performance);
    const realStart = realNow();
    let calls = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      calls += 1;
      if (calls <= 2) return 0;
      if (calls <= 6) return 70;
      return 70 + (realNow() - realStart);
    });
    const wallStarted = Date.now();
    try {
      await expect(
        reconcileCodexHooks({
          hookScriptPath: hookScript,
          artifactOwner: owner("/station/bin/stn-ingress", "a"),
          env: { CODEX_HOME: codexHome },
          enabled: true,
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({
        tag: "CodexHookSetupError",
        code: "CODEX_HOOK_RECONCILIATION_TIMEOUT",
      });
      expect(Date.now() - wallStarted).toBeLessThan(80);
    } finally {
      nowSpy.mockRestore();
      releaseHolder();
      await holder;
    }
  });

  it("does not begin mutation after the pre-commit deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-expired-"));
    const codexHome = join(root, "codex-home");
    const hookScript = join(root, "state", "hooks", "station-codex-hook.sh");
    const beginMutation = vi.fn();

    await expect(
      reconcileCodexHooks({
        hookScriptPath: hookScript,
        artifactOwner: owner("/station/bin/stn-ingress", "a"),
        env: { CODEX_HOME: codexHome },
        enabled: true,
        timeoutMs: 0,
        beginMutation,
      }),
    ).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_RECONCILIATION_TIMEOUT",
    });
    expect(beginMutation).not.toHaveBeenCalled();
    await expect(access(join(codexHome, "station.config.toml"))).rejects.toThrow();
    await expect(access(hookScript)).rejects.toThrow();
  });

  it("rethrows the caller's abort reason before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-aborted-"));
    const controller = new AbortController();
    const reason = new Error("test hook cancellation");
    const beginMutation = vi.fn();
    controller.abort(reason);

    await expect(
      reconcileCodexHooks({
        stateDir: join(root, "state"),
        artifactOwner: owner("/station/bin/stn-ingress", "a"),
        env: codexEnv(root),
        enabled: true,
        signal: controller.signal,
        beginMutation,
      }),
    ).rejects.toBe(reason);
    expect(beginMutation).not.toHaveBeenCalled();
  });

  it("warns when generated global Codex hook entries remain", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const baseConfigPath = join(codexHome, "config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    const env = { CODEX_HOME: codexHome };

    await installCodexHooks({ hookScriptPath, env });
    await writeFile(baseConfigPath, generatedGlobalCodexConfig(hookScriptPath), "utf8");

    await expect(doctorCodexHooks({ hookScriptPath, enabled: true, env })).resolves.toMatchObject({
      status: "warn",
      installed: true,
      profileConfigPath: configPath,
      baseConfigPath,
      generatedGlobalCleanup: {
        changed: true,
        stale: ["PreToolUse"],
      },
    });
  });

  it("maps invalid Codex TOML to a typed setup error", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-"));
    const env = codexEnv(root);
    const configPath = join(root, "codex", "config.toml");
    await mkdir(join(root, "codex"), { recursive: true });
    await writeFile(configPath, "not = [valid");

    await expect(planCodexHooks({ codexConfigPath: configPath, env })).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_INVALID_TOML",
      provider: "codex",
    });
  });

  it("rejects nonregular Codex config artifacts without waiting on a FIFO writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-codex-hooks-fifo-"));
    const codexHome = join(root, "codex-home");
    const configPath = join(codexHome, "station.config.toml");
    const hookScriptPath = join(root, "state", "hooks", "station-codex-hook.sh");
    await mkdir(codexHome, { recursive: true });
    createFifo(configPath);

    await expect(
      withFifoRescue(configPath, () =>
        planCodexHooks({
          hookScriptPath,
          artifactOwner: owner("/station/bin/stn-ingress", "a"),
          env: { CODEX_HOME: codexHome },
        }),
      ),
    ).rejects.toMatchObject({
      tag: "CodexHookSetupError",
      code: "CODEX_HOOK_CONFIG_UNREADABLE",
    });
  });
});

async function runHookScript(
  scriptPath: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = {};
  if (process.env.PATH !== undefined) {
    childEnv.PATH = process.env.PATH;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  const child = spawn(scriptPath, args, {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") {
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });
    },
  );
  try {
    child.stdin.end(stdin);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
      throw error;
    }
  }
  return completed;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function codexEnv(root: string): Record<string, string> {
  return { CODEX_HOME: join(root, "codex-home") };
}

function owner(launcher: string, identityCharacter: string) {
  return {
    schemaVersion: 1 as const,
    launcher,
    runtimeKind: "compiled" as const,
    version: "0.0.0-test",
    buildIdentity: identityCharacter.repeat(64),
  };
}

function createFifo(path: string): void {
  const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`mkfifo failed: ${result.stderr}`);
  }
}

async function withFifoRescue<T>(fifoPath: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const rescue = setTimeout(() => {
    void open(fifoPath, constants.O_WRONLY)
      .then((handle) => handle.close())
      .catch(() => undefined);
  }, 500);
  try {
    return await operation();
  } finally {
    clearTimeout(rescue);
    expect(Date.now() - startedAt).toBeLessThan(250);
  }
}

function existingCodexConfig(): string {
  return [
    "[features]",
    "hooks = true",
    "",
    "[[hooks.PostToolUse]]",
    'matcher = ".*"',
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    'command = "echo existing"',
    "timeout = 10",
    "",
  ].join("\n");
}

function codexConfigWithObsoleteHook(hookScriptPath: string): string {
  return `${existingCodexConfig()}\n${obsoleteSubagentStopHook(hookScriptPath)}`;
}

function generatedGlobalCodexConfig(hookScriptPath: string, includeObsolete = false): string {
  const lines = [
    "[features]",
    "hooks = true",
    "",
    "[[hooks.PostToolUse]]",
    'matcher = ".*"',
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    'command = "echo existing"',
    "timeout = 10",
    "",
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
