import type { StationSnapshot, WorktreeObservation } from "@station/contracts";
import { StationSnapshotSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  projectCreatedWorktreeOntoSnapshot,
  projectPreparedExternalLaunchOntoSnapshot,
} from "../../../src/reconcile/graph/authoritativeLaunch";
import { build, preparedProjectionFixture, projectedAt, projects, worktree } from "./fixtures";

describe("authoritative graph projections", () => {
  it("applies and then recognizes an exact created worktree", () => {
    const created = worktree("wt_web_created", "web", "created");
    created.registrationIdentity = "registration:created";
    const snapshot = build({});
    const applied = projectCreatedWorktreeOntoSnapshot({
      snapshot,
      project: projects[0],
      worktreeProviderId: "fake-worktree",
      worktree: created,
      projectedAt,
    });

    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("expected applied projection");
    expect(applied.snapshot).toMatchObject({
      generatedAt: projectedAt,
      counts: { worktrees: 1 },
      rows: [
        {
          id: created.id,
          branch: created.branch,
          path: created.path,
          registrationIdentity: created.registrationIdentity,
          worktree: { state: "exists", source: "worktrunk" },
        },
      ],
    });
    expect(applied.snapshot.projects.find((project) => project.id === "web")).toMatchObject({
      counts: { worktrees: 1 },
    });
    expect(StationSnapshotSchema.parse(applied.snapshot)).toEqual(applied.snapshot);

    const exact = projectCreatedWorktreeOntoSnapshot({
      snapshot: applied.snapshot,
      project: projects[0],
      worktreeProviderId: "fake-worktree",
      worktree: created,
      projectedAt: "2026-05-20T12:00:02.000Z",
    });
    expect(exact).toMatchObject({ status: "already-exact", snapshot: applied.snapshot });
  });

  it.each([
    ["project_not_configured", (_created: WorktreeObservation) => ({ project: undefined })],
    [
      "project_not_in_snapshot",
      (_created: WorktreeObservation) => {
        const snapshot = build({});
        return {
          snapshot: {
            ...snapshot,
            projects: snapshot.projects.filter((project) => project.id !== "web"),
          },
        };
      },
    ],
    [
      "provider_mismatch",
      (created: WorktreeObservation) => ({ worktree: { ...created, provider: "other" } }),
    ],
    [
      "project_mismatch",
      (created: WorktreeObservation) => ({ worktree: { ...created, projectId: "api" } }),
    ],
    [
      "worktree_not_present",
      (created: WorktreeObservation) => ({ worktree: { ...created, state: "missing" as const } }),
    ],
  ])("rejects created worktree evidence with %s", (reason, mutate) => {
    const created = worktree("wt_web_created", "web", "created");
    const result = projectCreatedWorktreeOntoSnapshot({
      snapshot: build({}),
      project: projects[0],
      worktreeProviderId: "fake-worktree",
      worktree: created,
      projectedAt,
      ...mutate(created),
    });
    expect(result).toMatchObject({ status: "rejected", reason });
  });

  it.each([
    ["worktree_id_collision", { id: "wt_web_existing" }],
    ["worktree_path_collision", { path: "/tmp/station/web/existing" }],
    ["worktree_branch_collision", { branch: "existing" }],
    ["worktree_registration_collision", { registrationIdentity: "registration:existing" }],
  ])("rejects a created worktree %s", (reason, overrides) => {
    const existing = worktree("wt_web_existing", "web", "existing");
    existing.registrationIdentity = "registration:existing";
    const created = worktree("wt_web_created", "web", "created");
    created.registrationIdentity = "registration:created";
    Object.assign(created, overrides);
    if (reason === "worktree_id_collision") {
      created.source = "station";
    }
    const result = projectCreatedWorktreeOntoSnapshot({
      snapshot: build({ worktrees: [existing] }),
      project: projects[0],
      worktreeProviderId: "fake-worktree",
      worktree: created,
      projectedAt,
    });
    expect(result).toMatchObject({ status: "rejected", reason });
  });

  it("treats registration identity as global while branch identity remains project-local", () => {
    const apiWorktree = worktree("wt_api_existing", "api", "shared");
    apiWorktree.registrationIdentity = "registration:shared";
    const webWorktree = worktree("wt_web_created", "web", "shared");
    webWorktree.registrationIdentity = "registration:web";
    const snapshot = build({ worktrees: [apiWorktree] });

    const differentRegistration = projectCreatedWorktreeOntoSnapshot({
      snapshot,
      project: projects[0],
      worktreeProviderId: "fake-worktree",
      worktree: webWorktree,
      projectedAt,
    });
    expect(differentRegistration.status).toBe("applied");

    const collidingRegistration = projectCreatedWorktreeOntoSnapshot({
      snapshot,
      project: projects[0],
      worktreeProviderId: "fake-worktree",
      worktree: { ...webWorktree, registrationIdentity: apiWorktree.registrationIdentity },
      projectedAt,
    });
    expect(collidingRegistration).toMatchObject({
      status: "rejected",
      reason: "worktree_registration_collision",
    });
  });

  it("projects a coherent prepared session, Group, ordering, timestamps, and counts", () => {
    const fixture = preparedProjectionFixture();
    const result = projectPreparedExternalLaunchOntoSnapshot(fixture.input);

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected applied projection");
    expect(result.value).toMatchObject({ created: true });
    expect(result.snapshot).toMatchObject({
      generatedAt: projectedAt,
      counts: { worktrees: 1, sessions: 1, agents: 1, unknown: 1 },
      rows: [
        {
          id: fixture.observed.id,
          title: "Projected launch",
          terminal: { provider: "managed-test", state: "open", hasWorkspace: true },
          agent: {
            harness: "fake-harness",
            sessionId: fixture.session.id,
            runId: "fake-harness:managed://wt_web_projected",
            state: "unknown",
          },
        },
      ],
      sessions: [
        {
          id: fixture.session.id,
          title: "Projected launch",
          harness: { provider: "fake-harness", runId: "fake-harness:managed://wt_web_projected" },
          status: { value: "unknown" },
          terminal: { provider: "managed-test", state: "open" },
        },
      ],
      sessionGroups: [{ id: fixture.group.id, sessionIds: [fixture.session.id] }],
    });
    expect(result.snapshot.projects.find((project) => project.id === "web")).toMatchObject({
      counts: { worktrees: 1, sessions: 1, agents: 1, unknown: 1 },
    });
    expect(StationSnapshotSchema.parse(result.snapshot)).toEqual(result.snapshot);

    const exact = projectPreparedExternalLaunchOntoSnapshot({
      ...fixture.input,
      snapshot: result.snapshot,
      projectedAt: "2026-05-20T12:00:02.000Z",
    });
    expect(exact.status).toBe("already-exact");
  });

  it.each([
    [
      "project_not_configured",
      (_fixture: ReturnType<typeof preparedProjectionFixture>) => ({ project: undefined }),
    ],
    [
      "project_not_in_snapshot",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        snapshot: { ...fixture.snapshot, projects: [] },
      }),
    ],
    [
      "worktree_missing",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        worktree: { ...fixture.observed, id: "wt_web_missing" },
      }),
    ],
    [
      "worktree_provider_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        worktree: { ...fixture.observed, provider: "other" },
      }),
    ],
    [
      "worktree_identity_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        worktree: { ...fixture.observed, path: `${fixture.observed.path}/other` },
      }),
    ],
    [
      "session_not_open",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        session: { ...fixture.session, lifecycle: "ended" as const, endedAt: projectedAt },
      }),
    ],
    [
      "session_not_open",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        session: { ...fixture.session, endedAt: projectedAt },
      }),
    ],
    [
      "session_identity_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        session: { ...fixture.session, worktreeId: "wt_other" },
      }),
    ],
    [
      "session_identity_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        session: { ...fixture.session, projectId: "api" },
      }),
    ],
    [
      "session_harness_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        session: { ...fixture.session, harness: "other" },
      }),
    ],
    [
      "session_terminal_provider_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        session: { ...fixture.session, terminalProvider: "other" },
      }),
    ],
    [
      "terminal_provider_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: { ...fixture.target, provider: "other" },
      }),
    ],
    [
      "terminal_target_mismatch",
      (_fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTargetId: "managed://other",
      }),
    ],
    [
      "terminal_project_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: { ...fixture.target, projectId: "api" },
      }),
    ],
    [
      "terminal_worktree_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: { ...fixture.target, worktreeId: "wt_other" },
      }),
    ],
    [
      "terminal_session_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: { ...fixture.target, sessionId: "ses_other" },
      }),
    ],
    [
      "terminal_not_open",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: { ...fixture.target, state: "detached" as const },
      }),
    ],
    [
      "terminal_path_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: { ...fixture.target, cwd: "/tmp/other" },
      }),
    ],
    [
      "terminal_harness_binding_missing",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => {
        const terminalTarget = { ...fixture.target };
        delete terminalTarget.harnessBinding;
        return { terminalTarget };
      },
    ],
    [
      "terminal_harness_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: {
          ...fixture.target,
          harnessBinding: { ...fixture.target.harnessBinding, harnessProvider: "other" },
        },
      }),
    ],
    [
      "terminal_harness_role_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: {
          ...fixture.target,
          harnessBinding: { ...fixture.target.harnessBinding, role: "shell" },
        },
      }),
    ],
    [
      "terminal_harness_path_mismatch",
      (fixture: ReturnType<typeof preparedProjectionFixture>) => ({
        terminalTarget: {
          ...fixture.target,
          harnessBinding: { ...fixture.target.harnessBinding, worktreePath: "/tmp/other" },
        },
      }),
    ],
    ["harness_not_registered", () => ({ harnessCapabilities: {} })],
  ])("rejects prepared launch evidence with %s", (reason, mutate) => {
    const fixture = preparedProjectionFixture();
    const result = projectPreparedExternalLaunchOntoSnapshot({
      ...fixture.input,
      ...mutate(fixture),
    });
    expect(result).toMatchObject({ status: "rejected", reason });
  });

  it("rejects conflicting sessions and terminal evidence older than the committed snapshot", () => {
    const fixture = preparedProjectionFixture();
    const projected = projectPreparedExternalLaunchOntoSnapshot(fixture.input);
    if (projected.status !== "applied") throw new Error("expected applied projection");
    const otherSession = { ...projected.value.session, id: "ses_other" };
    const conflict = projectPreparedExternalLaunchOntoSnapshot({
      ...fixture.input,
      snapshot: { ...fixture.snapshot, sessions: [otherSession] },
    });
    expect(conflict).toMatchObject({ status: "rejected", reason: "session_conflict" });

    const newerTerminal = {
      ...fixture.snapshot,
      rows: fixture.snapshot.rows.map((row) => ({
        ...row,
        terminal: {
          provider: "managed-test",
          state: "open" as const,
          observedAt: "2026-05-20T12:00:02.000Z",
        },
      })),
    };
    const stale = projectPreparedExternalLaunchOntoSnapshot({
      ...fixture.input,
      snapshot: newerTerminal,
    });
    expect(stale).toMatchObject({ status: "rejected", reason: "terminal_evidence_older" });
  });

  it.each([
    [
      "session_identity_mismatch",
      (_fixture: ReturnType<typeof preparedProjectionFixture>, snapshot: StationSnapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          createdAt: "2026-05-20T11:59:00.000Z",
        })),
      }),
    ],
    [
      "session_harness_mismatch",
      (_fixture: ReturnType<typeof preparedProjectionFixture>, snapshot: StationSnapshot) => ({
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          harness: { ...session.harness, provider: "other" },
        })),
      }),
    ],
    [
      "agent_session_conflict",
      (_fixture: ReturnType<typeof preparedProjectionFixture>, snapshot: StationSnapshot) => ({
        ...snapshot,
        rows: snapshot.rows.map((row) => ({
          ...row,
          agent: row.agent === undefined ? undefined : { ...row.agent, sessionId: "ses_other" },
        })),
      }),
    ],
    [
      "agent_harness_conflict",
      (_fixture: ReturnType<typeof preparedProjectionFixture>, snapshot: StationSnapshot) => ({
        ...snapshot,
        rows: snapshot.rows.map((row) => ({
          ...row,
          agent: row.agent === undefined ? undefined : { ...row.agent, harness: "other" },
        })),
      }),
    ],
  ])("rejects committed launch conflicts with %s", (reason, mutate) => {
    const fixture = preparedProjectionFixture();
    const projected = projectPreparedExternalLaunchOntoSnapshot(fixture.input);
    if (projected.status !== "applied") throw new Error("expected applied projection");
    const result = projectPreparedExternalLaunchOntoSnapshot({
      ...fixture.input,
      snapshot: mutate(fixture, projected.snapshot),
    });
    expect(result).toMatchObject({ status: "rejected", reason });
  });

  it("preserves newer status already committed for the same projected session", () => {
    const fixture = preparedProjectionFixture();
    const projected = projectPreparedExternalLaunchOntoSnapshot(fixture.input);
    if (projected.status !== "applied") throw new Error("expected applied projection");
    const newerAt = "2026-05-20T12:00:03.000Z";
    const newerStatus = {
      value: "working" as const,
      confidence: "high" as const,
      reason: "Immediate harness evidence.",
      source: "harness_event" as const,
      updatedAt: newerAt,
    };
    const snapshot = {
      ...projected.snapshot,
      rows: projected.snapshot.rows.map((row) => ({
        ...row,
        agent:
          row.agent === undefined
            ? undefined
            : {
                ...row.agent,
                state: "working" as const,
                confidence: "high" as const,
                reason: newerStatus.reason,
                updatedAt: newerAt,
              },
        display: { statusLabel: "working" as const, sortPriority: 20, alert: false },
      })),
      sessions: projected.snapshot.sessions.map((session) => ({
        ...session,
        updatedAt: newerAt,
        status: newerStatus,
      })),
    };
    const result = projectPreparedExternalLaunchOntoSnapshot({
      ...fixture.input,
      snapshot,
    });
    expect(result.status).toBe("already-exact");
    if (result.status === "rejected") throw new Error("expected accepted projection");
    expect(result.value.row.agent?.state).toBe("working");
    expect(result.value.session.status).toEqual(newerStatus);
  });
});
