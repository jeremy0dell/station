import * as Contracts from "@station/contracts";
import {
  parseUpdateCommandReport,
  projectPublicUpdateReport,
  type UpdateCommandReport,
  UpdateCommandReportSchema,
  UpdateReportIdentityAliasLabels,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const current = { version: "1.2.3", revision: "current" };
const target = { version: "1.2.3", revision: "current" };
const initial = {
  schemaVersion: 1 as const,
  boundary: {
    authorization: "none" as const,
    actions: "not-included" as const,
    digest: "not-included" as const,
  },
  installed: current,
  target,
  observer: { status: "absent" as const },
  host: { status: "absent" as const },
  hookProviderIds: ["codex"],
  hooks: [{ provider: "codex", status: "healthy" as const }],
  parkedBridges: {
    status: "assessed" as const,
    totalParkedCount: 0,
    unownedParkedCount: 0,
    adoptionRequiredCount: 0,
  },
  terminalDispositions: [],
  evidenceComplete: false,
};
const plan = {
  authorization: "none" as const,
  selectedTarget: {
    artifact: target,
    runtimeBuild: {
      status: "known" as const,
      buildIdentity: "a".repeat(64),
      observerSelector: `1.2.3+station.${"a".repeat(64)}`,
    },
  },
  outcome: "actionable" as const,
  phases: {
    artifactApplication: {
      action: "no-op" as const,
      reason: "selected-artifact-current" as const,
      before: current,
      owner: "installer-binary" as const,
      command: { kind: "none" as const },
    },
    hookReconciliation: {
      action: "no-op" as const,
      reason: "healthy" as const,
      providers: [
        { provider: "codex" as const, action: "no-op" as const, reason: "healthy" as const },
      ],
    },
    observerConvergence: { action: "start" as const, reason: "absent" as const },
    terminalConvergence: {
      action: "no-op" as const,
      reason: "no-terminals" as const,
      terminals: [],
    },
    hostConvergence: { action: "no-op" as const, reason: "absent" as const },
    persistedStateReconcile: { action: "run" as const, reason: "runtime-change" as const },
    finalVerification: { action: "inspect" as const, reason: "after-actions" as const },
  },
};
const preview = {
  schemaVersion: 6 as const,
  kind: "preview" as const,
  channel: "installer-binary" as const,
  current,
  target,
  initial,
  plan,
};
const result = {
  schemaVersion: 6 as const,
  kind: "result" as const,
  channel: "installer-binary" as const,
  status: "failed" as const,
  current,
  target,
  initial,
  plan,
  steps: [{ id: "apply" as const, status: "completed" as const, detail: "Installed." }],
  warnings: [],
  recoveryCommands: [],
  hookReconciliations: [],
};

describe("current update report", () => {
  it("parses one strict preview and one strict result", () => {
    expect(parseUpdateCommandReport(preview)).toEqual(preview);
    expect(parseUpdateCommandReport(result)).toEqual(result);
    const projectCurrent = (report: UpdateCommandReport): UpdateCommandReport =>
      projectPublicUpdateReport(report);
    expect(projectCurrent(result)).toEqual(result);
  });

  it("preserves optional non-dry evidence only when present", () => {
    const failed = {
      ...result,
      status: "failed" as const,
      hookReconciliations: [
        {
          provider: "codex" as const,
          status: "healthy" as const,
          changed: false,
          verified: true,
        },
      ],
      error: { tag: "UpdateError", code: "UPDATE_FAILED", message: "Failed." },
      cause: { tag: "UpdateError", code: "UPDATE_CAUSE", message: "Cause." },
      startupEvidence: { bootLogPath: "/tmp/observer.log" },
      reapRecovery: {
        status: "completed" as const,
        terminals: [],
        unresolved: false,
        recoveryCommands: [],
      },
    };
    expect(parseUpdateCommandReport(failed)).toEqual(failed);
    expect(parseUpdateCommandReport(result)).not.toHaveProperty("error");
  });

  it("rejects explicit undefined for every exact optional result field", () => {
    for (const field of [
      "finalInspection",
      "reapRecovery",
      "error",
      "cause",
      "startupEvidence",
    ] as const) {
      expect(
        UpdateCommandReportSchema.safeParse({ ...result, [field]: undefined }).success,
        field,
      ).toBe(false);
    }
  });

  it("rejects explicit undefined throughout nested result input before transforms", () => {
    const cases: Array<[string, unknown, PropertyKey[]]> = [
      [
        "safe error identity",
        { ...result, error: { ...publicError, projectId: undefined } },
        ["error", "projectId"],
      ],
      [
        "startup evidence tail",
        {
          ...result,
          startupEvidence: { bootLogPath: "/tmp/observer.log", bootLogTail: undefined },
        },
        ["startupEvidence", "bootLogTail"],
      ],
      [
        "step command",
        { ...result, steps: [{ ...result.steps[0], command: undefined }] },
        ["steps", "0", "command"],
      ],
      [
        "artifact revision",
        { ...result, current: { ...current, revision: undefined } },
        ["current", "revision"],
      ],
    ];
    for (const [label, candidate, path] of cases) assertUndefinedRejected(candidate, path, label);
  });

  it("rejects explicit undefined throughout nested preview input before transforms", () => {
    const cases: Array<[string, unknown, PropertyKey[]]> = [
      [
        "aggregate artifact",
        { ...preview, initial: { ...initial, installed: { ...current, revision: undefined } } },
        ["initial", "installed", "revision"],
      ],
      [
        "aggregate error",
        {
          ...preview,
          initial: {
            ...initial,
            observer: {
              status: "unknown",
              reason: "unhealthy",
              error: { ...publicError, hint: undefined },
            },
          },
        },
        ["initial", "observer", "error", "hint"],
      ],
      [
        "selected artifact",
        {
          ...preview,
          plan: {
            ...plan,
            selectedTarget: {
              ...plan.selectedTarget,
              artifact: { ...target, revision: undefined },
            },
          },
        },
        ["plan", "selectedTarget", "artifact", "revision"],
      ],
    ];
    for (const [label, candidate, path] of cases) assertUndefinedRejected(candidate, path, label);
  });

  it("rejects enumerable accessors without executing them", () => {
    let getterExecuted = false;
    const candidate = { ...result };
    Object.defineProperty(candidate, "hostile", {
      enumerable: true,
      get: () => {
        getterExecuted = true;
        throw new Error("Getter must not execute.");
      },
    });
    const parsed = UpdateCommandReportSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    expect(getterExecuted).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["hostile"] })]),
      );
    }
  });

  it("rejects a non-enumerable known-field accessor without executing it", () => {
    let getterExecuted = false;
    const candidate = { ...result };
    Object.defineProperty(candidate, "schemaVersion", {
      enumerable: false,
      get: () => {
        getterExecuted = true;
        throw new Error("Getter must not execute.");
      },
    });
    expect(UpdateCommandReportSchema.safeParse(candidate).success).toBe(false);
    expect(getterExecuted).toBe(false);
  });

  it("rejects a very deep cyclic unknown extra without call-stack recursion", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.cycle = root;
    expect(UpdateCommandReportSchema.safeParse({ ...result, unknown: root }).success).toBe(false);
  });

  it("rejects obsolete public planned states", () => {
    expect(UpdateCommandReportSchema.safeParse({ ...result, status: "planned" }).success).toBe(
      false,
    );
    expect(
      UpdateCommandReportSchema.safeParse({
        ...result,
        steps: [{ id: "apply", status: "planned", detail: "Not terminal." }],
      }).success,
    ).toBe(false);
  });

  it("rejects old discriminators, nested envelopes, and contradictory ownership shapes", () => {
    for (const schemaVersion of [1, 2, 3, 4, 5]) {
      expect(UpdateCommandReportSchema.safeParse({ ...result, schemaVersion }).success).toBe(false);
    }
    for (const extra of [
      { previousReport: result },
      { recoveryPreflight: initial },
      { successorReceipt: {} },
      { actionAudit: [] },
      { digest: "private" },
    ]) {
      expect(UpdateCommandReportSchema.safeParse({ ...result, ...extra }).success).toBe(false);
    }
    expect(
      UpdateCommandReportSchema.safeParse({ ...preview, channel: "dev-checkout" }).success,
    ).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({ ...preview, current: { version: "wrong" } }).success,
    ).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({ ...preview, target: { version: "wrong" } }).success,
    ).toBe(false);
  });

  it("accepts only deterministic report-wide aliases for structural local identities", () => {
    const aliased = previewWithAliases();
    expect(parseUpdateCommandReport(aliased)).toEqual(aliased);

    const project = structuredClone(aliased);
    identityRecords(project).host.projectId = "raw-project";
    expect(UpdateCommandReportSchema.safeParse(project).success).toBe(false);
    const worktree = structuredClone(aliased);
    identityRecords(worktree).host.worktreeId = "raw-worktree";
    expect(UpdateCommandReportSchema.safeParse(worktree).success).toBe(false);

    for (const field of ["terminalTargetId", "ptyId", "ptyInstanceId", "sessionId"] as const) {
      const raw = structuredClone(aliased);
      const identities = identityRecords(raw);
      identities.host[field] = `raw-${field}`;
      identities.disposition[field] = `raw-${field}`;
      identities.plan[field] = `raw-${field}`;
      expect(UpdateCommandReportSchema.safeParse(raw).success).toBe(false);
    }

    const gap = structuredClone(aliased);
    const identities = identityRecords(gap);
    identities.host.sessionId = "public-session-00000002";
    identities.disposition.sessionId = "public-session-00000002";
    identities.plan.sessionId = "public-session-00000002";
    expect(UpdateCommandReportSchema.safeParse(gap).success).toBe(false);
  });

  it("validates aliases in preview and result errors", () => {
    for (const candidate of previewErrorLocations()) {
      expect(parseUpdateCommandReport(candidate)).toEqual(candidate);
      const raw = structuredClone(candidate);
      const error = previewError(raw);
      error.projectId = "raw-project";
      expect(UpdateCommandReportSchema.safeParse(raw).success).toBe(false);
    }

    const completed = resultWithAliases();
    expect(parseUpdateCommandReport(completed)).toEqual(completed);
    for (let index = 0; index < resultErrors(completed).length; index += 1) {
      const raw = structuredClone(completed);
      const error = resultErrors(raw)[index];
      if (error === undefined) throw new Error("Missing result error fixture.");
      error.sessionId = "raw-session";
      expect(UpdateCommandReportSchema.safeParse(raw).success).toBe(false);
    }
  });

  it("projects a shared result error once and preserves its reference topology", () => {
    const shared = {
      ...publicError,
      projectId: "raw-project",
      worktreeId: "raw-worktree",
      sessionId: "raw-session",
    };
    const raw: Extract<UpdateCommandReport, { kind: "result" }> = {
      ...result,
      status: "failed",
      warnings: [shared, shared],
      error: shared,
      cause: shared,
      hookReconciliations: [
        {
          provider: "codex",
          status: "inspection-failed",
          changed: false,
          verified: false,
          error: shared,
          followUp: { action: "run-doctor" },
        },
      ],
    };
    const projected = projectPublicUpdateReport(raw);
    expect(projected.warnings[0]).toBe(projected.warnings[1]);
    expect(projected.warnings[0]).toBe(projected.error);
    expect(projected.error).toBe(projected.cause);
    expect(projected.error).toBe(
      projected.hookReconciliations[0]?.status === "inspection-failed"
        ? projected.hookReconciliations[0].error
        : undefined,
    );
    expect(projected.error?.projectId).toBe("public-project-00000001");
  });

  it("projects a shared terminal once and preserves its reference topology", () => {
    const raw = structuredClone(previewWithAliases());
    const identities = identityRecords(raw);
    for (const field of ["terminalTargetId", "ptyId", "ptyInstanceId", "sessionId"] as const) {
      identities.host[field] = `raw-${field}`;
      identities.disposition[field] = `raw-${field}`;
      identities.plan[field] = `raw-${field}`;
    }
    identities.host.projectId = "raw-projectId";
    identities.host.worktreeId = "raw-worktreeId";
    if (raw.initial.host.status !== "inspected") throw new Error("Missing Host fixture.");
    raw.initial.host.terminals.push(identities.host);

    const projected = projectPublicUpdateReport(raw);
    if (projected.initial.host.status !== "inspected") throw new Error("Missing Host projection.");
    expect(projected.initial.host.terminals[0]).toBe(projected.initial.host.terminals[1]);
    expect(projected.initial.host.terminals[0]?.terminalTargetId).toBe(
      "public-terminal-target-00000001",
    );
  });

  it("rejects plan terminals whose aliases do not correlate to initial identities", () => {
    for (const field of ["terminalTargetId", "ptyId", "ptyInstanceId", "sessionId"] as const) {
      const mismatch = structuredClone(previewWithAliases());
      const identities = identityRecords(mismatch);
      identities.plan[field] = `public-${UpdateReportIdentityAliasLabels[field]}-00000002`;
      expect(UpdateCommandReportSchema.safeParse(mismatch).success, field).toBe(false);
    }
  });

  it("does not export historical report identifiers", () => {
    for (const name of [
      "UpdateCommandReportV1Schema",
      "UpdateCommandReportV2Schema",
      "UpdateCommandReportV3Schema",
      "CompatibleUpdateCommandReportSchema",
    ]) {
      expect(name in Contracts).toBe(false);
    }
  });
});

const publicError = {
  tag: "UpdateError",
  code: "UPDATE_FAILED",
  message: "Safe failure.",
  projectId: "public-project-00000001",
  worktreeId: "public-worktree-00000001",
  sessionId: "public-session-00000001",
  commandId: "cmd_public",
  traceId: "trace-public",
  diagnosticId: "diagnostic-public",
  provider: "codex" as const,
};

function previewErrorLocations(): Array<Extract<UpdateCommandReport, { kind: "preview" }>> {
  return [
    {
      ...preview,
      initial: {
        ...initial,
        observer: { status: "unknown", reason: "unhealthy", error: publicError },
      },
    },
    {
      ...preview,
      initial: {
        ...initial,
        observer: {
          status: "exact",
          buildVersion: "1.2.3",
          relation: "different",
          health: "unavailable",
          recovery: { status: "unknown", reason: "inspection-failed", error: publicError },
        },
      },
    },
    {
      ...preview,
      initial: {
        ...initial,
        host: { status: "unknown", reason: "inaccessible", error: publicError },
      },
    },
    {
      ...preview,
      initial: {
        ...initial,
        hookProviderIds: ["codex"],
        hooks: [
          {
            provider: "codex",
            status: "inspection-failed",
            error: publicError,
            followUp: { action: "run-doctor" },
          },
        ],
      },
    },
  ];
}

function previewError(report: Extract<UpdateCommandReport, { kind: "preview" }>) {
  const { observer, host, hooks } = report.initial;
  if (observer.status === "unknown") return observer.error;
  if (observer.status === "exact" && observer.recovery.status === "unknown") {
    return observer.recovery.error;
  }
  if (host.status === "unknown") return host.error;
  const hook = hooks[0];
  if (hook?.status === "inspection-failed") return hook.error;
  throw new Error("Missing preview error fixture.");
}

function resultWithAliases(): Extract<UpdateCommandReport, { kind: "result" }> {
  return {
    ...result,
    status: "failed",
    warnings: [{ ...publicError, code: "UPDATE_WARNING" }],
    error: { ...publicError },
    cause: { ...publicError, code: "UPDATE_CAUSE" },
    hookReconciliations: [
      {
        provider: "codex",
        status: "inspection-failed",
        changed: false,
        verified: false,
        error: { ...publicError, code: "HOOK_FAILED" },
        followUp: { action: "run-doctor" },
      },
    ],
  };
}

function resultErrors(report: Extract<UpdateCommandReport, { kind: "result" }>) {
  if (
    report.error === undefined ||
    report.cause === undefined ||
    report.hookReconciliations[0]?.status !== "inspection-failed"
  ) {
    throw new Error("Missing result error fixture.");
  }
  const warning = report.warnings[0];
  if (warning === undefined) throw new Error("Missing warning fixture.");
  return [warning, report.error, report.cause, report.hookReconciliations[0].error];
}

function previewWithAliases(): Extract<UpdateCommandReport, { kind: "preview" }> {
  return {
    ...preview,
    initial: {
      ...initial,
      host: {
        status: "inspected",
        buildVersion: "1.2.3",
        buildIdentity: "a".repeat(64),
        protocolVersion: 8,
        relation: "different",
        compatibility: "replace",
        terminals: [
          {
            kind: "agent",
            terminalTargetId: "public-terminal-target-00000001",
            ptyId: "public-pty-00000001",
            ptyInstanceId: "public-pty-instance-00000001",
            projectId: "public-project-00000001",
            worktreeId: "public-worktree-00000001",
            sessionId: "public-session-00000001",
            harnessProvider: "codex",
            alive: true,
            handoffSupport: "non-releasable",
          },
        ],
      },
      terminalDispositions: [
        {
          terminalTargetId: "public-terminal-target-00000001",
          ptyId: "public-pty-00000001",
          ptyInstanceId: "public-pty-instance-00000001",
          sessionId: "public-session-00000001",
          handoff: "non-preservable",
          reapRecovery: "non-resumable",
          reasons: ["session_non_resumable"],
        },
      ],
    },
    plan: {
      ...plan,
      outcome: "reap-required",
      phases: {
        ...plan.phases,
        terminalConvergence: {
          action: "reap-required",
          reason: "non-preservable-terminals",
          terminals: [
            {
              terminalTargetId: "public-terminal-target-00000001",
              ptyId: "public-pty-00000001",
              ptyInstanceId: "public-pty-instance-00000001",
              sessionId: "public-session-00000001",
              handoff: "non-preservable",
              reapRecovery: "non-resumable",
              reasons: ["session_non_resumable"],
              kind: "agent",
              alive: true,
            },
          ],
        },
        hostConvergence: { action: "await-reap", reason: "non-preservable-terminals" },
        persistedStateReconcile: { action: "await-reap", reason: "reap-required" },
        finalVerification: { action: "await-reap", reason: "reap-required" },
      },
    },
  };
}

function identityRecords(report: Extract<UpdateCommandReport, { kind: "preview" }>) {
  if (report.initial.host.status !== "inspected") throw new Error("Missing Host fixture.");
  const host = report.initial.host.terminals[0];
  const disposition = report.initial.terminalDispositions[0];
  const plan = report.plan.phases.terminalConvergence.terminals[0];
  if (host === undefined || disposition === undefined || plan === undefined) {
    throw new Error("Missing terminal identity fixture.");
  }
  return { host, disposition, plan };
}

function assertUndefinedRejected(value: unknown, path: PropertyKey[], label: string): void {
  const parsed = UpdateCommandReportSchema.safeParse(value);
  expect(parsed.success, label).toBe(false);
  if (parsed.success) return;
  expect(parsed.error.issues, label).toEqual(
    expect.arrayContaining([expect.objectContaining({ path })]),
  );
}
