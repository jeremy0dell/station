import type { UpdateReapRecoveryPreflight } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { updateConvergenceDigest } from "../../src/update/convergenceDigest.js";
import { planUpdateConvergence } from "../../src/update/convergencePlan.js";
import type { UpdateConvergencePrivateEvidence } from "../../src/update/recoveryPreflight.js";

const identity = "a".repeat(64);
const artifact = { version: "1.0.0", revision: "revision-1" };

describe("update convergence digest", () => {
  it("changes when the exact selected Station recovery handle changes", () => {
    const first = digest({
      selectedRecoveryHandles: [{ sessionId: "session-1", selectedHandleId: "station-handle-a" }],
    });
    const second = digest({
      selectedRecoveryHandles: [{ sessionId: "session-1", selectedHandleId: "station-handle-b" }],
    });
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toContain("station-handle-a");
  });

  it("binds the exact Observer ownership tuple and public terminal inventory", () => {
    const base: UpdateConvergencePrivateEvidence = {
      observer: {
        pid: 42,
        osStartTime: "os-start-1",
        processToken: "11111111-1111-4111-8111-111111111111",
        buildSelector: `1.0.0+station.${identity}`,
      },
      selectedRecoveryHandles: [],
    };
    const observer = base.observer;
    if (observer === undefined) throw new Error("missing Observer digest fixture");
    expect(digest(base)).not.toBe(
      digest({
        ...base,
        observer: { ...observer, processToken: "22222222-2222-4222-8222-222222222222" },
      }),
    );
    expect(digest(base)).not.toBe(digest(base, preflightWithTerminal("pty-instance-2")));
  });

  it("is stable across display-only SafeError message changes", () => {
    const first = unknownObserverPreflight("first private path /tmp/a");
    const second = unknownObserverPreflight("second private path /tmp/b");
    expect(digest({ selectedRecoveryHandles: [] }, first)).toBe(
      digest({ selectedRecoveryHandles: [] }, second),
    );
  });

  it("rejects the ill-formed UTF-16 inputs that collide under UTF-8 replacement", () => {
    expect(Buffer.from("\ud800", "utf8")).toEqual(Buffer.from("\ufffd", "utf8"));
    expect(() =>
      digest({
        selectedRecoveryHandles: [
          { sessionId: "session-1", selectedHandleId: "station-handle-\ud800" },
        ],
      }),
    ).toThrow("Update convergence digest facts must use well-formed Unicode.");
    expect(() =>
      digest({
        selectedRecoveryHandles: [
          { sessionId: "session-\udfff", selectedHandleId: "station-handle" },
        ],
      }),
    ).toThrow("Update convergence digest facts must use well-formed Unicode.");
    expect(
      digest({
        selectedRecoveryHandles: [
          { sessionId: "session-1", selectedHandleId: "station-handle-\ufffd" },
        ],
      }),
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps astral Unicode canonicalization stable", () => {
    const astral = digest({
      selectedRecoveryHandles: [
        { sessionId: "session-\ud83d\ude89", selectedHandleId: "station-handle-\ud83d\ude80" },
      ],
    });
    expect(astral).toBe("52cdd5e85c814b6a790ddf94129048fac59d1ad31cdfa9ea0909d5cb65478f17");
  });
});

function digest(
  privateEvidence: UpdateConvergencePrivateEvidence,
  preflight: UpdateReapRecoveryPreflight = basePreflight(),
): string {
  const draft = planUpdateConvergence({
    selectedTarget: { artifact, buildIdentity: { status: "known", value: identity } },
    artifactAction: "no-op",
    handoffFidelity: "processes",
    preflight,
  });
  return updateConvergenceDigest({ draft, preflight, privateEvidence }).value;
}

function basePreflight(): UpdateReapRecoveryPreflight {
  return {
    schemaVersion: 1,
    boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
    installed: artifact,
    target: artifact,
    observer: { status: "absent" },
    host: { status: "absent" },
    hookProviderIds: [],
    hooks: [],
    terminalDispositions: [],
    evidenceComplete: false,
  };
}

function preflightWithTerminal(ptyInstanceId: string): UpdateReapRecoveryPreflight {
  return {
    ...basePreflight(),
    host: {
      status: "inspected",
      buildVersion: artifact.version,
      buildIdentity: identity,
      protocolVersion: 8,
      relation: "matching-target",
      compatibility: "reuse",
      terminals: [
        {
          kind: "agent",
          terminalTargetId: "terminal-1",
          ptyId: "pty-1",
          ptyInstanceId,
          projectId: "project-1",
          worktreeId: "worktree-1",
          sessionId: "session-1",
          harnessProvider: "codex",
          alive: true,
          handoffSupport: "bridge-releasable",
        },
      ],
    },
    terminalDispositions: [
      {
        terminalTargetId: "terminal-1",
        ptyId: "pty-1",
        ptyInstanceId,
        sessionId: "session-1",
        handoff: "preservable",
        reapRecovery: "unknown",
        reasons: ["session_recovery_unknown"],
      },
    ],
  };
}

function unknownObserverPreflight(message: string): UpdateReapRecoveryPreflight {
  return {
    ...basePreflight(),
    observer: {
      status: "unknown",
      reason: "inspection-failed",
      error: { tag: "UpdatePreflightError", code: "SAME_CODE", message },
    },
  };
}
