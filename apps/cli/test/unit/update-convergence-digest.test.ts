import type { UpdateInstallMutation, UpdateReapRecoveryPreflight } from "@station/contracts";
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
        socketPath: "/tmp/station/observer.sock",
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

  it("changes when the same PTY lifetime is attributed to another Station session", () => {
    expect(
      digest({ selectedRecoveryHandles: [] }, preflightWithTerminal("pty-instance-1")),
    ).not.toBe(
      digest(
        { selectedRecoveryHandles: [] },
        preflightWithTerminal("pty-instance-1", "session-replacement"),
      ),
    );
  });

  it("binds Observer singleton replacement admission", () => {
    const privateEvidence: UpdateConvergencePrivateEvidence = {
      observer: {
        pid: 42,
        osStartTime: "os-start-1",
        processToken: "11111111-1111-4111-8111-111111111111",
        buildSelector: `0.9.0+station.${"b".repeat(64)}`,
        socketPath: "/tmp/station/observer.sock",
      },
      selectedRecoveryHandles: [],
    };

    expect(digest(privateEvidence, observerAdmissionPreflight("candidate-wins"))).not.toBe(
      digest(privateEvidence, observerAdmissionPreflight("incumbent-wins")),
    );
  });

  it("changes when identical live handoff evidence selects processes versus screen fidelity", () => {
    const evidence = handoffPreflight();
    const privateEvidence = { selectedRecoveryHandles: [] };
    const processes = digest(privateEvidence, evidence, "processes");
    const screen = digest(privateEvidence, evidence, "screen");

    expect(processes).not.toBe(screen);
    expect(planFor(evidence, "processes").components).toMatchObject({
      host: { action: "handoff", fidelity: "processes" },
      terminals: { action: "preserve-via-handoff", fidelity: "processes" },
    });
    expect(planFor(evidence, "screen").components).toMatchObject({
      host: { action: "handoff", fidelity: "screen" },
      terminals: { action: "preserve-via-handoff", fidelity: "screen" },
    });
  });

  it("binds the exact install owner, selected action, and manager argv", () => {
    const privateEvidence = { selectedRecoveryHandles: [] };
    const evidence = basePreflight();
    const installer = digest(privateEvidence, evidence, "processes", {
      owner: "installer-binary",
      action: "no-op",
    });
    const checkout = digest(privateEvidence, evidence, "processes", {
      owner: "dev-checkout",
      action: "no-op",
    });
    const brew = digest(privateEvidence, evidence, "processes", {
      owner: "homebrew",
      action: "no-op",
      managerCommand: ["brew", "upgrade", "station"],
    });
    const brewCask = digest(privateEvidence, evidence, "processes", {
      owner: "homebrew",
      action: "no-op",
      managerCommand: ["brew", "upgrade", "--cask", "station"],
    });

    expect(installer).not.toBe(checkout);
    expect(installer).not.toBe(brew);
    expect(brew).not.toBe(brewCask);
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
    expect(astral).toBe("c316a3fdcf7f731e1e8035dd41a03571449263314fcba650912fb90085f4c3da");
  });
});

function digest(
  privateEvidence: UpdateConvergencePrivateEvidence,
  preflight: UpdateReapRecoveryPreflight = basePreflight(),
  handoffFidelity: "processes" | "screen" = "processes",
  installation: UpdateInstallMutation = { owner: "installer-binary", action: "no-op" },
): string {
  const draft = planFor(preflight, handoffFidelity, installation);
  return updateConvergenceDigest({ draft, preflight, privateEvidence }).value;
}

function planFor(
  preflight: UpdateReapRecoveryPreflight,
  handoffFidelity: "processes" | "screen",
  installation: UpdateInstallMutation = { owner: "installer-binary", action: "no-op" },
) {
  return planUpdateConvergence({
    selectedTarget: { artifact, buildIdentity: { status: "known", value: identity } },
    installation,
    handoffFidelity,
    preflight,
  });
}

function basePreflight(): UpdateReapRecoveryPreflight {
  return {
    schemaVersion: 2,
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

function preflightWithTerminal(
  ptyInstanceId: string,
  sessionId = "session-1",
): UpdateReapRecoveryPreflight {
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
          sessionId,
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
        sessionId,
        handoff: "preservable",
        reapRecovery: "unknown",
        reasons: ["session_recovery_unknown"],
      },
    ],
  };
}

function observerAdmissionPreflight(
  replacementAdmission: "candidate-wins" | "incumbent-wins",
): UpdateReapRecoveryPreflight {
  return {
    ...basePreflight(),
    observer: {
      status: "exact",
      buildVersion: `0.9.0+station.${"b".repeat(64)}`,
      relation: "different",
      replacementAdmission,
      health: "healthy",
      recovery: {
        status: "assessed",
        assessment: {
          schemaVersion: 1,
          resumeEnabled: true,
          providerCapabilities: [],
          sessions: [],
        },
      },
    },
  };
}

function handoffPreflight(): UpdateReapRecoveryPreflight {
  const evidence = preflightWithTerminal("pty-instance-1");
  if (evidence.host.status !== "inspected") throw new Error("missing Host digest fixture");
  return {
    ...evidence,
    host: {
      ...evidence.host,
      buildVersion: "0.9.0",
      buildIdentity: "b".repeat(64),
      relation: "different",
      compatibility: "replace",
    },
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
