import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildHarnessLaunchRequest, ProviderHookRuntime } from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPathInsideTestMachineRoot } from "../../../../../packages/testing/src/index.js";
import { installCursorHooks } from "../../src/hooks";
import { createCursorHarnessProvider } from "../../src/provider";

const now = "2026-06-03T12:00:00.000Z";
const usesSharedTestMachine = process.env.STATION_TEST_MACHINE_ROOT !== undefined;

if (!usesSharedTestMachine) {
  // Focused test runners can execute this file without loading the suite-level setup.
  afterEach(() => vi.unstubAllEnvs());
}

describe("CursorHarnessProvider", () => {
  it("declares hook-only Cursor capabilities", () => {
    const provider = createCursorHarnessProvider();

    expect(provider.capabilities()).toEqual({
      canLaunch: true,
      canDiscoverRuns: true,
      canEmitEvents: true,
      canReceivePrompt: false,
      canResume: false,
      canStop: false,
      canRunNonInteractive: false,
      canExposeApprovalState: false,
      supportsModifiedEnterSoftNewline: false,
    });
  });

  it("advertises resume only when configured", () => {
    expect(createCursorHarnessProvider().capabilities().canResume).toBe(false);
    expect(createCursorHarnessProvider({ resume: true }).capabilities().canResume).toBe(true);
  });

  it("checks agent --version for provider health", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createCursorHarnessProvider({
      command: "agent-test",
      now: () => new Date(now),
      runner: async (input) => {
        calls.push(input);
        return result(input, "2026.06.02-8c11d9f\n");
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      provider: "cursor",
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      diagnostics: {
        command: "agent --version succeeded",
        observation: "hooks",
      },
    });
    expect(calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  it("warns clearly when Cursor Agent is logged out", async () => {
    const provider = createCursorHarnessProvider({
      runner: async (input) =>
        result(
          input,
          JSON.stringify({
            status: "unauthenticated",
            isAuthenticated: false,
            hasAccessToken: false,
            hasRefreshToken: false,
            message: "Not logged in",
          }),
        ),
    });

    await expect(provider.doctorChecks?.()).resolves.toContainEqual(
      expect.objectContaining({
        name: "cursor.auth",
        status: "warn",
        message: expect.stringContaining("agent login"),
      }),
    );
  });

  it("reports unrequested and missing hook preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-provider-missing-"));
    stubCursorTestHome(root);

    await expect(createCursorHarnessProvider().hooksStatus?.()).resolves.toMatchObject({
      provider: "cursor",
      requested: false,
      installed: false,
    });
    await expect(
      createCursorHarnessProvider({ installHooks: true }).hooksStatus?.(),
    ).resolves.toMatchObject({
      provider: "cursor",
      requested: true,
      installed: false,
      message: expect.stringContaining("missing or stale"),
    });
  });

  it("uses observer hook paths when checking installed hook diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-provider-"));
    const hookScriptPath = join(root, "state", "hooks", "station-cursor-hook.sh");
    const stationConfigPath = join(root, "station.config.toml");
    const observerSocketPath = join(root, "run", "observer.sock");
    const stateDir = join(root, "state");
    const hookSpoolDir = join(stateDir, "spool", "hooks");

    stubCursorTestHome(root);
    await installCursorHooks({
      hookScriptPath,
      stationConfigPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
      homeDir: root,
    });

    const provider = createCursorHarnessProvider({
      installHooks: true,
      configPath: stationConfigPath,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      autoStartFromHooks: false,
      runner: cursorAuthRunner,
    });

    const doctorChecks = provider.doctorChecks;
    if (doctorChecks === undefined) throw new Error("Cursor doctor checks are unavailable.");
    await expect(doctorChecks()).resolves.toContainEqual(
      expect.objectContaining({
        name: "cursor-hooks",
        status: "ok",
      }),
    );
    await expect(provider.hooksStatus?.()).resolves.toMatchObject({
      provider: "cursor",
      requested: true,
      installed: true,
    });

    await writeFile(hookScriptPath, "# drifted\n", "utf8");
    await expect(provider.hooksStatus?.()).resolves.toMatchObject({
      provider: "cursor",
      requested: true,
      installed: false,
      message: expect.stringContaining("missing or stale"),
    });
  });

  it("does not re-add the incumbent config when the requester omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-requester-"));
    const incumbentStateDir = join(root, "checkout-A", "state");
    const requesterStateDir = join(root, "checkout-B", "state");
    const providerHookRuntime: ProviderHookRuntime = {
      ingressLauncher: "/checkout/B/bin/stn-ingress",
      observerSocketPath: join(root, "shared", "observer.sock"),
      stateDir: requesterStateDir,
      hookSpoolDir: join(requesterStateDir, "spool", "hooks"),
      autoStartFromHooks: false,
    };
    stubCursorTestHome(root);
    await installCursorHooks({
      hookBin: providerHookRuntime.ingressLauncher,
      observerSocketPath: providerHookRuntime.observerSocketPath,
      stateDir: providerHookRuntime.stateDir,
      hookSpoolDir: providerHookRuntime.hookSpoolDir,
      autoStartFromHooks: providerHookRuntime.autoStartFromHooks,
    });
    const provider = createCursorHarnessProvider({
      installHooks: true,
      configPath: join(root, "checkout-A", "config.toml"),
      observerSocketPath: providerHookRuntime.observerSocketPath,
      stateDir: incumbentStateDir,
      hookSpoolDir: join(incumbentStateDir, "spool", "hooks"),
      autoStartFromHooks: true,
      runner: cursorAuthRunner,
    });

    await expect(provider.doctorChecks?.({ providerHookRuntime })).resolves.toContainEqual(
      expect.objectContaining({ name: "cursor-hooks", status: "ok" }),
    );
  });

  it("routes shared-home hooks through the launching runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-shared-home-"));
    const runtimeA = {
      configPath: join(root, "runtime-a", "config.toml"),
      observerSocketPath: join(root, "runtime-a", "observer.sock"),
      stateDir: join(root, "runtime-a", "state"),
      hookSpoolDir: join(root, "runtime-a", "state", "spool", "hooks"),
    };
    const runtimeB = {
      configPath: join(root, "runtime-b", "config.toml"),
      observerSocketPath: join(root, "runtime-b", "observer.sock"),
      stateDir: join(root, "runtime-b", "state"),
      hookSpoolDir: join(root, "runtime-b", "state", "spool", "hooks"),
    };
    stubCursorTestHome(root);
    await installCursorHooks({
      homeDir: root,
      stationConfigPath: runtimeA.configPath,
      observerSocketPath: runtimeA.observerSocketPath,
      stateDir: runtimeA.stateDir,
      hookSpoolDir: runtimeA.hookSpoolDir,
      autoStartFromHooks: false,
    });
    const providerB = createCursorHarnessProvider({
      installHooks: true,
      ...runtimeB,
      autoStartFromHooks: false,
    });

    await expect(providerB.hooksStatus?.()).resolves.toMatchObject({ installed: true });
    await expect(providerB.buildLaunch(request())).resolves.toMatchObject({
      env: {
        STATION_CONFIG_PATH: runtimeB.configPath,
        STATION_OBSERVER_SOCKET_PATH: runtimeB.observerSocketPath,
        STATION_OBSERVER_STATE_DIR: runtimeB.stateDir,
        STATION_HOOK_SPOOL_DIR: runtimeB.hookSpoolDir,
      },
    });
  });

  it("launches interactive Cursor agent with STATION correlation env", async () => {
    const provider = createCursorHarnessProvider({
      command: "agent-test",
    });

    await expect(provider.buildLaunch(request())).resolves.toMatchObject({
      provider: "cursor",
      command: "agent-test",
      args: ["--workspace", "/tmp/station/web/task"],
      cwd: "/tmp/station/web/task",
      env: {
        STATION_HARNESS_PROVIDER: "cursor",
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_task",
        STATION_WORKTREE_PATH: "/tmp/station/web/task",
        STATION_SESSION_ID: "ses_web_task",
        STATION_TERMINAL_PROVIDER: "tmux",
        STATION_TERMINAL_TARGET_ID: "tmux:station:@1:%2",
      },
      providerData: {
        interactive: true,
        observation: "hooks",
        terminalTargetId: "tmux:station:@1:%2",
      },
    });
  });

  it("launches Cursor with the isolated dev home when configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-cursor-launch-home-"));
    stubCursorTestHome(root);
    const provider = createCursorHarnessProvider({ command: "agent-test" });

    await expect(provider.buildLaunch(request())).resolves.toMatchObject({
      env: {
        HOME: root,
        STATION_HARNESS_PROVIDER: "cursor",
      },
    });
  });

  it("launches interactive Cursor resume with the native session id", async () => {
    const provider = createCursorHarnessProvider({
      command: "agent-test",
      resume: true,
    });

    await expect(
      provider.buildLaunch({
        ...request(),
        resume: {
          target: { kind: "native-session", id: "cursor_session_123" },
          previousSessionId: "ses_web_task",
          recoveryHandleId: "rec_cursor",
        },
      }),
    ).resolves.toMatchObject({
      args: ["--workspace", "/tmp/station/web/task", "--resume", "cursor_session_123"],
      providerData: {
        resume: true,
        resumeTargetKind: "native-session",
      },
    });
  });

  it("discovers terminal-bound Cursor runs", async () => {
    const provider = createCursorHarnessProvider();

    await expect(
      provider.discoverRuns({
        projects: [],
        worktrees: [],
        terminalTargets: [
          {
            id: "tmux:station:@1:%2",
            provider: "tmux",
            projectId: "web",
            worktreeId: "wt_web_task",
            sessionId: "ses_web_task",
            state: "open",
            cwd: "/tmp/station/web/task",
            pid: 1234,
            confidence: "high",
            reason: "tmux pane has station identity binding.",
            observedAt: now,
            harnessBinding: {
              role: "main-agent",
              harnessProvider: "cursor",
              currentCommand: "agent",
            },
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "cursor:tmux:station:@1:%2",
        provider: "cursor",
        worktreeId: "wt_web_task",
        status: expect.objectContaining({ value: "unknown", confidence: "low" }),
      }),
    ]);
  });

  it("classifies Cursor observations without owning raw hook ingestion", async () => {
    const provider = createCursorHarnessProvider({ now: () => new Date(now) });

    expect("classifyRun" in provider).toBe(false);

    expect("ingestEvent" in provider).toBe(false);
  });
});

function stubCursorTestHome(root: string): void {
  if (!usesSharedTestMachine) vi.stubEnv("STATION_TEST_MACHINE_ROOT", root);
  assertPathInsideTestMachineRoot(root, "Cursor test home");
  vi.stubEnv("STATION_CURSOR_HOME", root);
  vi.stubEnv("STATION_CURSOR_HOOKS_PATH", "");
}

function cursorAuthRunner(input: ExternalCommandInput): Promise<ExternalCommandResult> {
  return Promise.resolve(
    result(
      input,
      JSON.stringify({
        status: "authenticated",
        isAuthenticated: true,
        hasAccessToken: true,
        hasRefreshToken: true,
        userInfo: {},
      }),
    ),
  );
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

function request(): BuildHarnessLaunchRequest {
  const target = eventContext().terminalTargets[0];
  if (target === undefined) {
    throw new Error("Cursor provider fixture is missing a terminal target.");
  }
  return {
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "cursor",
        terminal: "tmux",
        layout: "agent-shell",
      },
      worktrunk: {
        enabled: true,
      },
    },
    worktree: {
      id: "wt_web_task",
      provider: "worktrunk",
      projectId: "web",
      branch: "task",
      path: "/tmp/station/web/task",
      state: "exists",
      source: "worktrunk",
      observedAt: now,
    },
    terminalTarget: target,
    mode: "interactive",
    sessionId: "ses_web_task",
  };
}

function eventContext() {
  return {
    projects: [],
    worktrees: [
      {
        id: "wt_web_task",
        provider: "worktrunk",
        projectId: "web",
        branch: "task",
        path: "/tmp/station/web/task",
        state: "exists" as const,
        source: "worktrunk" as const,
        observedAt: now,
      },
    ],
    terminalTargets: [
      {
        id: "tmux:station:@1:%2",
        provider: "tmux",
        projectId: "web",
        worktreeId: "wt_web_task",
        sessionId: "ses_web_task",
        state: "open" as const,
        cwd: "/tmp/station/web/task",
        confidence: "high" as const,
        reason: "tmux pane has station identity binding.",
        observedAt: now,
        harnessBinding: {
          role: "main-agent",
          harnessProvider: "cursor",
        },
      },
    ],
  };
}
