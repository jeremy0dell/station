import { isRunningAgentState } from "@station/contracts";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import {
  assertSessionCloseAllowed,
  assertWorktreeRemovalAllowed,
  buildStationSnapshot,
  resolveSessionOrThrow,
  resolveWorktreeRemovalTarget,
  resolveWorktreeRowOrThrow,
} from "../../src/internal";
import { observerHarnessRunFromRun } from "../../src/reconcile/harnessEventStatus";

const now = "2026-05-21T12:00:00.000Z";

describe("cleanup command validation", () => {
  it("classifies active and exited agent states for cleanup guards", () => {
    expect(isRunningAgentState("starting")).toBe(true);
    expect(isRunningAgentState("idle")).toBe(true);
    expect(isRunningAgentState("working")).toBe(true);
    expect(isRunningAgentState("needs_attention")).toBe(true);
    expect(isRunningAgentState("stuck")).toBe(true);
    expect(isRunningAgentState("unknown")).toBe(true);
    expect(isRunningAgentState("exited")).toBe(false);
    expect(isRunningAgentState("none")).toBe(false);
    expect(isRunningAgentState(undefined)).toBe(false);
  });

  it("rejects dirty worktree removal unless force is explicit", () => {
    const snapshot = snapshotFor({ dirty: true, state: "none" });
    const row = snapshot.rows[0];

    expect(() => assertWorktreeRemovalAllowed(row, false)).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "WORKTREE_DIRTY_REQUIRES_FORCE",
        worktreeId: "wt_web_cleanup",
      }),
    );
    expect(() => assertWorktreeRemovalAllowed(row, true)).not.toThrow();
  });

  it("rejects active-agent worktree removal and session close unless force is explicit", () => {
    const snapshot = snapshotFor({ dirty: false, state: "working" });
    const row = snapshot.rows[0];
    const session = snapshot.sessions[0];

    expect(() => assertWorktreeRemovalAllowed(row, false)).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "WORKTREE_AGENT_ACTIVE_REQUIRES_FORCE",
        sessionId: "ses_web_cleanup",
      }),
    );
    expect(() => assertSessionCloseAllowed(session, row, false)).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "SESSION_AGENT_ACTIVE_REQUIRES_FORCE",
        sessionId: "ses_web_cleanup",
      }),
    );
    expect(() => assertWorktreeRemovalAllowed(row, true)).not.toThrow();
    expect(() => assertSessionCloseAllowed(session, row, true)).not.toThrow();
  });

  it("throws SafeErrors for missing session and worktree resolution", () => {
    const snapshot = snapshotFor({ dirty: false, state: "none" });

    expect(() => resolveSessionOrThrow(snapshot, "ses_missing")).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "SESSION_NOT_FOUND",
        sessionId: "ses_missing",
      }),
    );
    expect(() => resolveWorktreeRowOrThrow(snapshot, "wt_missing")).toThrowError(
      expect.objectContaining({
        tag: "CommandValidationError",
        code: "WORKTREE_NOT_FOUND",
        worktreeId: "wt_missing",
      }),
    );
  });

  it("fails closed for primary and default-branch checkouts in normal and bare layouts", () => {
    const snapshot = snapshotFor({ dirty: false, state: "none" });
    const row = snapshot.rows[0];
    const current = createFakeWorktree({
      id: row.id,
      projectId: row.projectId,
      branch: row.branch,
      path: row.path,
      registrationIdentity: "git-registration:cleanup",
      now,
    });
    const payload = {
      worktreeId: row.id,
      projectId: row.projectId,
      expectedPath: row.path,
      expectedBranch: row.branch,
      expectedRegistrationIdentity: "git-registration:cleanup",
    };

    expect(
      resolveWorktreeRemovalTarget({
        payload: { ...payload, expectedPath: project.root },
        snapshotRow: { ...row, path: project.root },
        project,
        currentWorktrees: [{ ...current, path: project.root }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_ROOT_REMOVAL_NOT_ALLOWED" },
      refusalReason: "primary_checkout",
    });

    const bareProject = { ...project, root: "/tmp/station/web.git" };
    expect(
      resolveWorktreeRemovalTarget({
        payload,
        snapshotRow: row,
        project: bareProject,
        currentWorktrees: [{ ...current, isPrimaryCheckout: true }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_ROOT_REMOVAL_NOT_ALLOWED" },
      refusalReason: "primary_checkout",
    });

    const mainRow = { ...row, branch: "main" };
    expect(
      resolveWorktreeRemovalTarget({
        payload: { ...payload, expectedBranch: "main" },
        snapshotRow: mainRow,
        project: bareProject,
        currentWorktrees: [{ ...current, branch: "main" }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_DEFAULT_BRANCH_REMOVAL_NOT_ALLOWED" },
      refusalReason: "default_branch",
    });

    const derivedDefaultProject = {
      id: project.id,
      label: project.label,
      root: bareProject.root,
      defaults: project.defaults,
      worktrunk: { enabled: true, base: "origin/main" },
    };
    expect(
      resolveWorktreeRemovalTarget({
        payload: { ...payload, expectedBranch: "main" },
        snapshotRow: mainRow,
        project: derivedDefaultProject,
        currentWorktrees: [{ ...current, branch: "main" }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_DEFAULT_BRANCH_REMOVAL_NOT_ALLOWED" },
    });

    expect(
      resolveWorktreeRemovalTarget({
        payload: { ...payload, expectedBranch: "main" },
        snapshotRow: mainRow,
        project: { ...derivedDefaultProject, worktrunk: { enabled: true, base: "upstream/main" } },
        currentWorktrees: [{ ...current, branch: "main" }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_DEFAULT_BRANCH_REMOVAL_NOT_ALLOWED" },
      refusalReason: "default_branch",
    });

    const releaseRow = { ...row, branch: "release/main" };
    expect(
      resolveWorktreeRemovalTarget({
        payload: { ...payload, expectedBranch: "release/main" },
        snapshotRow: releaseRow,
        project: {
          ...derivedDefaultProject,
          worktrunk: { enabled: true, base: "refs/heads/release/main" },
        },
        currentWorktrees: [{ ...current, branch: "release/main" }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_DEFAULT_BRANCH_REMOVAL_NOT_ALLOWED" },
      refusalReason: "default_branch",
    });

    expect(
      resolveWorktreeRemovalTarget({
        payload,
        snapshotRow: row,
        project: { ...derivedDefaultProject, worktrunk: { enabled: true, base: "   " } },
        currentWorktrees: [current],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_REMOVE_PROTECTION_UNVERIFIED" },
      refusalReason: "protection_unverified",
    });
  });

  it("reports changed, missing, and ambiguous removal selections as stale evidence", () => {
    const snapshot = snapshotFor({ dirty: false, state: "none" });
    const row = snapshot.rows[0];
    const current = createFakeWorktree({
      id: row.id,
      projectId: row.projectId,
      branch: row.branch,
      path: row.path,
      registrationIdentity: "git-registration:cleanup",
      now,
    });
    const payload = {
      worktreeId: row.id,
      projectId: row.projectId,
      expectedPath: row.path,
      expectedBranch: row.branch,
      expectedRegistrationIdentity: "git-registration:cleanup",
    };

    expect(
      resolveWorktreeRemovalTarget({
        payload,
        snapshotRow: row,
        project,
        currentWorktrees: [{ ...current, branch: "main" }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_REMOVE_STALE_SELECTION" },
      refusalReason: "branch_changed",
      observedBranch: "main",
    });
    expect(
      resolveWorktreeRemovalTarget({
        payload,
        snapshotRow: row,
        project,
        currentWorktrees: [{ ...current, path: `${row.path}-moved` }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_REMOVE_STALE_SELECTION" },
      refusalReason: "path_changed",
    });
    expect(
      resolveWorktreeRemovalTarget({
        payload,
        snapshotRow: row,
        project,
        currentWorktrees: [],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_REMOVE_STALE_SELECTION" },
      refusalReason: "missing_target",
    });
    expect(
      resolveWorktreeRemovalTarget({
        payload,
        snapshotRow: row,
        project,
        currentWorktrees: [current, { ...current }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_REMOVE_TARGET_AMBIGUOUS" },
      refusalReason: "ambiguous_identity",
    });
    expect(
      resolveWorktreeRemovalTarget({
        payload,
        snapshotRow: row,
        project,
        currentWorktrees: [{ ...current, registrationIdentity: "git-registration:replacement" }],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "WORKTREE_REMOVE_STALE_SELECTION",
        diagnosticDetails: [
          expect.objectContaining({
            type: "worktree_removal_refusal",
            refusalReason: "registration_changed",
          }),
        ],
      },
      refusalReason: "registration_changed",
    });

    const { registrationIdentity: _registrationIdentity, ...unverifiedCurrent } = current;
    expect(
      resolveWorktreeRemovalTarget({
        payload,
        snapshotRow: row,
        project,
        currentWorktrees: [unverifiedCurrent],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_REMOVE_STALE_SELECTION" },
      refusalReason: "registration_unverified",
    });
  });

  it("resolves an unchanged disposable worktree for removal", () => {
    const snapshot = snapshotFor({ dirty: false, state: "none" });
    const row = snapshot.rows[0];
    const current = createFakeWorktree({
      id: row.id,
      projectId: row.projectId,
      branch: row.branch,
      path: row.path,
      registrationIdentity: "git-registration:cleanup",
      now,
    });

    expect(
      resolveWorktreeRemovalTarget({
        payload: {
          worktreeId: row.id,
          projectId: row.projectId,
          expectedPath: row.path,
          expectedBranch: row.branch,
          expectedRegistrationIdentity: "git-registration:cleanup",
        },
        snapshotRow: row,
        project,
        currentWorktrees: [current],
      }),
    ).toEqual({ ok: true, target: current });
  });

  it("refuses removal when default-branch protection cannot be verified", () => {
    const snapshot = snapshotFor({ dirty: false, state: "none" });
    const row = snapshot.rows[0];
    const current = createFakeWorktree({
      id: row.id,
      projectId: row.projectId,
      branch: row.branch,
      path: row.path,
      registrationIdentity: "git-registration:cleanup",
      now,
    });
    const unverifiedProject = {
      id: project.id,
      label: project.label,
      root: project.root,
      defaults: project.defaults,
      worktrunk: { enabled: true },
    };

    expect(
      resolveWorktreeRemovalTarget({
        payload: {
          worktreeId: row.id,
          projectId: row.projectId,
          expectedPath: row.path,
          expectedBranch: row.branch,
          expectedRegistrationIdentity: "git-registration:cleanup",
        },
        snapshotRow: row,
        project: unverifiedProject,
        currentWorktrees: [current],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKTREE_REMOVE_PROTECTION_UNVERIFIED" },
      refusalReason: "protection_unverified",
    });
  });
});

function snapshotFor(input: { dirty: boolean; state: "none" | "working" }) {
  const worktree = createFakeWorktree({
    id: "wt_web_cleanup",
    projectId: "web",
    branch: "cleanup",
    registrationIdentity: "git-registration:cleanup",
    dirty: input.dirty,
    now,
  });
  return buildStationSnapshot({
    generatedAt: now,
    observer: {
      pid: 4242,
      startedAt: now,
      version: "0.0.0",
    },
    projects: [project],
    worktreeProviderId: "fake-worktree",
    providerHealth: {},
    worktrees: [worktree],
    terminalTargets:
      input.state === "none"
        ? []
        : [
            createFakeTerminalTarget({
              id: "term_web_cleanup",
              projectId: "web",
              worktreeId: "wt_web_cleanup",
              sessionId: "ses_web_cleanup",
              harnessRunId: "run_web_cleanup",
              now,
            }),
          ],
    harnessRuns:
      input.state === "none"
        ? []
        : [
            observerHarnessRunFromRun(
              createFakeHarnessRun({
                id: "run_web_cleanup",
                projectId: "web",
                worktreeId: "wt_web_cleanup",
                sessionId: "ses_web_cleanup",
                state: "working",
                now,
              }),
            ),
          ],
  });
}

const project = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaultBranch: "main",
  defaults: {
    harness: "fake-harness",
    terminal: "fake-terminal",
    layout: "agent-shell",
  },
  worktrunk: {
    enabled: true,
  },
};
