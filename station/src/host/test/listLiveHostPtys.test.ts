import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_PROTOCOL_VERSION,
  type StationHostConvergenceResult,
  type StationHostInspectionResult,
} from "@station/contracts";
import {
  StationHostProviderError,
  type HostListEntry,
} from "@station/host";
import { listLiveHostPtys } from "../listLiveHostPtys.js";

const EXPECTED_BUILD_VERSION = "build-current";
const EXPECTED_BUILD_IDENTITY = "b".repeat(64);
const INCUMBENT_BUILD_IDENTITY = "a".repeat(64);
type StationHostExactEvidence = Extract<
  StationHostInspectionResult,
  { status: "exact" }
>["evidence"];

function tempSocketPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "list-host-"));
  const path = join(dir, "station-host.sock");
  writeFileSync(path, "");
  return { dir, path };
}

function entry(): HostListEntry {
  return {
    kind: "agent",
    ptyId: "pty-1",
    ptyInstanceId: "instance-1",
    terminalTargetId: "native:worktree-1",
    worktreeId: "worktree-1",
    projectId: "project-1",
    sessionId: "session-1",
    worktreePath: "/work",
    harnessProvider: "codex",
    pid: 42,
    alive: true,
    cols: 80,
    rows: 24,
  };
}

function exactEvidence(
  socketPath: string,
  buildVersion = "build-old",
  buildIdentity = INCUMBENT_BUILD_IDENTITY,
  terminals: readonly HostListEntry[] = [entry()],
): StationHostExactEvidence {
  return {
    endpoint: { socketPath, ino: 11n, birthtimeNs: 22n },
    health: { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion },
    buildIdentity,
    terminals: terminals.map((terminal) => ({
      ...terminal,
      handoffSupport: { kind: "bridge-releasable" as const },
    })),
  };
}

function completed(
  action: "replace-idle" | "handoff",
  finalEvidence: StationHostExactEvidence,
): StationHostConvergenceResult {
  const common = {
    status: "completed" as const,
    action,
    targetBuild: {
      buildVersion: EXPECTED_BUILD_VERSION,
      buildIdentity: EXPECTED_BUILD_IDENTITY,
    },
    finalEvidence,
  };
  return action === "handoff"
    ? {
        ...common,
        action,
        handoffReceipt: {
          fidelity: "processes",
          terminals: finalEvidence.terminals.map(
            ({ terminalTargetId, ptyId, ptyInstanceId }) => ({
              terminalTargetId,
              ptyId,
              ptyInstanceId,
            }),
          ),
        },
      }
    : { ...common, action };
}

describe("listLiveHostPtys", () => {
  it("keeps boot cold when no socket path exists", async () => {
    let inspected = false;
    let converged = false;
    expect(
      await listLiveHostPtys("/no/such/station-host.sock", {
        env: { STATION_HOST_HANDOFF: "1" },
        inspectHost: async () => {
          inspected = true;
          return { status: "absent" };
        },
        convergeExactHost: async () => {
          converged = true;
          throw new Error("must not converge");
        },
      }),
    ).toBeUndefined();
    expect({ inspected, converged }).toEqual({ inspected: false, converged: false });
  });

  for (const gate of [undefined, "", "true", "0", "yes"]) {
    it(`preserves display-compatible host.list behavior when the gate is ${String(gate)}`, async () => {
      const { dir, path } = tempSocketPath();
      const entries = [entry()];
      let disposed = false;
      let inspected = false;
      try {
        const result = await listLiveHostPtys(path, {
          env: { STATION_HOST_HANDOFF: gate },
          expectedBuildVersion: EXPECTED_BUILD_VERSION,
          expectedBuildIdentity: EXPECTED_BUILD_IDENTITY,
          createClient: () => ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: EXPECTED_BUILD_VERSION,
            }),
            list: async () => entries,
            stopIfIdle: async () => ({ stopping: true }),
            dispose: () => (disposed = true),
          }),
          inspectHost: async () => {
            inspected = true;
            return { status: "absent" };
          },
        });
        expect(result).toBe(entries);
        expect(disposed).toBe(true);
        expect(inspected).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("stops an idle incompatible display build and keeps default boot cold", async () => {
    const { dir, path } = tempSocketPath();
    const stops: string[] = [];
    try {
      const result = await listLiveHostPtys(path, {
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        createClient: () => ({
          health: async () => ({
            ok: true,
            protocolVersion: HOST_PROTOCOL_VERSION,
            buildVersion: "build-old",
          }),
          list: async () => {
            throw new Error("must not list an incompatible host");
          },
          stopIfIdle: async (buildVersion) => {
            stops.push(buildVersion);
            return { stopping: true };
          },
          dispose: () => undefined,
        }),
      });
      expect(result).toBeUndefined();
      expect(stops).toEqual([EXPECTED_BUILD_VERSION]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves a default busy refusal without attempting exact convergence", async () => {
    const { dir, path } = tempSocketPath();
    const refusal = new StationHostProviderError("HOST_UPGRADE_BLOCKED", "live terminal");
    let converged = false;
    try {
      let caught: unknown;
      try {
        await listLiveHostPtys(path, {
          expectedBuildVersion: EXPECTED_BUILD_VERSION,
          createClient: () => ({
            health: async () => ({
              ok: true,
              protocolVersion: HOST_PROTOCOL_VERSION,
              buildVersion: "build-old",
            }),
            list: async () => [],
            stopIfIdle: async () => {
              throw refusal;
            },
            dispose: () => undefined,
          }),
          convergeExactHost: async () => {
            converged = true;
            throw new Error("must not converge");
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(refusal);
      expect(converged).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses only an exact pair under the gate without host.list", async () => {
    const { dir, path } = tempSocketPath();
    const exact = exactEvidence(
      path,
      EXPECTED_BUILD_VERSION,
      EXPECTED_BUILD_IDENTITY,
    );
    let listed = false;
    let converged = false;
    try {
      const result = await listLiveHostPtys(path, {
        env: { STATION_HOST_HANDOFF: "1" },
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        expectedBuildIdentity: EXPECTED_BUILD_IDENTITY,
        now: () => 1_000,
        createClient: () => {
          listed = true;
          throw new Error("must not create compatibility client");
        },
        inspectHost: async (options) => {
          expect(options.deadlineMs).toBe(6_000);
          return { status: "exact", evidence: exact };
        },
        convergeExactHost: async () => {
          converged = true;
          throw new Error("must not converge exact target");
        },
      });
      expect(result).toEqual([entry()]);
      expect({ listed, converged }).toEqual({ listed: false, converged: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converges same-display/different-identity idle ownership with replace-idle", async () => {
    const { dir, path } = tempSocketPath();
    const incumbent = exactEvidence(path, EXPECTED_BUILD_VERSION, INCUMBENT_BUILD_IDENTITY, []);
    const successor = exactEvidence(path, EXPECTED_BUILD_VERSION, EXPECTED_BUILD_IDENTITY, []);
    try {
      const result = await listLiveHostPtys(path, {
        env: { STATION_HOST_HANDOFF: "1" },
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        expectedBuildIdentity: EXPECTED_BUILD_IDENTITY,
        now: () => 1_000,
        inspectHost: async () => ({ status: "exact", evidence: incumbent }),
        convergeExactHost: async (command) => {
          expect(command).toEqual({
            action: "replace-idle",
            targetBuild: {
              buildVersion: EXPECTED_BUILD_VERSION,
              buildIdentity: EXPECTED_BUILD_IDENTITY,
            },
            socketPath: path,
            expected: incumbent,
            deadlineMs: 13_000,
          });
          return completed("replace-idle", successor);
        },
      });
      expect(result).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converges an eligible live registry and returns exact successor lifetimes", async () => {
    const { dir, path } = tempSocketPath();
    const incumbent = exactEvidence(path);
    const successor = exactEvidence(path, EXPECTED_BUILD_VERSION, EXPECTED_BUILD_IDENTITY);
    try {
      const result = await listLiveHostPtys(path, {
        env: { STATION_HOST_HANDOFF: "1" },
        expectedBuildVersion: EXPECTED_BUILD_VERSION,
        expectedBuildIdentity: EXPECTED_BUILD_IDENTITY,
        now: () => 1_000,
        inspectHost: async () => ({ status: "exact", evidence: incumbent }),
        convergeExactHost: async (command) => {
          expect(command).toMatchObject({
            action: "handoff",
            fidelity: "processes",
            expected: incumbent,
            deadlineMs: 13_000,
          });
          return completed("handoff", successor);
        },
      });
      expect(result).toEqual([entry()]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses ineligible or incomplete exact evidence without fallback", async () => {
    const { dir, path } = tempSocketPath();
    const ineligible = exactEvidence(path);
    ineligible.terminals[0]!.handoffSupport = {
      kind: "non-releasable",
      reason: "release-unsupported",
    };
    let converged = false;
    try {
      await expect(
        listLiveHostPtys(path, {
          env: { STATION_HOST_HANDOFF: "1" },
          expectedBuildVersion: EXPECTED_BUILD_VERSION,
          expectedBuildIdentity: EXPECTED_BUILD_IDENTITY,
          inspectHost: async () => ({ status: "exact", evidence: ineligible }),
          convergeExactHost: async () => {
            converged = true;
            throw new Error("must not converge");
          },
        }),
      ).rejects.toMatchObject({ code: "HOST_UPGRADE_BLOCKED" });
      expect(converged).toBe(false);

      const unavailable = new StationHostProviderError("HOST_UNREACHABLE", "incomplete");
      let caught: unknown;
      try {
        await listLiveHostPtys(path, {
          env: { STATION_HOST_HANDOFF: "1" },
          inspectHost: async () => ({ status: "unknown", reason: "inventory-failed", error: unavailable }),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(unavailable);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates canonical convergence failure without cold fallback", async () => {
    const { dir, path } = tempSocketPath();
    const incumbent = exactEvidence(path);
    const failure = new StationHostProviderError("HOST_TARGET_CONFLICT", "target drifted");
    try {
      let caught: unknown;
      try {
        await listLiveHostPtys(path, {
          env: { STATION_HOST_HANDOFF: "1" },
          expectedBuildVersion: EXPECTED_BUILD_VERSION,
          expectedBuildIdentity: EXPECTED_BUILD_IDENTITY,
          inspectHost: async () => ({ status: "exact", evidence: incumbent }),
          convergeExactHost: async () => ({
            status: "failed",
            action: "handoff",
            targetBuild: {
              buildVersion: EXPECTED_BUILD_VERSION,
              buildIdentity: EXPECTED_BUILD_IDENTITY,
            },
            phase: "target-validation",
            incumbentDisposition: "released",
            terminalDisposition: "parked",
            recoveryAuthority: "none",
            terminalRecovery: [{
              terminalTargetId: "native:worktree-1",
              ptyId: "pty-1",
              ptyInstanceId: "instance-1",
              lastProvenDisposition: "parked",
            }],
            error: failure,
          }),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
