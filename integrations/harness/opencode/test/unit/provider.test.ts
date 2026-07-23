import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BuildHarnessLaunchRequest,
  HarnessRunObservation,
  RawHarnessEvent,
} from "@station/contracts";
import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { installOpenCodePlugin } from "../../src/pluginInstall";
import { createOpenCodeHarnessProvider } from "../../src/provider";

const now = "2026-05-20T12:00:00.000Z";

describe("OpenCodeHarnessProvider", () => {
  it("declares real OpenCode capabilities", () => {
    const provider = createOpenCodeHarnessProvider();

    expect(provider.capabilities()).toEqual({
      canLaunch: true,
      canDiscoverRuns: true,
      canEmitEvents: true,
      canClassifyStatus: true,
      canReceivePrompt: false,
      canResume: false,
      canStop: false,
      canRunNonInteractive: true,
      canExposeApprovalState: true,
      supportsModifiedEnterSoftNewline: false,
    });
  });

  it("advertises resume only when configured", () => {
    expect(createOpenCodeHarnessProvider().capabilities().canResume).toBe(false);
    expect(createOpenCodeHarnessProvider({ resume: true }).capabilities().canResume).toBe(true);
  });

  it("checks opencode --version for provider health", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createOpenCodeHarnessProvider({
      command: "opencode-test",
      now: () => new Date(now),
      runner: async (input) => {
        calls.push(input);
        return result(input, "1.15.12\n");
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      providerId: "opencode",
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      diagnostics: {
        command: "opencode --version succeeded",
      },
    });
    expect(calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  it("maps health failures to typed OpenCode provider health", async () => {
    const provider = createOpenCodeHarnessProvider({
      command: "missing-opencode",
      now: () => new Date(now),
      runner: async () => {
        throw Object.assign(new Error("not found"), {
          code: "ENOENT",
          stderr: "missing-opencode: command not found",
        });
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      providerId: "opencode",
      providerType: "harness",
      status: "unavailable",
      lastError: {
        tag: "HarnessProviderError",
        code: "HARNESS_OPENCODE_UNAVAILABLE",
        provider: "opencode",
      },
    });
  });

  it("applies provider launch defaults and discovers terminal-bound runs", async () => {
    const provider = createOpenCodeHarnessProvider({
      command: "opencode-test",
      profile: "build",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      observerSocketPath: "/tmp/station/run/observer.sock",
      stateDir: "/tmp/station/state",
      hookSpoolDir: "/tmp/station/state/spool/hooks",
      now: () => new Date(now),
    });

    await expect(provider.buildLaunch(request())).resolves.toMatchObject({
      provider: "opencode",
      command: "opencode-test",
      args: ["--agent", "build", "--prompt", "Do not send this automatically."],
      cwd: "/tmp/station/web/task",
      mode: "interactive",
      env: {
        STATION_SESSION_ID: "ses_web_task",
        STATION_PROJECT_ID: "web",
        STATION_WORKTREE_ID: "wt_web_task",
        STATION_WORKTREE_PATH: "/tmp/station/web/task",
        STATION_HARNESS_PROVIDER: "opencode",
        STATION_OBSERVER_SOCKET_PATH: "/tmp/station/run/observer.sock",
        STATION_OBSERVER_STATE_DIR: "/tmp/station/state",
        STATION_HOOK_SPOOL_DIR: "/tmp/station/state/spool/hooks",
      },
      providerData: {
        interactive: true,
        initialPromptProvided: true,
        profile: "build",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
      },
    });

    await expect(provider.buildLaunch({ ...request(), mode: "exec" })).resolves.toMatchObject({
      args: ["run", "--format", "json", "--agent", "build", "Do not send this automatically."],
    });

    await expect(
      provider.discoverRuns({
        projects: [],
        worktrees: eventContext().worktrees,
        terminalTargets: eventContext().terminalTargets,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "opencode",
        worktreeId: "wt_web_task",
        state: "unknown",
        confidence: "low",
      }),
    ]);
  });

  it("applies yolo permission mode to non-interactive OpenCode launch plans", async () => {
    const provider = createOpenCodeHarnessProvider({
      permissionMode: "yolo",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });

    await expect(provider.buildLaunch({ ...request(), mode: "exec" })).resolves.toMatchObject({
      args: [
        "run",
        "--format",
        "json",
        "--dangerously-skip-permissions",
        "Do not send this automatically.",
      ],
      providerData: {
        permissionMode: "yolo",
      },
    });
  });

  it("carries an isolated OPENCODE_CONFIG_DIR into the launch env", async () => {
    const previous = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = "/tmp/station/opencode-config";
    try {
      const provider = createOpenCodeHarnessProvider();

      await expect(provider.buildLaunch(request())).resolves.toMatchObject({
        env: {
          STATION_HARNESS_PROVIDER: "opencode",
          OPENCODE_CONFIG_DIR: "/tmp/station/opencode-config",
        },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = previous;
      }
    }
  });

  it("launches interactive OpenCode resume with the native session id", async () => {
    const provider = createOpenCodeHarnessProvider({
      command: "opencode-test",
      resume: true,
    });

    await expect(
      provider.buildLaunch({
        ...request(),
        resume: {
          target: { kind: "native-session", id: "opencode_session_123" },
          previousSessionId: "ses_web_task",
          recoveryHandleId: "rec_opencode",
        },
      }),
    ).resolves.toMatchObject({
      args: ["--session", "opencode_session_123", "--prompt", "Do not send this automatically."],
      providerData: {
        resume: true,
        resumeTargetKind: "native-session",
      },
    });
  });

  it("reports unrequested and missing plugin preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-provider-missing-"));
    const env = { OPENCODE_CONFIG_DIR: root };

    await expect(createOpenCodeHarnessProvider({ env }).hooksStatus?.()).resolves.toMatchObject({
      provider: "opencode",
      requested: false,
      installed: false,
    });
    await expect(
      createOpenCodeHarnessProvider({ env, installHooks: true }).hooksStatus?.(),
    ).resolves.toMatchObject({
      provider: "opencode",
      requested: true,
      installed: false,
      message: expect.stringContaining("not installed"),
    });
  });

  it("uses observer plugin paths when checking installed OpenCode plugin diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-provider-"));
    const opencodeConfigDir = join(root, "opencode");
    const pluginPath = join(opencodeConfigDir, "plugins", "station-agent-state.js");
    const observerSocketPath = join(root, "run", "observer.sock");
    const stateDir = join(root, "state");
    const hookSpoolDir = join(stateDir, "spool", "hooks");

    await installOpenCodePlugin({
      opencodeConfigDir,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
    });

    const provider = createOpenCodeHarnessProvider({
      command: "opencode-test",
      installHooks: true,
      observerSocketPath,
      stateDir,
      hookSpoolDir,
      env: {
        OPENCODE_CONFIG_DIR: opencodeConfigDir,
      },
      runner: async (input) => result(input, "1.15.12\n"),
    });

    const doctorChecks = provider.doctorChecks;
    if (doctorChecks === undefined) throw new Error("OpenCode doctor checks are unavailable.");
    await expect(doctorChecks()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "opencode.command",
          status: "ok",
        }),
        expect.objectContaining({
          name: "opencode-plugin",
          status: "ok",
          message: expect.stringContaining(pluginPath),
        }),
      ]),
    );
    await expect(readFile(pluginPath, "utf8")).resolves.toContain(
      "station-opencode-observer-plugin:v1",
    );
    await expect(provider.hooksStatus?.()).resolves.toMatchObject({
      provider: "opencode",
      requested: true,
      installed: true,
    });

    await writeFile(pluginPath, "// drifted\n", "utf8");
    await expect(provider.hooksStatus?.()).resolves.toMatchObject({
      provider: "opencode",
      requested: true,
      installed: false,
      message: expect.stringContaining("not installed"),
    });
  });

  it("checks plugin identity against the complete requester hook runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-opencode-provider-runtime-"));
    const opencodeConfigDir = join(root, "opencode");
    const requesterStateDir = join(root, "requester", "state");
    const requesterHookSpoolDir = join(requesterStateDir, "spool", "hooks");
    const requesterObserverSocketPath = join(root, "requester", "run", "observer.sock");

    await installOpenCodePlugin({
      opencodeConfigDir,
      observerSocketPath: requesterObserverSocketPath,
      stateDir: requesterStateDir,
      hookSpoolDir: requesterHookSpoolDir,
    });

    const provider = createOpenCodeHarnessProvider({
      command: "opencode-test",
      installHooks: true,
      observerSocketPath: join(root, "incumbent", "run", "observer.sock"),
      stateDir: join(root, "incumbent", "state"),
      hookSpoolDir: join(root, "incumbent", "state", "spool", "hooks"),
      env: { OPENCODE_CONFIG_DIR: opencodeConfigDir },
      runner: async (input) => result(input, "1.15.12\n"),
    });

    const doctorChecks = provider.doctorChecks;
    if (doctorChecks === undefined) throw new Error("OpenCode doctor checks are unavailable.");
    await expect(
      doctorChecks({
        providerHookRuntime: {
          ingressLauncher: join(root, "requester", "bin", "stn-ingress"),
          observerSocketPath: requesterObserverSocketPath,
          stateDir: requesterStateDir,
          hookSpoolDir: requesterHookSpoolDir,
          autoStartFromHooks: false,
          stationConfigPath: join(root, "requester", "config.toml"),
        },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "opencode-plugin",
          status: "ok",
        }),
      ]),
    );
  });

  it("classifies and ingests OpenCode observations through provider-local parsing", async () => {
    const provider = createOpenCodeHarnessProvider({ now: () => new Date(now) });

    await expect(
      provider.classifyRun(run(), {
        projects: [],
        worktrees: [],
        terminalTargets: [],
      }),
    ).resolves.toMatchObject({
      status: {
        value: "unknown",
        confidence: "low",
      },
    });

    await expect(provider.ingestEvent?.(event(), eventContext())).resolves.toEqual([
      expect.objectContaining({
        provider: "opencode",
        worktreeId: "wt_web_task",
        rawEventType: "session.status",
        nativeSessionId: "opencode_session_123",
        status: expect.objectContaining({
          value: "working",
        }),
      }),
    ]);
  });
});

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
    throw new Error("OpenCode provider fixture is missing a terminal target.");
  }
  return {
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "opencode",
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
    initialPrompt: "Do not send this automatically.",
  };
}

function run(): HarnessRunObservation {
  return {
    id: "opencode:tmux:station:@1:%2",
    provider: "opencode",
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    state: "unknown",
    confidence: "low",
    reason: "terminal target is bound to OpenCode; no reliable lifecycle signal yet.",
    observedAt: now,
  };
}

function event(): RawHarnessEvent {
  return {
    provider: "opencode",
    observedAt: now,
    event: {
      id: "evt_1",
      type: "session.status",
      properties: {
        sessionID: "opencode_session_123",
        status: {
          type: "busy",
        },
      },
      cwd: "/tmp/station/web/task",
    },
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
          harnessProvider: "opencode",
          currentCommand: "opencode",
        },
      },
    ],
  };
}
