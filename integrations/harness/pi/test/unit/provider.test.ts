import type { BuildHarnessLaunchRequest, HarnessRunObservation } from "@station/contracts";
import {
  type ExternalCommandInput,
  type ExternalCommandResult,
  safeErrorFromUnknown,
} from "@station/runtime";
import { describe, expect, it, vi } from "vitest";
import { createPiHarnessProvider } from "../../src/provider";

const now = "2026-05-27T12:00:00.000Z";

describe("PiHarnessProvider", () => {
  it("declares interactive Pi v1 capabilities", () => {
    const provider = createPiHarnessProvider();

    expect(provider.capabilities()).toEqual({
      canLaunch: true,
      canDiscoverRuns: true,
      canEmitEvents: true,
      canClassifyStatus: true,
      canReceivePrompt: false,
      canResume: false,
      canStop: false,
      canRunNonInteractive: false,
      canExposeApprovalState: false,
      supportsModifiedEnterSoftNewline: true,
    });
  });

  it("advertises resume only when configured", () => {
    expect(createPiHarnessProvider().capabilities().canResume).toBe(false);
    expect(createPiHarnessProvider({ resume: true }).capabilities().canResume).toBe(true);
  });

  it("checks pi --version for provider health without requiring auth", async () => {
    const calls: ExternalCommandInput[] = [];
    const provider = createPiHarnessProvider({
      command: "pi-test",
      now: () => new Date(now),
      runner: async (input) => {
        calls.push(input);
        return result(input, "pi 1.2.3\n");
      },
    });

    await expect(provider.health()).resolves.toMatchObject({
      providerId: "pi",
      providerType: "harness",
      status: "healthy",
      lastCheckedAt: now,
      diagnostics: {
        command: "pi --version succeeded",
        installedVersion: "1.2.3",
        minimumVersion: "0.80.5",
      },
    });
    expect(calls.map((call) => call.args)).toEqual([["--version"]]);
  });

  it.each([
    "0.80.4",
    "not-a-version",
  ])("rejects unsupported Pi version output %s", async (stdout) => {
    const provider = createPiHarnessProvider({
      command: "pi-test",
      now: () => new Date(now),
      runner: async (input) => result(input, `${stdout}\n`),
    });

    await expect(provider.health()).resolves.toMatchObject({
      providerId: "pi",
      providerType: "harness",
      status: "unavailable",
      lastError: {
        tag: "HarnessProviderError",
        code: "HARNESS_PI_VERSION_UNSUPPORTED",
        provider: "pi",
        hint: "Install Pi 0.80.5 or newer.",
      },
    });
  });

  it("falls back to STATION_PI_BIN when no command is configured", async () => {
    const previous = process.env.STATION_PI_BIN;
    process.env.STATION_PI_BIN = "pi-from-env";
    try {
      const provider = createPiHarnessProvider({ now: () => new Date(now) });

      await expect(provider.buildLaunch(request())).resolves.toMatchObject({
        command: "pi-from-env",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.STATION_PI_BIN;
      } else {
        process.env.STATION_PI_BIN = previous;
      }
    }
  });

  it("maps health failures to typed harness provider health", async () => {
    vi.stubEnv("PATH", "/observer/bin:/usr/bin");
    const provider = createPiHarnessProvider({
      command: "missing-pi",
      now: () => new Date(now),
      runner: async () => {
        throw Object.assign(new Error("not found"), {
          code: "ENOENT",
          stderr: "missing-pi: command not found",
        });
      },
    });

    const health = await provider.health();
    expect(health).toMatchObject({
      providerId: "pi",
      providerType: "harness",
      status: "unavailable",
      lastError: {
        tag: "HarnessProviderError",
        code: "HARNESS_PI_UNAVAILABLE",
        provider: "pi",
      },
    });
    if (health.lastError === undefined) throw new Error("expected Pi health failure");
    expect(
      safeErrorFromUnknown(health.lastError, {
        tag: "HarnessProviderError",
        code: "HARNESS_PI_UNAVAILABLE",
        message: "Pi is not available.",
      }).diagnosticDetails,
    ).toEqual([expect.objectContaining({ pathEnv: "/observer/bin:/usr/bin" })]);
  });

  it("applies provider launch defaults and discovers terminal-bound runs", async () => {
    const provider = createPiHarnessProvider({
      command: "pi-test",
      extensionPath: "/tmp/station/piExtension.js",
      configPath: "/tmp/station/config.toml",
      hookBin: "/tmp/station/bin/stn-ingress",
      now: () => new Date(now),
    });

    await expect(provider.buildLaunch(request())).resolves.toMatchObject({
      command: "pi-test",
      args: ["--extension", "/tmp/station/piExtension.js"],
      env: {
        STATION_CONFIG_PATH: "/tmp/station/config.toml",
        STATION_INGRESS_BIN: "/tmp/station/bin/stn-ingress",
      },
    });

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
              harnessProvider: "pi",
              currentCommand: "pi",
            },
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "pi:tmux:station:@1:%2",
        provider: "pi",
        worktreeId: "wt_web_task",
        state: "unknown",
        confidence: "low",
      }),
    ]);
  });

  it("classifies Pi observations without owning raw hook ingestion", async () => {
    const provider = createPiHarnessProvider({ now: () => new Date(now) });

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

    expect("ingestEvent" in provider).toBe(false);
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
    throw new Error("Pi provider fixture is missing a terminal target.");
  }
  return {
    project: {
      id: "web",
      label: "web",
      root: "/tmp/station/web",
      defaults: {
        harness: "pi",
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

function run(): HarnessRunObservation {
  return {
    id: "pi:tmux:station:@1:%2",
    provider: "pi",
    projectId: "web",
    worktreeId: "wt_web_task",
    sessionId: "ses_web_task",
    state: "unknown",
    confidence: "low",
    reason: "terminal target is bound to Pi; no reliable lifecycle signal yet.",
    observedAt: now,
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
          harnessProvider: "pi",
        },
      },
    ],
  };
}
