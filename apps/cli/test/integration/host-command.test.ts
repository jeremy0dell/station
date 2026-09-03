import { runCli } from "@station/cli";
import { stationHostSocketPath } from "@station/config";
import { StationHostUpdateCrossoverResultSchema } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";

const targetBuild = "1.0.0+target";
const targetIdentity = "b".repeat(64);
const runningBuild = "0.9.0+incumbent";

describe("registered stn host command", () => {
  it("retains the strict update Host crossover process boundary", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const recoverHostOrphans = vi.fn(async () => ({ recoveredPtyIds: [] }));
    const result = await runCli(
      ["--config", configPath, "host", "handoff", "--update-crossover", "--fidelity", "processes"],
      {
        hostDeps: {
          expectedBuildVersion: targetBuild,
          expectedBuildIdentity: targetIdentity,
          inspectHost: async () => ({ status: "absent" }),
          recoverHostOrphans,
          resolveHostCommand: () => ["station-host"],
        },
      },
    );

    expect(result.code).toBe(0);
    expect(StationHostUpdateCrossoverResultSchema.parse(JSON.parse(String(result.output)))).toEqual(
      {
        schemaVersion: 1,
        status: "completed",
      },
    );
    expect(recoverHostOrphans).toHaveBeenCalledOnce();
  });

  it("preserves complete current status text and invokes no mutation dependency", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const socketPath = stationHostSocketPath(fixture.config);
    const convergeHost = vi.fn();
    const resolveHostCommand = vi.fn();
    const inspectHost = vi.fn(async () => ({
      status: "exact" as const,
      evidence: {
        endpoint: { socketPath, ino: 11n, birthtimeNs: 22n },
        health: { ok: true as const, protocolVersion: 8 as const, buildVersion: runningBuild },
        buildIdentity: "a".repeat(64),
        terminals: [
          {
            kind: "agent" as const,
            terminalTargetId: "target-a",
            ptyId: "pty-a",
            ptyInstanceId: "instance-a",
            worktreeId: "worktree-a",
            projectId: "project-a",
            sessionId: "session-a",
            worktreePath: "/private/repo",
            harnessProvider: "codex",
            pid: 42,
            alive: true,
            cols: 80,
            rows: 24,
            handoffSupport: { kind: "bridge-releasable" as const },
          },
        ],
      },
    }));

    const result = await runCli(["--config", configPath, "host", "status"], {
      hostDeps: {
        expectedBuildVersion: targetBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost,
        convergeHost,
        resolveHostCommand,
      },
    });

    expect(result).toEqual({
      code: 0,
      outputFormat: "text",
      output: [
        `socket: ${socketPath}`,
        "probe: listening",
        `health: ok protocol=8 build=${runningBuild}`,
        "compatibility: replace",
        "livePtys: 1",
        "handoffEligible: true",
        "",
      ].join("\n"),
    });
    expect(inspectHost).toHaveBeenCalledWith({ socketPath, expectedBuildVersion: targetBuild });
    expect(convergeHost).not.toHaveBeenCalled();
    expect(resolveHostCommand).not.toHaveBeenCalled();
    expect(String(result.output)).not.toContain("legacy");
  });

  it("returns 1 for nonexact listening evidence and 2 for boundary failures", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const unknown = await runCli(["--config", configPath, "host", "status"], {
      hostDeps: {
        expectedBuildVersion: targetBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => ({
          status: "unknown",
          reason: "health-failed",
          error: { tag: "HostError", code: "HOST_REQUEST_FAILED", message: "not exact" },
        }),
      },
    });
    expect(unknown).toMatchObject({ code: 1, output: expect.stringContaining("error: not exact") });

    const syntax = await runCli(["--config", configPath, "host", "status", "--bad"]);
    expect(syntax).toMatchObject({ code: 2, outputFormat: "text" });

    const unexpected = await runCli(["--config", configPath, "host", "status"], {
      hostDeps: {
        expectedBuildVersion: targetBuild,
        expectedBuildIdentity: targetIdentity,
        inspectHost: async () => Promise.reject("raw failure"),
      },
    });
    expect(unexpected).toMatchObject({ code: 2, output: "Host command failed.\n" });
  });
});
