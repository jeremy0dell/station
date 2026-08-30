import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  HarnessEventObservation,
  ObserverRecoveryAssessment,
  SessionRecoveryHandle,
} from "@station/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRecoveryFailure,
  createRealIngressWitness,
  type IngressAttempt,
  type ProviderSessionStartWitness,
  type RealRecoveryProjection,
  readRealRecoveryProjection,
  recoveryAuthorityFromEvidence,
} from "../../../../tests/support/real-station/recovery.js";

const identity = {
  provider: "codex",
  projectId: "project-1",
  worktreeId: "worktree-1",
  sessionId: "session-1",
  worktreePath: "/repo/worktree",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real Station recovery support", () => {
  it("creates attempt-scoped ingress wrappers and reads only strict witness records", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-recovery-witness-"));
    roots.push(root);
    const witness = await createRealIngressWitness({
      rootPath: root,
      env: {
        repoRoot: "/station",
        stationBin: "/station/bin/stn",
        stationIngressBin: "/station/bin/stn-ingress",
      },
    });
    const record = attempt(0);
    await writeFile(join(witness.attemptsPath, "attempt.json"), JSON.stringify(record), "utf8");

    await expect(witness.readAttempts()).resolves.toEqual([record]);
    await expect(readFile(witness.env.stationIngressBin, "utf8")).resolves.toContain(
      'spawnSync("/station/bin/stn-ingress"',
    );
    await expect(readFile(witness.env.stationBin, "utf8")).resolves.toContain(
      "providerHookIngressLauncher",
    );

    await writeFile(
      join(witness.attemptsPath, "invalid.json"),
      JSON.stringify({ ...record, unexpected: true }),
      "utf8",
    );
    await expect(witness.readAttempts()).rejects.toThrow();
  });

  it("reads strict test-only SQLite projections for observation, binding, and handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-recovery-projection-"));
    roots.push(root);
    const database = new DatabaseSync(join(root, "observer.sqlite"));
    const witness = nativeWitness();
    const admitted = observation(witness);
    database.exec(`
      CREATE TABLE provider_observations (
        id TEXT, provider TEXT, entity_kind TEXT, payload_json TEXT, observed_at TEXT
      );
      CREATE TABLE session_harness_executions (
        provider TEXT, session_id TEXT, native_session_id TEXT, state TEXT, status_updated_at TEXT
      );
      CREATE TABLE session_recovery_handles (
        id TEXT, provider TEXT, project_id TEXT, worktree_id TEXT, session_id TEXT,
        target_kind TEXT, target_value TEXT, cwd TEXT, terminal_target_id TEXT,
        harness_run_id TEXT, observed_at TEXT, last_seen_at TEXT
      );
    `);
    database
      .prepare("INSERT INTO provider_observations VALUES (?, ?, ?, ?, ?)")
      .run(
        admitted.id,
        admitted.provider,
        "harness_event",
        JSON.stringify(admitted.observation),
        admitted.observedAt,
      );
    database
      .prepare("INSERT INTO session_harness_executions VALUES (?, ?, ?, ?, ?)")
      .run("codex", identity.sessionId, "native-1", "working", admitted.observedAt);
    database
      .prepare("INSERT INTO session_recovery_handles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "recovery-1",
        "codex",
        identity.projectId,
        identity.worktreeId,
        identity.sessionId,
        "native-session",
        "native-1",
        identity.worktreePath,
        null,
        null,
        admitted.observedAt,
        admitted.observedAt,
      );
    database.close();

    expect(readRealRecoveryProjection(root)).toEqual(projectionFor(witness));
  });

  it.each([
    { expected: "no-hook-execution", attempts: [] },
    { expected: "hook-command-failure", attempts: [attempt(1)] },
  ] as const)("classifies $expected", ({ attempts, expected }) => {
    expect(classifyRecoveryFailure({ attempts, identity })).toBe(expected);
  });

  it("classifies every post-hook authority phase", () => {
    const witness = nativeWitness();
    const admitted = observation(witness);
    const projection = projectionFor(witness);
    expect(classifyRecoveryFailure({ attempts: [witness.attempt], witness, identity })).toBe(
      "rejected-or-spooled-ingress",
    );
    expect(
      classifyRecoveryFailure({
        attempts: [witness.attempt],
        witness,
        identity,
        projection: { observations: [admitted], executions: [], handles: [] },
      }),
    ).toBe("missing-binding");
    expect(
      classifyRecoveryFailure({
        attempts: [witness.attempt],
        witness,
        identity,
        projection: { ...projection, handles: [] },
      }),
    ).toBe("missing-or-mismatched-handle");
    expect(
      classifyRecoveryFailure({
        attempts: [witness.attempt],
        witness,
        identity,
        projection,
        postLoss: true,
      }),
    ).toBe("post-loss-projection-failure");
  });

  it("requires exact native execution, handle, and selected assessment agreement", () => {
    const witness = nativeWitness();
    const projection = projectionFor(witness);
    const assessment = recoveryAssessment(projection.handles[0] as SessionRecoveryHandle);
    expect(recoveryAuthorityFromEvidence({ identity, witness, projection, assessment })).toEqual(
      expect.objectContaining({
        execution: expect.objectContaining({ nativeSessionId: "native-1" }),
        handle: expect.objectContaining({ id: "recovery-1" }),
      }),
    );

    const exactExecution = projection.executions[0];
    if (exactExecution === undefined) throw new Error("Expected native execution fixture.");
    const mismatchedExecution: RealRecoveryProjection = {
      ...projection,
      executions: [{ ...exactExecution, nativeSessionId: "native-other" }],
    };
    expect(
      recoveryAuthorityFromEvidence({
        identity,
        witness,
        projection: mismatchedExecution,
        assessment,
      }),
    ).toBeUndefined();

    const wrongSelection = structuredClone(assessment);
    const session = wrongSelection.sessions[0];
    if (session === undefined) throw new Error("Expected recovery assessment fixture.");
    session.handleResolution = {
      kind: "selected",
      selectedHandleId: "recovery-other",
      eligibleHandleCount: 1,
      rejectedHandleCount: 0,
      rejectedReasons: [],
    };
    expect(
      recoveryAuthorityFromEvidence({
        identity,
        witness,
        projection,
        assessment: wrongSelection,
      }),
    ).toBeUndefined();
  });

  it("proves Pi session-file authority from admitted normalized evidence without a native binding", () => {
    const piIdentity = { ...identity, provider: "pi" };
    const witness: ProviderSessionStartWitness = {
      provider: "pi",
      target: { kind: "session-file", path: "/repo/worktree/.pi/session.jsonl" },
      cwd: identity.worktreePath,
      attempt: attempt(0),
    };
    const projection = projectionFor(witness, piIdentity);
    const assessment = recoveryAssessment(
      projection.handles[0] as SessionRecoveryHandle,
      piIdentity,
    );
    const authority = recoveryAuthorityFromEvidence({
      identity: piIdentity,
      witness,
      projection,
      assessment,
    });
    expect(authority).toBeDefined();
    expect(authority).not.toHaveProperty("execution");

    projection.executions.push({
      provider: "pi",
      sessionId: identity.sessionId,
      nativeSessionId: witness.target.path,
      state: "working",
      statusUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      recoveryAuthorityFromEvidence({
        identity: piIdentity,
        witness,
        projection,
        assessment,
      }),
    ).toBeUndefined();
  });
});

function attempt(exitStatus: number): IngressAttempt {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    invokedAt: "2026-01-01T00:00:00.000Z",
    argv: ["--provider", "codex"],
    rawInput: "{}",
    exitStatus,
    signal: null,
    stdout: "",
    stderr: "",
  };
}

function nativeWitness(): ProviderSessionStartWitness {
  return {
    provider: "codex",
    target: { kind: "native-session", id: "native-1" },
    cwd: identity.worktreePath,
    attempt: attempt(0),
  };
}

function observation(
  witness: ProviderSessionStartWitness,
  exactIdentity = identity,
): RealRecoveryProjection["observations"][number] {
  const value: HarnessEventObservation = {
    provider: witness.provider,
    eventType: "SessionStart",
    projectId: exactIdentity.projectId,
    worktreeId: exactIdentity.worktreeId,
    sessionId: exactIdentity.sessionId,
    cwd: exactIdentity.worktreePath,
    observedAt: "2026-01-01T00:00:00.100Z",
  };
  if (witness.target.kind === "native-session") value.nativeSessionId = witness.target.id;
  else value.nativeSessionFile = witness.target.path;
  return {
    id: "observation-1",
    provider: witness.provider,
    observedAt: value.observedAt,
    observation: value,
  };
}

function projectionFor(
  witness: ProviderSessionStartWitness,
  exactIdentity = identity,
): RealRecoveryProjection {
  const handle: SessionRecoveryHandle = {
    id: "recovery-1",
    provider: witness.provider,
    projectId: exactIdentity.projectId,
    worktreeId: exactIdentity.worktreeId,
    sessionId: exactIdentity.sessionId,
    target: witness.target,
    cwd: exactIdentity.worktreePath,
    observedAt: "2026-01-01T00:00:00.100Z",
    lastSeenAt: "2026-01-01T00:00:00.100Z",
  };
  return {
    observations: [observation(witness, exactIdentity)],
    executions:
      witness.target.kind === "native-session"
        ? [
            {
              provider: witness.provider,
              sessionId: exactIdentity.sessionId,
              nativeSessionId: witness.target.id,
              state: "working",
              statusUpdatedAt: "2026-01-01T00:00:00.100Z",
            },
          ]
        : [],
    handles: [handle],
  };
}

function recoveryAssessment(
  handle: SessionRecoveryHandle,
  exactIdentity = identity,
): ObserverRecoveryAssessment {
  return {
    schemaVersion: 1,
    inventory: {
      schemaVersion: 1,
      sessions: [
        {
          id: exactIdentity.sessionId,
          projectId: exactIdentity.projectId,
          worktreeId: exactIdentity.worktreeId,
          lifecycle: "open",
          harnessProvider: exactIdentity.provider,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.100Z",
        },
      ],
      recoveryHandles: [
        {
          id: handle.id,
          provider: handle.provider,
          projectId: handle.projectId,
          worktreeId: handle.worktreeId,
          sessionId: exactIdentity.sessionId,
          targetKind: handle.target.kind,
          observedAt: handle.observedAt,
          lastSeenAt: handle.lastSeenAt,
        },
      ],
    },
    resumeEnabled: true,
    providerCapabilities: [{ provider: exactIdentity.provider, status: "enabled" }],
    sessions: [
      {
        sessionId: exactIdentity.sessionId,
        projectId: exactIdentity.projectId,
        worktreeId: exactIdentity.worktreeId,
        lifecycle: "open",
        harnessProvider: exactIdentity.provider,
        disposition: "recoverable",
        reasons: [],
        handleResolution: {
          kind: "selected",
          selectedHandleId: handle.id,
          eligibleHandleCount: 1,
          rejectedHandleCount: 0,
          rejectedReasons: [],
        },
      },
    ],
  };
}
