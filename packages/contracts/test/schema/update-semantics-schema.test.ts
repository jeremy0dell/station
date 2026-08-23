import {
  type UpdateCommandReport,
  UpdateCommandReportSchema,
  type UpdateConvergencePhase,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const target = { version: "2.0.0", revision: "target-revision" };
const buildIdentity = "a".repeat(64);
const initialDigest = "b".repeat(64);
const terminal = {
  kind: "agent" as const,
  terminalTargetId: "terminal-a",
  ptyId: "pty-a",
  ptyInstanceId: "pty-instance-a",
  projectId: "project-a",
  worktreeId: "worktree-a",
  sessionId: "session-a",
  harnessProvider: "codex",
  alive: true,
  handoffSupport: "bridge-releasable" as const,
};
const terminalDisposition = {
  terminalTargetId: terminal.terminalTargetId,
  ptyId: terminal.ptyId,
  ptyInstanceId: terminal.ptyInstanceId,
  sessionId: terminal.sessionId,
  handoff: "preservable" as const,
  reapRecovery: "recoverable" as const,
  reasons: [],
};
const preflightBase = {
  schemaVersion: 2 as const,
  boundary: {
    authorization: "none" as const,
    actions: "not-included" as const,
    digest: "not-included" as const,
  },
  installed: target,
  target,
  observer: {
    status: "exact" as const,
    buildVersion: `2.0.0+station.${buildIdentity}`,
    relation: "matching-target" as const,
    replacementAdmission: "exact-build" as const,
    health: "healthy" as const,
    recovery: {
      status: "unknown" as const,
      reason: "api-unavailable" as const,
      error: { tag: "UpdatePreflightError", code: "RECOVERY_UNAVAILABLE", message: "Unavailable." },
    },
  },
  host: {
    status: "inspected" as const,
    buildVersion: target.version,
    buildIdentity,
    protocolVersion: 8,
    relation: "matching-target" as const,
    compatibility: "reuse" as const,
    terminals: [terminal],
  },
  hookProviderIds: ["codex"],
  hooks: [{ provider: "codex", status: "healthy" as const }],
  terminalDispositions: [terminalDisposition],
  evidenceComplete: false,
};
const convergedPlan = {
  schemaVersion: 1 as const,
  selectedTarget: {
    artifact: target,
    buildIdentity: { status: "known" as const, value: buildIdentity },
  },
  installation: { owner: "installer-binary" as const, action: "no-op" as const },
  status: "converged" as const,
  digest: {
    algorithm: "sha256" as const,
    canonicalizationVersion: 1 as const,
    value: buildIdentity,
  },
  components: {
    hooks: [{ provider: "codex", action: "no-op" as const, reason: "healthy" as const }],
    observer: { action: "no-op" as const, reason: "matching-healthy" as const },
    terminals: {
      action: "no-op" as const,
      reason: "matching-target" as const,
      liveCount: 1,
      recoverableCount: 1,
      nonResumableCount: 0,
      unknownRecoveryCount: 0,
    },
    host: { action: "no-op" as const, reason: "matching-target" as const },
    recovery: { relevance: "not-required" as const, status: "not-required" as const },
    reconcile: { action: "no-op" as const, reason: "no-runtime-change" as const },
    verification: { action: "satisfied" as const, reason: "already-converged" as const },
  },
  phases: [
    {
      id: "artifact-application" as const,
      action: "no-op" as const,
      reason: "already-selected" as const,
    },
    { id: "hook-reconciliation" as const, action: "no-op" as const, reason: "healthy" as const },
    {
      id: "observer-convergence" as const,
      action: "no-op" as const,
      reason: "matching-healthy" as const,
    },
    {
      id: "terminal-convergence" as const,
      action: "no-op" as const,
      reason: "matching-target" as const,
    },
    {
      id: "host-convergence" as const,
      action: "no-op" as const,
      reason: "matching-target" as const,
    },
    {
      id: "runtime-reconcile" as const,
      action: "no-op" as const,
      reason: "no-runtime-change" as const,
    },
    {
      id: "verification" as const,
      action: "satisfied" as const,
      reason: "already-converged" as const,
    },
  ],
};
const convergedReport = UpdateCommandReportSchema.parse({
  schemaVersion: 4,
  channel: "installer-binary",
  status: "current",
  current: target,
  target,
  artifactApplication: { status: "not-required" },
  initial: { evaluator: "successor-cli", preflight: preflightBase, plan: convergedPlan },
  result: {
    kind: "already-converged",
    verification: { status: "converged", source: "initial", planDigest: buildIdentity },
  },
  warnings: [],
  recoveryCommands: [],
});

const actionablePreflight = {
  ...preflightBase,
  observer: { status: "absent" as const },
  host: { status: "absent" as const },
  hooks: [{ provider: "codex", status: "needs-repair" as const, reason: "missing" as const }],
  terminalDispositions: [],
};
const actionablePlan = {
  ...convergedPlan,
  digest: { ...convergedPlan.digest, value: initialDigest },
  status: "actionable" as const,
  components: {
    hooks: [{ provider: "codex", action: "reconcile" as const, reason: "missing" as const }],
    observer: { action: "start" as const, reason: "absent" as const },
    terminals: {
      action: "no-op" as const,
      reason: "no-terminals" as const,
      liveCount: 0,
      recoverableCount: 0,
      nonResumableCount: 0,
      unknownRecoveryCount: 0,
    },
    host: { action: "no-op" as const, reason: "absent" as const },
    recovery: { relevance: "not-required" as const, status: "not-required" as const },
    reconcile: { action: "run" as const, reason: "runtime-change" as const },
    verification: { action: "reinspect" as const, reason: "reinspect-after-actions" as const },
  },
  phases: [
    {
      id: "artifact-application" as const,
      action: "no-op" as const,
      reason: "already-selected" as const,
    },
    {
      id: "hook-reconciliation" as const,
      action: "reconcile" as const,
      reason: "runtime-change" as const,
    },
    { id: "observer-convergence" as const, action: "start" as const, reason: "absent" as const },
    {
      id: "terminal-convergence" as const,
      action: "no-op" as const,
      reason: "no-terminals" as const,
    },
    { id: "host-convergence" as const, action: "no-op" as const, reason: "absent" as const },
    { id: "runtime-reconcile" as const, action: "run" as const, reason: "runtime-change" as const },
    {
      id: "verification" as const,
      action: "reinspect" as const,
      reason: "reinspect-after-actions" as const,
    },
  ],
};
const successfulExecutionReport = UpdateCommandReportSchema.parse({
  ...convergedReport,
  initial: {
    evaluator: "successor-cli",
    preflight: actionablePreflight,
    plan: actionablePlan,
  },
  result: {
    kind: "current-runtime-execution",
    actionAudits: [
      {
        executor: "successor-cli",
        planDigest: initialDigest,
        actions: [
          {
            phase: "hook-reconciliation",
            action: "reconcile",
            status: "completed",
            provider: "codex",
            hookResult: { provider: "codex", status: "repaired", changed: true, verified: true },
          },
          { phase: "observer-convergence", action: "start", status: "completed" },
          { phase: "runtime-reconcile", action: "run", status: "completed" },
          { phase: "verification", action: "reinspect", status: "completed" },
        ],
      },
    ],
    postAction: convergedReport.initial,
    verification: { status: "converged", source: "post-action", planDigest: buildIdentity },
  },
});

describe("current strict convergence semantics", () => {
  it.each([
    [
      "hook action",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.hooks[0] = {
          provider: "codex",
          action: "reconcile",
          reason: "healthy",
        }),
    ],
    [
      "hook reason",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.hooks[0] = {
          provider: "codex",
          action: "no-op",
          reason: "unsupported",
        }),
    ],
    [
      "Observer action",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.observer = {
          action: "restart",
          reason: "matching-healthy",
        }),
    ],
    [
      "Observer reason",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.observer = {
          action: "no-op",
          reason: "matching-unhealthy",
        }),
    ],
    [
      "Observer singleton admission",
      (report: UpdateCommandReport) => {
        const observer = report.initial.preflight.observer;
        if (observer.status !== "exact") throw new Error("missing exact Observer fixture");
        observer.relation = "different";
        observer.replacementAdmission = "incumbent-wins";
      },
    ],
    [
      "terminal action",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.terminals.action = "preserve-via-handoff"),
    ],
    [
      "terminal reason",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.terminals.reason = "no-terminals"),
    ],
    [
      "terminal live count",
      (report: UpdateCommandReport) => (report.initial.plan.components.terminals.liveCount = 2),
    ],
    [
      "terminal recovery count",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.terminals.recoverableCount = 0),
    ],
    [
      "Host action",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.host = {
          action: "replace-idle",
          reason: "matching-target",
        }),
    ],
    [
      "Host reason",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.host = { action: "no-op", reason: "absent" }),
    ],
    [
      "recovery relevance",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.recovery.relevance = "destructive-follow-up"),
    ],
    [
      "recovery status",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.recovery.status = "complete"),
    ],
    [
      "reconcile action",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.reconcile = { action: "run", reason: "no-runtime-change" }),
    ],
    [
      "reconcile reason",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.reconcile = { action: "no-op", reason: "runtime-change" }),
    ],
    [
      "verification action",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.verification = {
          action: "reinspect",
          reason: "already-converged",
        }),
    ],
    [
      "verification reason",
      (report: UpdateCommandReport) =>
        (report.initial.plan.components.verification = {
          action: "satisfied",
          reason: "reinspect-after-actions",
        }),
    ],
    ["plan status", (report: UpdateCommandReport) => (report.initial.plan.status = "actionable")],
    [
      "target build knowledge",
      (report: UpdateCommandReport) =>
        (report.initial.plan.selectedTarget.buildIdentity = { status: "not-yet-provable" }),
    ],
  ] as const)("rejects a one-field %s contradiction", (_name, mutate) => {
    const report = structuredClone(convergedReport);
    mutate(report);
    expect(UpdateCommandReportSchema.safeParse(report).success).toBe(false);
  });

  it.each(
    convergedPlan.phases.flatMap((_phase, index) => [
      {
        name: `${convergedPlan.phases[index]?.id ?? String(index)} action`,
        phaseIndex: index,
        mutate: (phase: UpdateConvergencePhase) => {
          phase.action = "blocked";
        },
      },
      {
        name: `${convergedPlan.phases[index]?.id ?? String(index)} reason`,
        phaseIndex: index,
        mutate: (phase: UpdateConvergencePhase) => {
          phase.reason = "inspection-failed";
        },
      },
    ]),
  )("rejects a phase/component mismatch in $name", ({ mutate, phaseIndex }) => {
    const report = structuredClone(convergedReport);
    const phase = report.initial.plan.phases[phaseIndex];
    if (phase === undefined) throw new Error("missing test phase");
    mutate(phase);
    expect(UpdateCommandReportSchema.safeParse(report).success).toBe(false);
  });

  it.each([
    {
      name: "absent Observer",
      mutate: (report: UpdateCommandReport) => {
        report.initial.preflight.observer = { status: "absent" };
      },
    },
    {
      name: "unknown Observer",
      mutate: (report: UpdateCommandReport) => {
        report.initial.preflight.observer = {
          status: "unknown",
          reason: "identity-unavailable",
          error: { tag: "UpdatePreflightError", code: "UNKNOWN", message: "Unknown." },
        };
      },
    },
    {
      name: "Observer from another immutable target claiming a match",
      mutate: (report: UpdateCommandReport) => {
        const observer = report.initial.preflight.observer;
        if (observer.status !== "exact") throw new Error("missing exact Observer fixture");
        observer.buildVersion = `2.0.0+station.${"c".repeat(64)}`;
      },
    },
    {
      name: "Host from another immutable target claiming reuse",
      mutate: (report: UpdateCommandReport) => {
        const host = report.initial.preflight.host;
        if (host.status !== "inspected") throw new Error("missing inspected Host fixture");
        host.buildIdentity = "c".repeat(64);
      },
    },
    {
      name: "changed terminal identity",
      mutate: (report: UpdateCommandReport) => {
        const disposition = report.initial.preflight.terminalDispositions[0];
        if (disposition === undefined) throw new Error("missing test disposition");
        disposition.ptyInstanceId = "different-instance";
      },
    },
    {
      name: "missing terminal disposition",
      mutate: (report: UpdateCommandReport) => {
        report.initial.preflight.terminalDispositions = [];
      },
    },
    {
      name: "duplicate terminal disposition",
      mutate: (report: UpdateCommandReport) => {
        const disposition = report.initial.preflight.terminalDispositions[0];
        if (disposition === undefined) throw new Error("missing test disposition");
        report.initial.preflight.terminalDispositions.push(structuredClone(disposition));
      },
    },
  ])("rejects fabricated convergence with $name evidence", ({ mutate }) => {
    const report = structuredClone(convergedReport);
    mutate(report);
    expect(UpdateCommandReportSchema.safeParse(report).success).toBe(false);
  });

  it.each([
    ...["hook-reconciliation", "observer-convergence", "runtime-reconcile", "verification"].map(
      (phase) => ({
        name: `missing ${phase}`,
        mutate: (report: UpdateCommandReport) => {
          const audit = executionAudit(report);
          audit.actions = audit.actions.filter((action) => action.phase !== phase);
        },
      }),
    ),
    {
      name: "duplicate action",
      mutate: (report: UpdateCommandReport) => {
        const audit = executionAudit(report);
        const observer = audit.actions.find((action) => action.phase === "observer-convergence");
        if (observer === undefined) throw new Error("missing Observer action");
        audit.actions.splice(2, 0, structuredClone(observer));
      },
    },
    {
      name: "skipped action",
      mutate: (report: UpdateCommandReport) => {
        const action = executionAudit(report).actions[1];
        if (action === undefined) throw new Error("missing action");
        action.status = "skipped";
      },
    },
    {
      name: "failed action",
      mutate: (report: UpdateCommandReport) => {
        const action = executionAudit(report).actions[1];
        if (action === undefined) throw new Error("missing action");
        action.status = "failed";
      },
    },
    {
      name: "reordered actions",
      mutate: (report: UpdateCommandReport) => {
        executionAudit(report).actions.reverse();
      },
    },
    {
      name: "wrong provider",
      mutate: (report: UpdateCommandReport) => {
        const hook = executionAudit(report).actions[0];
        if (hook === undefined) throw new Error("missing hook action");
        hook.provider = "claude";
        hook.hookResult = { provider: "claude", status: "repaired", changed: true, verified: true };
      },
    },
    {
      name: "missing provider result",
      mutate: (report: UpdateCommandReport) => {
        const hook = executionAudit(report).actions[0];
        if (hook === undefined) throw new Error("missing hook action");
        delete hook.hookResult;
      },
    },
  ])("rejects successful execution audit with $name", ({ mutate }) => {
    const report = structuredClone(successfulExecutionReport);
    mutate(report);
    expect(UpdateCommandReportSchema.safeParse(report).success).toBe(false);
  });

  it("admits failed or skipped actions only as the exact final execution-failed stage", () => {
    for (const status of ["failed", "skipped"] as const) {
      const report = structuredClone(successfulExecutionReport);
      const audit = executionAudit(report);
      const verification = audit.actions.at(-1);
      if (verification === undefined) throw new Error("missing verification action");
      verification.status = status;
      report.status = "failed";
      report.result = {
        kind: "execution-failed",
        stage: "verification",
        actionAudits: [audit],
        finalInspection: { status: "completed", evidence: convergedReport.initial },
      };
      report.error = { tag: "UpdateError", code: "VERIFY_FAILED", message: "Failed." };
      expect(UpdateCommandReportSchema.parse(report)).toEqual(report);

      const wrongStage = structuredClone(report);
      if (wrongStage.result.kind !== "execution-failed") throw new Error("expected failure");
      wrongStage.result.stage = "runtime-reconcile";
      expect(UpdateCommandReportSchema.safeParse(wrongStage).success).toBe(false);
    }
  });
});

function executionAudit(report: UpdateCommandReport) {
  if (report.result.kind !== "current-runtime-execution") {
    throw new Error("expected current runtime execution fixture");
  }
  return report.result.actionAudits[0];
}
