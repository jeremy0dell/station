import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as stationCli from "@station/cli";
import { CliSetupPlanSchema } from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { buildManagedFastPopupRunShellCommand } from "@station/tmux";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupCommandDeps } from "../../src/commands/setup/types.js";
import {
  configBackedHarnessHooksProbe,
  successfulProviderTrackingPort,
} from "../fixtures/setupTrackingSupport.js";

async function runCli(...args: Parameters<typeof stationCli.runCli>) {
  const options = args[1] ?? {};
  const deps = options.setupDeps;
  if (deps === undefined || deps.probeHarnessHooksStatus !== undefined) {
    return stationCli.runCli(...args);
  }
  return stationCli.runCli(args[0], {
    ...options,
    setupDeps: {
      ...deps,
      probeHarnessHooksStatus: configBackedHarnessHooksProbe(
        async (configPath) => (await deps.fs?.readFile(configPath)) ?? "",
      ),
      ...(deps.providerTrackingPort === undefined
        ? { providerTrackingPort: successfulProviderTrackingPort }
        : {}),
    },
  });
}

describe("CLI setup command", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("rejects non-TTY guided setup before inspection or mutation", async () => {
    const chunks: string[] = [];
    let inspections = 0;

    const result = await runCli(["setup"], {
      setupDeps: {
        now: () => {
          inspections += 1;
          return new Date("2026-06-08T12:00:00.000Z");
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result.code).toBe(1);
    expect(inspections).toBe(0);
    expect(chunks.join("")).toContain("Guided setup requires an interactive terminal.");
    expect(chunks.join("")).toContain("stn setup plan --json");
  });

  it("returns deterministic JSON for setup check without loading observer config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];

    const result = await runCli(
      ["--config", join(root, "missing.toml"), "setup", "check", "--json"],
      {
        setupDeps: {
          cwd: repo,
          homeDir: join(root, "home"),
          env: { PATH: "/fake/bin" },
          runner: fakeRunner(calls, {
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
            "codex --version": "codex 0.1.0\n",
          }),
          access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
          fs: readOnlyFs({}),
          now: () => new Date("2026-06-08T12:00:00.000Z"),
        },
      },
    );

    expect(result.code).toBe(1);
    expect(CliSetupPlanSchema.parse(result.output)).toMatchObject({
      generatedAt: "2026-06-08T12:00:00.000Z",
      mode: "check",
      summary: {
        workflowReady: false,
        requiredOk: false,
        selectedHarness: "codex",
        configPath: join(root, "missing.toml"),
      },
    });
    expect(calls.map((call) => call.command)).not.toContain("gh");
  });

  it("reports every configured harness and hook on a later setup check", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const source = setupConfigToml(repo, { includeHarness: true }).replace(
      "[[projects]]",
      [
        "install_hooks = true",
        "",
        "[harness.opencode]",
        "enabled = true",
        'command = "opencode"',
        "install_hooks = true",
        "",
        "[[projects]]",
      ].join("\n"),
    );

    const result = await runCli(["--config", configPath, "setup", "check", "--json"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
          "opencode --version": "opencode 1.0.0\n",
        }),
        access: readySetupAccess(),
        fs: readOnlyFs({ [configPath]: source }),
      },
    });

    const plan = CliSetupPlanSchema.parse(result.output);
    expect(plan.checks.find((check) => check.id === "harness")?.details).toMatchObject({
      default: "codex",
      enabled: "codex",
    });
    expect(plan.checks.find((check) => check.id === "harness-tracking:codex")).toMatchObject({
      tier: "required",
      status: "ok",
      details: { state: "prepared" },
    });
    expect(plan.checks.find((check) => check.id === "harness-tracking:opencode")).toMatchObject({
      tier: "recommended",
      status: "ok",
      details: { state: "prepared" },
    });
  });

  it("reports conflicting hook runtime provenance in setup check JSON", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const source = setupConfigToml(repo, { includeHarness: true }).replace(
      "[[projects]]",
      ["install_hooks = true", "", "[[projects]]"].join("\n"),
    );
    const requested = {
      schemaVersion: 1 as const,
      launcher: join(root, "source", "bin", "stn-ingress"),
      runtimeKind: "source" as const,
      version: "0.0.0-pre-alpha.11",
      buildIdentity: "a".repeat(64),
    };
    const current = {
      schemaVersion: 1 as const,
      launcher: join(root, "installed", "stn-ingress"),
      runtimeKind: "compiled" as const,
      version: "0.7.1",
      buildIdentity: "b".repeat(64),
    };

    const result = await runCli(["--config", configPath, "setup", "check", "--json"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: readySetupAccess(),
        fs: readOnlyFs({ [configPath]: source }),
        probeHarnessHooksStatus: async () => ({
          provider: "codex",
          requested: true,
          installed: false,
          missing: ["station-codex-hook.sh"],
          message: "Another Station runtime owns the hook.",
          ownership: {
            status: "different-owner",
            requested,
            currentLauncher: current.launcher,
            current,
          },
        }),
      },
    });

    const plan = CliSetupPlanSchema.parse(result.output);
    expect(plan.checks.find((check) => check.id === "harness-tracking:codex")?.details).toEqual(
      expect.objectContaining({
        ownership: "different-owner",
        requestedLauncher: requested.launcher,
        requestedBuildIdentity: requested.buildIdentity,
        currentLauncher: current.launcher,
        currentBuildIdentity: current.buildIdentity,
      }),
    );
  });

  it("repairs persisted tracking intent for a configured secondary harness", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const source = setupConfigToml(repo, { includeHarness: true }).replace(
      "[[projects]]",
      [
        "install_hooks = true",
        "",
        "[harness.opencode]",
        "enabled = true",
        'command = "opencode"',
        "install_hooks = true",
        "",
        "[[projects]]",
      ].join("\n"),
    );
    const calls: ExternalCommandInput[] = [];
    const installed = new Set(["codex"]);
    const baseRunner = fakeRunner(calls, {
      "git rev-parse --show-toplevel": repo,
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      "wt --version": "worktrunk 1.2.3\n",
      "tmux -V": "tmux 3.5a\n",
      "codex --version": "codex 0.1.0\n",
      "opencode --version": "opencode 1.0.0\n",
    });

    const setupDeps: SetupCommandDeps = {
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: async (input: ExternalCommandInput) => {
        const commandResult = await baseRunner(input);
        if (input.args?.[2] === "hooks" && input.args[4] === "opencode") {
          installed.add("opencode");
        }
        return commandResult;
      },
      access: readySetupAccess(),
      fs: fakeFs({ [configPath]: source }),
      async providerTrackingPort(operation) {
        const provider =
          operation.kind === "prepare-worktrunk-tracking"
            ? "worktrunk"
            : (operation.harnessId ?? "opencode");
        installed.add(provider);
        return {
          status: "completed" as const,
          operationId: operation.id,
          commit: { kind: "provider-tracking" as const, provider, changed: true },
        };
      },
      async probeHarnessHooksStatus(harnessId: string) {
        const prepared = installed.has(harnessId);
        return {
          provider: harnessId,
          requested: true,
          installed: prepared,
          missing: prepared ? [] : ["tracking artifact"],
          message: prepared ? "Tracking is prepared." : "Tracking is missing.",
        };
      },
      writeStdout: () => undefined,
    };
    const planned = await runCli(["--config", configPath, "setup", "plan", "--json"], {
      setupDeps,
    });
    const result = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps,
    });

    expect(planned.output).toMatchObject({
      actions: expect.arrayContaining([expect.objectContaining({ id: "opencode-hooks" })]),
    });
    expect(result.code).toBe(0);
    expect(calls.some((call) => (call.args ?? []).includes("hooks"))).toBe(false);
    expect(calls.flatMap((call) => call.args ?? [])).not.toContain("--takeover");
    expect(installed).toContain("opencode");
  });

  it("keeps the persisted default visible when only a secondary configured CLI is available", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const source = setupConfigToml(repo, { includeHarness: true }).replace(
      "[[projects]]",
      ["[harness.opencode]", "enabled = true", 'command = "opencode"', "", "[[projects]]"].join(
        "\n",
      ),
    );

    const result = await runCli(["--config", configPath, "setup", "check", "--json"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: {
          PATH: "/fake/bin",
          STATION_CODEX_BIN: "/missing/codex",
          STATION_OPENCODE_BIN: "opencode",
        },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "opencode --version": "opencode 1.0.0\n",
        }),
        access: readySetupAccess(),
        fs: readOnlyFs({ [configPath]: source }),
      },
    });

    const plan = CliSetupPlanSchema.parse(result.output);
    expect(result.code).toBe(1);
    expect(plan.summary.selectedHarness).toBe("codex");
    expect(plan.checks.find((check) => check.id === "harness")).toMatchObject({
      status: "missing",
      details: {
        default: "codex",
        defaultStatus: "unavailable",
        enabled: "codex",
        available: "opencode",
      },
    });
  });

  it("does not count an unconfigured installed CLI as workflow ready", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const source = setupConfigToml(repo, { includeHarness: true });

    const result = await runCli(["--config", configPath, "setup", "check", "--json"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "opencode --version": "opencode 1.0.0\n",
        }),
        access: readySetupAccess(),
        fs: readOnlyFs({ [configPath]: source }),
      },
    });

    const plan = CliSetupPlanSchema.parse(result.output);
    expect(result.code).toBe(1);
    expect(plan.summary.requiredOk).toBe(false);
    expect(plan.checks.find((check) => check.id === "harness")).toMatchObject({
      status: "missing",
      details: {
        default: "codex",
        defaultStatus: "unavailable",
        enabled: "codex",
        available: "opencode",
      },
    });
  });

  it("reports compiled launch readiness independently from workflow readiness", async () => {
    const root = await tempRoot(tempRoots);
    const result = await runCli(["setup", "check", "--json"], {
      setupDeps: {
        compiled: true,
        cwd: root,
        homeDir: join(root, "home"),
        env: { PATH: "/empty" },
        runner: fakeRunner([], {}),
        access: fakeAccess([]),
        fs: readOnlyFs({}),
      },
    });

    expect(result.code).toBe(1);
    const plan = CliSetupPlanSchema.parse(result.output);
    expect(plan.summary).toMatchObject({
      launchReady: true,
      workflowReady: false,
      requiredOk: false,
    });
    expect(plan.checks.some((check) => check.id === "bun")).toBe(false);
    expect(plan.checks.some((check) => check.id === "station-ui")).toBe(false);
    expect(plan.checks.some((check) => check.id === "command-line-tools")).toBe(false);
    expect(plan.actions.some((action) => action.id === "install-bun")).toBe(false);
  });

  it("threads the process-owned launcher into setup instead of accepting a split PATH", async () => {
    const root = await tempRoot(tempRoots);
    const runtimeBin = join(root, "runtime");
    const shadowBin = join(root, "shadow");
    const providerHookIngressLauncher = join(runtimeBin, "stn-ingress");
    const result = await runCli(["setup", "check", "--json"], {
      providerHookIngressLauncher,
      setupDeps: {
        compiled: true,
        cwd: root,
        homeDir: join(root, "home"),
        env: { PATH: shadowBin },
        runner: fakeRunner([], {}),
        access: fakeAccess([
          join(runtimeBin, "stn"),
          join(shadowBin, "stn"),
          join(shadowBin, "stn-ingress"),
          join(shadowBin, "stn-tmux-popup"),
        ]),
        fs: readOnlyFs({}),
      },
    });
    const plan = CliSetupPlanSchema.parse(result.output);

    expect(plan.checks.find((check) => check.id === "station-launchers")).toMatchObject({
      status: "warn",
      details: {
        station: join(runtimeBin, "stn"),
        ingress: providerHookIngressLauncher,
      },
    });
    expect(plan.actions.find((action) => action.id === "worktrunk-hooks")).toBeUndefined();
  });

  it("preserves installed launcher PATH evidence after successful noninteractive apply", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const home = join(root, "home");
    const configPath = join(root, "config.toml");
    const installedRoot = join(root, "installed path's bin");
    const stationLauncher = join(installedRoot, "stn");
    const providerHookIngressLauncher = join(installedRoot, "stn-ingress");
    const popupLauncher = join(installedRoot, "stn-tmux-popup");
    const shellQuotedRoot = `'${installedRoot.replaceAll("'", "'\\''")}'`;
    const shellQuotedStation = `'${stationLauncher.replaceAll("'", "'\\''")}'`;
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const chunks: string[] = [];
    const setupDeps = {
      compiled: true,
      tmuxPopupOwnerRoot: installedRoot,
      providerHookIngressLauncher,
      cwd: repo,
      homeDir: home,
      env: { PATH: "/fake/bin" },
      runner: readySetupRunner(repo),
      access: fakeAccess([
        "/fake/bin/wt",
        "/fake/bin/tmux",
        "/fake/bin/bun",
        "/fake/bin/hunk",
        stationLauncher,
        providerHookIngressLauncher,
        popupLauncher,
      ]),
      fs,
      activateObserverConfig: async () => undefined,
      writeStdout: (chunk: string) => {
        chunks.push(chunk);
      },
    };

    const apply = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps,
    });
    const check = await runCli(["--config", configPath, "setup", "check", "--json"], {
      setupDeps,
    });
    const finalPlan = CliSetupPlanSchema.parse(check.output);
    const output = chunks.join("");

    expect(apply.code).toBe(0);
    expect(check.code).toBe(0);
    expect(finalPlan.summary.requiredOk).toBe(true);
    expect(finalPlan.checks.find((item) => item.id === "station-launchers")).toMatchObject({
      status: "warn",
      details: {
        station: stationLauncher,
        ingress: providerHookIngressLauncher,
        tmuxPopup: popupLauncher,
        pathDirectory: installedRoot,
      },
    });
    expect(output).toContain("Core setup complete.");
    expect(output).toContain("Remaining");
    expect(output).toContain(
      "these bare launchers do not resolve to this installation on PATH: stn, stn-ingress, stn-tmux-popup",
    );
    expect(output).toContain(`Station: ${stationLauncher}`);
    expect(output).toContain(`Ingress: ${providerHookIngressLauncher}`);
    expect(output).toContain(`tmux popup: ${popupLauncher}`);
    expect(output).toContain(`PATH=${shellQuotedRoot}\${PATH:+":$PATH"}`);
    expect(output).toContain(`${shellQuotedStation} doctor`);
    expect(output).toContain(`  ${shellQuotedStation}\n`);
    expect(output).toContain("Use stn instead of the absolute path (optional):");
    expect(output).toContain(
      `For future shells, add ${shellQuotedRoot} to PATH in a shell configuration you choose.`,
    );
    expect(output).toContain(
      "Use PATH rather than an alias so all three STATION launcher names resolve together.",
    );
    expect(output).toContain("command -v stn-tmux-popup");
    expect(output).toContain("Future login shell launcher resolution remains unverified");
    expect(output).not.toContain("\n  stn doctor\n");
    expect(output).not.toContain("\n  stn\n");
    expect(output).not.toContain("station:link");
    expect(output.split("\n").some((line) => /^\s*[[{]/.test(line))).toBe(false);
    expect(output).not.toMatch(
      /"(?:provider|commands|before|after|rawResult|serializedResult|data)"\s*:/,
    );
    expect(output).not.toMatch(/command\s+\[[^\]]*\]/);
  });

  it("generates the compiled binding from installed ownership while preserving its key", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const home = join(root, "home");
    const installedRoot = join(root, "installed");
    const popupAlias = join(installedRoot, "stn-tmux-popup");
    const tmuxCommand = "/fake/bin/tmux";
    const tmuxConfigPath = join(home, ".tmux.conf");
    await mkdir(repo, { recursive: true });
    const fs = readOnlyFs({
      [tmuxConfigPath]: [
        "# >>> station popup binding >>>",
        "# Change Space to any tmux key; stn setup preserves it.",
        "bind-key C-s run-shell -b 'old-command'",
        "# <<< station popup binding <<<",
        "",
      ].join("\n"),
    });

    const result = await runCli(["setup", "plan", "--json"], {
      setupDeps: {
        compiled: true,
        tmuxPopupOwnerRoot: installedRoot,
        cwd: repo,
        homeDir: home,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess([
          "/fake/bin/wt",
          tmuxCommand,
          "/fake/bin/hunk",
          "/fake/bin/stn",
          "/fake/bin/stn-ingress",
          popupAlias,
        ]),
        fs,
      },
    });

    expect(result.code).toBe(0);
    const plan = CliSetupPlanSchema.parse(result.output);
    const runShellCommand = buildManagedFastPopupRunShellCommand({
      installedRoot,
      fallbackAlias: popupAlias,
      tmuxCommand,
    });
    expect(plan.checks.find((check) => check.id === "tmux-popup-binding")?.details).toMatchObject({
      bindingKey: "C-s",
    });
    const bindingAction = plan.actions.find((action) => action.id === "tmux-popup-binding");
    expect(bindingAction?.data?.appendedText).toContain("bind-key C-s run-shell -b");
    expect(bindingAction?.data?.appendedText).toContain(
      `'${runShellCommand.replaceAll("'", "'\\''")}'`,
    );
  });

  it("setup plan is read-only and includes a config write action", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const chunks: string[] = [];

    const result = await runCli(["--config", join(root, "config.toml"), "setup", "plan"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs: readOnlyFs({}),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result).toEqual({ code: 0 });
    expect(chunks.join("")).toContain("Write STATION config");
  });

  it("setup apply --dry-run performs no writes or external installs", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const chunks: string[] = [];
    let activationCount = 0;
    let trackingCount = 0;

    const result = await runCli(
      ["--config", join(root, "config.toml"), "setup", "apply", "--dry-run"],
      {
        setupDeps: {
          cwd: repo,
          homeDir: join(root, "home"),
          env: { PATH: "/fake/bin" },
          runner: fakeRunner(calls, {
            "git rev-parse --show-toplevel": repo,
            "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
            "brew --version": "Homebrew 4.0.0\n",
            "codex --version": "codex 0.1.0\n",
          }),
          access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
          fs,
          activateObserverConfig: async () => {
            activationCount += 1;
          },
          providerTrackingPort: async (operation) => {
            trackingCount += 1;
            return {
              status: "completed",
              operationId: operation.id,
              commit: { kind: "provider-tracking", provider: "codex", changed: true },
            };
          },
          writeStdout: (chunk) => {
            chunks.push(chunk);
          },
        },
      },
    );

    expect(result.code).toBe(0);
    expect(chunks.join("")).toContain("SKIP      Write STATION config");
    expect(Object.keys(fs.files)).toEqual([]);
    expect(calls.some((call) => call.command === "brew" && call.args?.[0] === "install")).toBe(
      false,
    );
    expect(activationCount).toBe(0);
    expect(trackingCount).toBe(0);
  });

  it("reinspects package installs with refreshed Homebrew paths and facts", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const worktrunkProbes: ExternalCommandInput[] = [];
    const fs = fakeFs({});
    const chunks: string[] = [];
    let worktrunkInstalled = false;
    let trackingInstalled = false;
    let trackingOperationCount = 0;
    const runner = async (input: ExternalCommandInput): Promise<ExternalCommandResult> => {
      calls.push(input);
      if (input.command === "brew" && input.args?.join(" ") === "install worktrunk") {
        worktrunkInstalled = true;
        return commandResult(input, "");
      }
      if (input.command.endsWith("/wt") || input.command === "wt") {
        worktrunkProbes.push(input);
      }
      return fakeRunner([], {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "/opt/homebrew/bin/wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "brew --version": "Homebrew 4.0.0\n",
        "codex --version": "codex 0.1.0\n",
      })(input);
    };
    const available = new Set([
      "/usr/bin/lsof",
      "/usr/sbin/lsof",
      "/fake/bin/tmux",
      "/fake/bin/bun",
      "/fake/bin/hunk",
      "/fake/bin/stn",
      "/fake/bin/stn-ingress",
      "/fake/bin/stn-tmux-popup",
    ]);

    const result = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner,
        access: async (path) => {
          if (available.has(path)) return;
          if (worktrunkInstalled && path === "/opt/homebrew/bin/wt") return;
          throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
        },
        fs,
        activateObserverConfig: async () => undefined,
        probeHarnessHooksStatus: async (harnessId) => ({
          provider: harnessId,
          requested: true,
          installed: trackingInstalled,
          missing: trackingInstalled ? [] : ["tracking artifact"],
          message: trackingInstalled ? "Tracking is installed." : "Tracking is missing.",
        }),
        providerTrackingPort: async (operation) => {
          trackingOperationCount += 1;
          trackingInstalled = true;
          return {
            status: "completed",
            operationId: operation.id,
            commit: { kind: "provider-tracking", provider: "codex", changed: true },
          };
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result.code, chunks.join("")).toBe(0);
    expect(trackingOperationCount).toBe(1);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "brew", args: ["install", "worktrunk"] }),
        expect.objectContaining({ command: "/opt/homebrew/bin/wt", args: ["--version"] }),
      ]),
    );
    expect(worktrunkProbes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "/opt/homebrew/bin/wt", args: ["--version"] }),
      ]),
    );
    expect(worktrunkProbes.some((probe) => probe.command === "/fake/bin/wt")).toBe(false);
    expect(fs.files[configPath]).toContain("install_hooks = true");
  });

  it("renders typed inspection failures when no setup snapshot is available", async () => {
    const chunks: string[] = [];
    const inspectionError = {
      tag: "SyntheticInspectionError",
      code: "SYNTHETIC_INSPECTION_FAILED",
      message: "Synthetic inspection failed before projection.",
      hint: "Repair the synthetic inspection fixture.",
    };

    const result = await runCli(["setup", "check"], {
      setupDeps: {
        now: () => {
          throw inspectionError;
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result.code).toBe(1);
    expect(chunks.join("")).toContain("Synthetic inspection failed before projection.");
    expect(chunks.join("")).toContain("SYNTHETIC_INSPECTION_FAILED");
    expect(chunks.join("")).toContain("Repair the synthetic inspection fixture.");
  });

  it("renders the failed apply result when config persistence fails", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    fs.rename = async () => {
      throw new Error("synthetic config rename failure");
    };
    const chunks: string[] = [];
    let activationCount = 0;

    const result = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: readySetupRunner(repo),
        access: readySetupAccess(),
        fs,
        activateObserverConfig: async () => {
          activationCount += 1;
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result.code).toBe(1);
    expect(activationCount).toBe(0);
    expect(fs.files[configPath]).toBeUndefined();
    expect(chunks.join("")).toContain("Failed: Write STATION config");
    expect(chunks.join("")).toContain("Config write failed. Run: stn setup plan");
  });

  it("blocks ambiguous noninteractive setup without mutation", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];
    const fs = fakeFs({});
    const setupDeps = {
      cwd: repo,
      homeDir: join(root, "home"),
      env: { PATH: "/fake/bin" },
      runner: fakeRunner(calls, {
        "git rev-parse --show-toplevel": repo,
        "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
        "wt --version": "worktrunk 1.2.3\n",
        "tmux -V": "tmux 3.5a\n",
        "codex --version": "codex 0.1.0\n",
        "opencode --version": "opencode 1.0.0\n",
      }),
      access: readySetupAccess(),
      fs,
      writeStdout: (chunk: string) => {
        chunks.push(chunk);
      },
    };

    const plan = await runCli(["--config", configPath, "setup", "plan", "--json"], {
      setupDeps,
    });
    const dryRun = await runCli(["--config", configPath, "setup", "apply", "--dry-run"], {
      setupDeps,
    });
    const apply = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps,
    });

    expect(plan.code).toBe(0);
    expect(plan.output).toMatchObject({
      summary: { selectionSource: "unresolved", requiredOk: false },
    });
    expect(dryRun.code).toBe(1);
    expect(apply.code).toBe(1);
    expect(chunks.join("")).toContain("Run guided setup and choose an agent CLI");
    expect(chunks.join("")).toContain(`stn --config ${configPath} setup`);
    expect(fs.files).toEqual({});
    expect(
      calls.some(
        (call) =>
          (call.command === "brew" && call.args?.[0] === "install") ||
          ((call.args ?? []).includes("hooks") && (call.args ?? []).includes("install")),
      ),
    ).toBe(false);
  });

  it("fails closed when a required provider omits hook-status inspection", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const config = setupConfigToml(repo, { includeHarness: true }).replace(
      'command = "codex"',
      'command = "codex"\ninstall_hooks = true',
    );

    const result = await runCli(["--config", configPath, "setup", "check", "--json"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: readySetupRunner(repo),
        access: readySetupAccess(),
        fs: fakeFs({ [configPath]: config }),
        probeHarnessHooksStatus: async () => undefined,
      },
    });

    expect(result.code).toBe(1);
    expect(CliSetupPlanSchema.parse(result.output)).toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "harness-tracking:codex",
          status: "missing",
          details: expect.objectContaining({ state: "probe-failed" }),
        }),
      ]),
      summary: { requiredOk: false },
    });
  });

  it("preserves actionable provider tracking errors in noninteractive output", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const config = setupConfigToml(repo, { includeHarness: true }).replace(
      'command = "codex"',
      'command = "codex"\ninstall_hooks = true',
    );
    const chunks: string[] = [];
    let activationCount = 0;

    const result = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: readySetupRunner(repo),
        access: readySetupAccess(),
        fs: fakeFs({ [configPath]: config }),
        probeHarnessHooksStatus: async (harnessId) => ({
          provider: harnessId,
          requested: true,
          installed: false,
          missing: ["tracking artifact"],
          message: "Tracking artifact is missing.",
        }),
        providerTrackingPort: async (operation) => ({
          status: "failed",
          operationId: operation.id,
          error: {
            tag: "HookOwnershipError",
            code: "HOOK_OWNER_CONFLICT",
            message: "Another Station runtime owns the hook.",
            hint: "stn hooks install codex --yes --takeover",
          },
        }),
        activateObserverConfig: async () => {
          activationCount += 1;
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(output).toContain("Another Station runtime owns the hook.");
    expect(output).toContain("HOOK_OWNER_CONFLICT");
    expect(output).toContain("stn hooks install codex --yes --takeover");
    expect(activationCount).toBe(0);
  });

  it("keeps apply non-ready when the final artifact re-probe fails", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    let activations = 0;

    const result = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: readySetupRunner(repo),
        access: readySetupAccess(),
        fs,
        activateObserverConfig: async () => {
          activations += 1;
        },
        providerTrackingPort: successfulProviderTrackingPort,
        async probeHarnessHooksStatus(harnessId) {
          return {
            provider: harnessId,
            requested: true,
            installed: false,
            missing: ["tracking artifact"],
            message: "Tracking artifact disappeared before final verification.",
          };
        },
        writeStdout: () => undefined,
      },
    });

    expect(result.code).toBe(1);
    expect(activations).toBe(1);
    expect(fs.files[configPath]).toContain("install_hooks = true");
  });

  it("does not append or activate the current repository during setup", async () => {
    const root = await tempRoot(tempRoots);
    const home = join(root, "home");
    const repo = join(root, "repo");
    const otherRepo = join(root, "other");
    const configPath = join(home, "station", "config.toml");
    await mkdir(repo, { recursive: true });
    await mkdir(otherRepo, { recursive: true });
    const original = setupConfigToml(otherRepo, { includeHarness: true }).replace(
      'command = "codex"',
      'command = "codex"\ninstall_hooks = true',
    );
    const fs = fakeFs({ [configPath]: original });
    const activations: Array<{ configPath: string; homeDir: string }> = [];

    const result = await runCli(["--config", "~/station/config.toml", "setup", "apply", "--yes"], {
      setupDeps: {
        cwd: repo,
        homeDir: home,
        env: { PATH: "/fake/bin" },
        runner: readySetupRunner(repo),
        access: readySetupAccess(),
        fs,
        activateObserverConfig: async (input) => {
          activations.push(input);
        },
        writeStdout: () => undefined,
      },
    });

    expect(result.code).toBe(0);
    expect(fs.files[configPath]).toBe(original);
    expect(activations).toEqual([]);
  });

  it("activates a harness-only config write", async () => {
    const root = await tempRoot(tempRoots);
    const home = join(root, "home");
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({ [configPath]: setupConfigToml(repo) });
    let activationCount = 0;

    const result = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps: {
        cwd: repo,
        homeDir: home,
        env: { PATH: "/fake/bin" },
        runner: readySetupRunner(repo),
        access: readySetupAccess(),
        fs,
        activateObserverConfig: async () => {
          activationCount += 1;
          expect(fs.files[configPath]).toContain("[harness.codex]");
          expect(fs.files[configPath]?.match(/\[\[projects\]\]/g)).toHaveLength(1);
        },
        writeStdout: () => undefined,
      },
    });

    expect(result.code).toBe(0);
    expect(activationCount).toBe(1);
  });

  it("keeps a successful config write when observer activation fails", async () => {
    const root = await tempRoot(tempRoots);
    const home = join(root, "home");
    const repo = join(root, "repo");
    const configPath = join(root, "custom config.toml");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});
    const chunks: string[] = [];

    const result = await runCli(["--config", configPath, "setup", "apply", "--yes"], {
      setupDeps: {
        cwd: repo,
        homeDir: home,
        env: { PATH: "/fake/bin" },
        runner: readySetupRunner(repo),
        access: readySetupAccess(),
        fs,
        activateObserverConfig: async () => {
          throw {
            tag: "ObserverStartupError",
            code: "OBSERVER_EXITED_ON_START",
            message: "Observer exited during activation.",
            hint: "Inspect the observer boot log.",
          };
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(fs.files[configPath]).toContain("projects = []");
    expect(output).toContain("Config was written, but observer activation failed.");
    expect(output).toContain("Code: OBSERVER_EXITED_ON_START");
    expect(output).toContain("Hint: Inspect the observer boot log.");
    expect(output).toContain("The config is saved; remaining setup actions were not applied.");
    expect(output).toContain(`Then rerun: stn --config '${configPath}' setup apply --yes`);
    expect(output).toContain("Resolve the error above, then activate it with:");
    expect(output).toContain(`Run: stn --config '${configPath}' observer restart`);
    expect(output).not.toContain("Core setup complete.");
  });

  it("rejects bare setup --dry-run without writing files", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const fs = fakeFs({});

    const result = await runCli(["--config", join(root, "config.toml"), "setup", "--dry-run"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        fs,
        writeStdout: () => undefined,
      },
    });

    expect(result.code).toBe(2);
    expect(Object.keys(fs.files)).toEqual([]);
  });

  it("setup check --json exits non-zero for invalid existing config", async () => {
    const root = await tempRoot(tempRoots);
    const repo = join(root, "repo");
    const configPath = join(root, "config.toml");
    await mkdir(repo, { recursive: true });

    const result = await runCli(["--config", configPath, "setup", "check", "--json"], {
      setupDeps: {
        cwd: repo,
        homeDir: join(root, "home"),
        env: { PATH: "/fake/bin" },
        runner: fakeRunner([], {
          "git rev-parse --show-toplevel": repo,
          "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "codex --version": "codex 0.1.0\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        fs: readOnlyFs({ [configPath]: "schema_version = 1\n[defaults\n" }),
      },
    });

    expect(result.code).toBe(1);
    expect(CliSetupPlanSchema.parse(result.output)).toMatchObject({
      summary: { workflowReady: false, requiredOk: false },
    });
  });

  it("setup system reports incompatible development toolchain versions without changing them", async () => {
    const root = await tempRoot(tempRoots);
    const chunks: string[] = [];

    const result = await runCli(["setup", "system", "--check"], {
      setupDeps: {
        cwd: root,
        env: { PATH: "/fake/bin" },
        nodeVersion: "v22.14.0",
        runner: fakeRunner([], {
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
          "brew --version": "Homebrew 4.0.0\n",
          "bun --version": "1.3.14\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/bun", "/fake/bin/hunk"]),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    const output = chunks.join("");
    expect(result.code).toBe(1);
    expect(output).toContain("expected >=24.2 <25");
    expect(output).toContain("WARN Bun incompatible 1.3.14 (expected 1.4.0)");
    expect(output).toContain(
      "Use your Node version manager to install and select Node.js 24.2+ (and below 25)",
    );
    expect(output).toContain("fnm install 24 && fnm use 24");
    expect(output).toContain("nvm install 24 && nvm use 24");
    expect(output).toContain("Install or select Bun 1.4.0");
    expect(output).toContain("STATION setup does not change Node or Bun automatically.");
  });

  it("setup system --check --yes is invalid and performs no install calls", async () => {
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runCli(["setup", "system", "--check", "--yes"], {
      setupDeps: {
        runner: fakeRunner(calls, {}),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result.code).toBe(2);
    expect(chunks.join("")).toContain("cannot use --check and --yes together");
    expect(calls).toEqual([]);
  });

  it("setup system --yes stops ordered installs after the first required failure", async () => {
    const root = await tempRoot(tempRoots);
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runCli(["setup", "system", "--yes"], {
      setupDeps: {
        cwd: root,
        env: { PATH: "/fake/bin" },
        runner: async (input) => {
          calls.push(input);
          if (`${input.command} ${(input.args ?? []).join(" ")}` === "brew install worktrunk") {
            throw new Error("synthetic Worktrunk install failure");
          }
          return fakeRunner([], {
            "brew --version": "Homebrew 4.0.0\n",
            "bun --version": "1.4.0\n",
          })(input);
        },
        access: fakeAccess([]),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result.code).toBe(1);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "brew", args: ["install", "worktrunk"] }),
      ]),
    );
    expect(
      calls.some((call) => call.command === "brew" && call.args?.join(" ") === "install tmux"),
    ).toBe(false);
    expect(chunks.join("")).toContain("Failed: Install Worktrunk");
    expect(chunks.join("")).toContain("stn setup system final");
  });

  it("setup system --yes rechecks after fake installs and returns refreshed readiness", async () => {
    const root = await tempRoot(tempRoots);
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];
    const available = new Set<string>();

    const result = await runCli(["setup", "system", "--yes"], {
      setupDeps: {
        cwd: root,
        env: { PATH: "/fake/bin" },
        runner: async (input) => {
          calls.push(input);
          const key = `${input.command} ${(input.args ?? []).join(" ")}`;
          if (key === "brew install worktrunk") {
            available.add("/fake/bin/wt");
            return commandResult(input, "");
          }
          if (key === "brew install tmux") {
            available.add("/fake/bin/tmux");
            return commandResult(input, "");
          }
          if (key === "brew install bun") {
            available.add("/fake/bin/bun");
            return commandResult(input, "");
          }
          if (key === "brew install hunk") {
            available.add("/fake/bin/hunk");
            return commandResult(input, "");
          }
          return fakeRunner([], {
            "brew --version": "Homebrew 4.0.0\n",
            "bun --version": "1.4.0\n",
            "wt --version": "worktrunk 1.2.3\n",
            "tmux -V": "tmux 3.5a\n",
          })(input);
        },
        access: async (path) => {
          if (!available.has(path)) {
            throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
          }
        },
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result.code).toBe(0);
    expect(
      calls
        .filter((call) => call.command === "brew" && call.args?.[0] === "install")
        .map((call) => [call.command, ...(call.args ?? [])].join(" ")),
    ).toEqual([
      "brew install worktrunk",
      "brew install tmux",
      "brew install bun",
      "brew install hunk",
    ]);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "/fake/bin/wt", args: ["--version"] }),
        expect.objectContaining({ command: "/fake/bin/tmux", args: ["-V"] }),
      ]),
    );
    expect(chunks.join("")).toContain("stn setup system final");
    expect(chunks.join("")).toContain("OK Worktrunk / wt");
  });

  it("setup system omits Bun rows and installation in compiled mode", async () => {
    const calls: ExternalCommandInput[] = [];
    const chunks: string[] = [];

    const result = await runCli(["setup", "system", "--yes"], {
      setupDeps: {
        compiled: true,
        env: { PATH: "/fake/bin" },
        runner: fakeRunner(calls, {
          "brew --version": "Homebrew 4.0.0\n",
          "bun --version": "1.4.0\n",
          "wt --version": "worktrunk 1.2.3\n",
          "tmux -V": "tmux 3.5a\n",
        }),
        access: fakeAccess(["/fake/bin/wt", "/fake/bin/tmux", "/fake/bin/hunk"]),
        writeStdout: (chunk) => {
          chunks.push(chunk);
        },
      },
    });

    expect(result.code).toBe(0);
    expect(calls.some((call) => call.args?.join(" ") === "install bun")).toBe(false);
    expect(chunks.join("")).not.toMatch(/(?:OK|MISSING) Bun/);
  });
});

async function tempRoot(tempRoots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-setup-cli-"));
  tempRoots.push(root);
  return root;
}

function fakeRunner(
  calls: ExternalCommandInput[],
  outputs: Record<string, string>,
): (input: ExternalCommandInput) => Promise<ExternalCommandResult> {
  return async (input) => {
    calls.push(input);
    const key = `${input.command} ${(input.args ?? []).join(" ")}`;
    // Synthetic machines have macOS Command Line Tools unless a test overrides it.
    const stdout =
      outputs[key] ??
      fakeBinOutput(input, outputs) ??
      ((input.args ?? []).includes("hooks") && (input.args ?? []).includes("install")
        ? ""
        : undefined) ??
      defaultProbeOutput(key);
    if (stdout === undefined) {
      throw Object.assign(new Error(`missing fake command: ${key}`), { code: "ENOENT" });
    }
    return {
      command: input.command,
      args: input.args ?? [],
      stdout,
      stderr: "",
      exitCode: 0,
    };
  };
}

function fakeBinOutput(
  input: ExternalCommandInput,
  outputs: Record<string, string>,
): string | undefined {
  if (!input.command.startsWith("/fake/bin/")) {
    return undefined;
  }
  return outputs[`${basename(input.command)} ${(input.args ?? []).join(" ")}`];
}

function defaultProbeOutput(key: string): string | undefined {
  if (key === "git --version") return "git version 2.50.1\n";
  if (key === "bun --version") return "1.4.0\n";
  if (key === "xcode-select -p") return "/Library/Developer/CommandLineTools\n";
  return undefined;
}

function commandResult(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}

function fakeAccess(paths: readonly string[]): (path: string) => Promise<void> {
  const available = new Set(["/usr/bin/lsof", "/usr/sbin/lsof", ...paths]);
  return async (path) => {
    if (!available.has(path)) {
      throw Object.assign(new Error(`missing path: ${path}`), { code: "ENOENT" });
    }
  };
}

function readySetupRunner(repo: string) {
  return fakeRunner([], {
    "git rev-parse --show-toplevel": `${repo}\n`,
    "git symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
    "wt --version": "worktrunk 1.2.3\n",
    "tmux -V": "tmux 3.5a\n",
    "brew --version": "Homebrew 4.0.0\n",
    "codex --version": "codex 0.1.0\n",
  });
}

function readySetupAccess(): (path: string) => Promise<void> {
  return fakeAccess([
    "/fake/bin/wt",
    "/fake/bin/tmux",
    "/fake/bin/bun",
    "/fake/bin/hunk",
    "/fake/bin/stn",
    "/fake/bin/stn-ingress",
    "/fake/bin/stn-tmux-popup",
  ]);
}

function setupConfigToml(projectRoot: string, options: { includeHarness?: boolean } = {}): string {
  return [
    "schema_version = 1",
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    'harness = "codex"',
    'layout = "agent-shell"',
    "",
    ...(options.includeHarness === true
      ? ["[harness.codex]", "enabled = true", 'command = "codex"', ""]
      : []),
    "[[projects]]",
    `id = ${JSON.stringify(basename(projectRoot))}`,
    `label = ${JSON.stringify(basename(projectRoot))}`,
    `root = ${JSON.stringify(projectRoot)}`,
    "",
  ].join("\n");
}

function readOnlyFs(initial: Record<string, string>) {
  const files = { ...initial };
  return {
    async mkdir() {
      return undefined;
    },
    async readFile(path: string) {
      const source = files[path];
      if (source === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return source;
    },
    async writeFile(path: string, content: string) {
      files[path] = content;
    },
    async rename(from: string, to: string) {
      const source = files[from];
      if (source === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files[to] = source;
      delete files[from];
    },
    async access(path: string) {
      if (files[path] === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
    },
  };
}

function fakeFs(initial: Record<string, string>) {
  const files = { ...initial };
  return {
    files,
    async mkdir() {
      return undefined;
    },
    async readFile(path: string) {
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return content;
    },
    async writeFile(path: string, content: string) {
      files[path] = content;
    },
    async rename(from: string, to: string) {
      const content = files[from];
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      files[to] = content;
      delete files[from];
    },
    async access(path: string) {
      if (files[path] === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
}
