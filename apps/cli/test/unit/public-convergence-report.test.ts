import {
  projectPublicUpdateReport,
  type UpdateCommandReport,
  UpdateConvergencePlanningInputSchema,
  UpdateReapRecoveryPreflightSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  previewUpdateCommandResult,
  renderUpdateConvergenceReportText,
  updateCommandResult,
} from "../../src/commands/update/report.js";
import { deriveUpdateConvergencePlan } from "../../src/update/convergencePlan.js";

describe("public convergence report projection", () => {
  it("aliases only typed structural identities across the aggregate and plan", () => {
    const current = { version: "1.0.0" };
    const target = { version: "1.1.0", revision: "target-revision" };
    const initial = UpdateReapRecoveryPreflightSchema.parse({
      schemaVersion: 1,
      boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
      installed: current,
      target,
      observer: {
        status: "exact",
        buildVersion: `1.0.0+station.${"a".repeat(64)}`,
        relation: "different",
        health: "healthy",
        recovery: {
          status: "assessed",
          assessment: {
            schemaVersion: 1,
            resumeEnabled: true,
            providerCapabilities: [{ provider: "codex", status: "enabled" }],
            sessions: [
              {
                sessionId: "session-a",
                projectId: "project-a",
                worktreeId: "worktree-a",
                lifecycle: "open",
                harnessProvider: "codex",
                disposition: "non-resumable",
                reasons: ["no_recovery_handles"],
                handleResolution: {
                  kind: "none",
                  eligibleHandleCount: 0,
                  rejectedHandleCount: 0,
                  reasons: ["no_recovery_handles"],
                },
              },
            ],
          },
        },
      },
      host: {
        status: "inspected",
        buildVersion: "1.0.0",
        buildIdentity: "a".repeat(64),
        protocolVersion: 8,
        relation: "different",
        compatibility: "replace",
        terminals: [
          {
            kind: "agent",
            terminalTargetId: "terminal-a",
            ptyId: "pty-a",
            ptyInstanceId: "pty-instance-a",
            projectId: "project-a",
            worktreeId: "worktree-a",
            sessionId: "session-a",
            harnessProvider: "codex",
            alive: true,
            handoffSupport: "non-releasable",
          },
        ],
      },
      hookProviderIds: ["codex"],
      hooks: [
        {
          provider: "codex",
          status: "inspection-failed",
          error: {
            tag: "UpdatePreflightError",
            code: "HOOK_FAILED",
            message: "Hook inspection failed.",
            projectId: "project-a",
            worktreeId: "worktree-a",
            sessionId: "session-a",
            commandId: "command-public",
            traceId: "trace-public",
            diagnosticId: "diagnostic-public",
          },
          followUp: { action: "run-doctor" },
        },
      ],
      terminalDispositions: [
        {
          terminalTargetId: "terminal-a",
          ptyId: "pty-a",
          ptyInstanceId: "pty-instance-a",
          sessionId: "session-a",
          handoff: "non-preservable",
          reapRecovery: "non-resumable",
          reasons: ["session_non_resumable"],
        },
      ],
      evidenceComplete: false,
    });
    const planningInput = UpdateConvergencePlanningInputSchema.parse({
      preflight: initial,
      targetRuntime: { status: "not-yet-provable" },
      installation: {
        whenRequired: "apply",
        owner: "npm-global",
        command: {
          kind: "manager",
          argv: ["npm", "install", "command-public"],
        },
      },
      handoff: { action: "preserve", fidelity: "processes" },
    });
    const report = projectPublicUpdateReport({
      schemaVersion: 4,
      kind: "preview",
      channel: "npm-global",
      current,
      target,
      initial,
      plan: deriveUpdateConvergencePlan(planningInput),
    });

    expect(report.initial.host).toMatchObject({
      terminals: [
        {
          terminalTargetId: "public-terminal-target-00000001",
          ptyId: "public-pty-00000001",
          ptyInstanceId: "public-pty-instance-00000001",
          projectId: "public-project-00000001",
          worktreeId: "public-worktree-00000001",
          sessionId: "public-session-00000001",
          harnessProvider: "codex",
        },
      ],
    });
    expect(report.plan.phases.terminalConvergence.terminals[0]).toMatchObject({
      terminalTargetId: "public-terminal-target-00000001",
      sessionId: "public-session-00000001",
    });
    expect(report.plan.phases.artifactApplication.command).toEqual({
      kind: "manager",
      argv: ["npm", "install", "command-public"],
    });
    expect(report.initial.hooks[0]).toMatchObject({
      provider: "codex",
      error: {
        projectId: "public-project-00000001",
        worktreeId: "public-worktree-00000001",
        sessionId: "public-session-00000001",
        commandId: "command-public",
        traceId: "trace-public",
        diagnosticId: "diagnostic-public",
      },
    });
    expect(report.target).toEqual({ version: "1.1.0", revision: "target-revision" });
    expect(report.plan.selectedTarget.runtimeBuild).toEqual({ status: "not-yet-provable" });

    const text = renderUpdateConvergenceReportText(report);
    for (const identity of [
      "terminal-a",
      "pty-a",
      "pty-instance-a",
      "session-a",
      "project-a",
      "worktree-a",
    ]) {
      expect(text).not.toContain(identity);
    }
  });

  it("projects completed-result errors with one namespace and preserves public handles", () => {
    const rawError = {
      tag: "UpdateError",
      code: "UPDATE_FAILED",
      message: "Update failed safely.",
      projectId: "project-private",
      worktreeId: "worktree-private",
      sessionId: "session-private",
      provider: "codex" as const,
      commandId: "cmd-public",
      traceId: "trace-public",
      diagnosticId: "diagnostic-public",
    };
    const raw = {
      schemaVersion: 4,
      kind: "result",
      channel: "npm-global",
      status: "failed",
      current: { version: "1.0.0" },
      target: { version: "1.1.0", revision: "artifact-public" },
      steps: [
        {
          id: "apply",
          status: "failed",
          detail: "Apply failed.",
          command: ["npm", "install", "session-private"],
        },
      ],
      warnings: [{ ...rawError, code: "UPDATE_WARNING" }],
      recoveryCommands: [["stn", "debug", "trace", "trace-public"]],
      error: rawError,
      cause: { ...rawError, code: "UPDATE_CAUSE" },
      hookReconciliation: {
        provider: "codex",
        status: "inspection-failed",
        changed: false,
        verified: false,
        error: { ...rawError, code: "HOOK_FAILED" },
        followUp: { action: "run-doctor" },
      },
    } as unknown as Extract<UpdateCommandReport, { kind: "result" }>;

    const projected = projectPublicUpdateReport(raw);
    for (const error of [
      projected.warnings[0],
      projected.error,
      projected.cause,
      projected.hookReconciliation?.status === "inspection-failed"
        ? projected.hookReconciliation.error
        : undefined,
    ]) {
      expect(error).toMatchObject({
        projectId: "public-project-00000001",
        worktreeId: "public-worktree-00000001",
        sessionId: "public-session-00000001",
        provider: "codex",
        commandId: "cmd-public",
        traceId: "trace-public",
        diagnosticId: "diagnostic-public",
      });
    }
    expect(projected.steps[0]?.command).toEqual(["npm", "install", "session-private"]);
    expect(projected.target.revision).toBe("artifact-public");

    for (const output of ["json", "text"] as const) {
      const result = updateCommandResult(raw, output);
      const serialized =
        typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      expect(serialized).not.toContain('"projectId":"project-private"');
      expect(serialized).not.toContain('"worktreeId":"worktree-private"');
      expect(serialized).not.toContain('"sessionId":"session-private"');
    }
  });

  it.each([
    "observer",
    "recovery",
    "host",
  ] as const)("projects typed %s unknown errors before strict publication", (location) => {
    const report = unknownErrorReport(location);
    const error =
      report.initial.observer.status === "unknown"
        ? report.initial.observer.error
        : report.initial.observer.status === "exact" &&
            report.initial.observer.recovery.status === "unknown"
          ? report.initial.observer.recovery.error
          : report.initial.host.status === "unknown"
            ? report.initial.host.error
            : undefined;
    expect(error).toMatchObject({
      projectId: "public-project-00000001",
      worktreeId: "public-worktree-00000001",
      sessionId: "public-session-00000001",
    });
    expect(previewUpdateCommandResult(report, "json").output).toEqual(report);
  });
});

function unknownErrorReport(location: "observer" | "recovery" | "host") {
  const current = { version: "1.0.0" };
  const target = { version: "1.1.0" };
  const error = {
    tag: "UpdatePreflightError",
    code: "INSPECTION_FAILED",
    message: "Inspection failed safely.",
    projectId: "raw-project",
    worktreeId: "raw-worktree",
    sessionId: "raw-session",
  };
  const initial = UpdateReapRecoveryPreflightSchema.parse({
    schemaVersion: 1,
    boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
    installed: current,
    target,
    observer:
      location === "observer"
        ? { status: "unknown", reason: "inspection-failed", error }
        : location === "recovery"
          ? {
              status: "exact",
              buildVersion: "1.0.0",
              relation: "different",
              health: "unavailable",
              recovery: { status: "unknown", reason: "inspection-failed", error },
            }
          : { status: "absent" },
    host:
      location === "host"
        ? { status: "unknown", reason: "inventory-failed", error }
        : { status: "absent" },
    hookProviderIds: [],
    hooks: [],
    terminalDispositions: [],
    evidenceComplete: false,
  });
  const plan = deriveUpdateConvergencePlan(
    UpdateConvergencePlanningInputSchema.parse({
      preflight: initial,
      targetRuntime: { status: "not-yet-provable" },
      installation: {
        whenRequired: "apply",
        owner: "installer-binary",
        command: { kind: "none" },
      },
      handoff: { action: "leave-in-place" },
    }),
  );
  return projectPublicUpdateReport({
    schemaVersion: 4,
    kind: "preview",
    channel: "installer-binary",
    current,
    target,
    initial,
    plan,
  });
}
