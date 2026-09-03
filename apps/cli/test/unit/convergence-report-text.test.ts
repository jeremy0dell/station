import type { UpdateCommandReport } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  previewUpdateCommandResult,
  renderUpdateConvergenceReportText,
} from "../../src/commands/update/report.js";

type PreviewReport = Extract<UpdateCommandReport, { kind: "preview" }>;

describe("convergence report text", () => {
  it.each([
    ["converged", "no-op (converged)"],
    ["actionable", "safe actionable convergence"],
    ["deferred", "deferred to package manager"],
    ["reap-required", "reap required; no recovery attempted"],
    ["intentionally-incomplete", "intentionally incomplete (--no-handoff)"],
    ["blocked", "blocked"],
  ] as const)("renders %s distinctly", (outcome, expected) => {
    expect(renderUpdateConvergenceReportText(report(outcome))).toContain(`outcome: ${expected}`);
  });

  it.each([
    ["converged", 0],
    ["actionable", 0],
    ["deferred", 0],
    ["intentionally-incomplete", 0],
    ["blocked", 1],
    ["reap-required", 1],
  ] as const)("maps %s to exit code %i", (outcome, code) => {
    expect(previewUpdateCommandResult(report(outcome), "json").code).toBe(code);
  });

  it("renders every phase and escapes hostile terminal text", () => {
    const text = renderUpdateConvergenceReportText(
      report("actionable", "target\n\u001b[31m\u202e"),
    );
    for (const label of [
      "artifact:",
      "hooks:",
      "Observer:",
      "Host:",
      "terminals:",
      "recovery:",
      "reconcile:",
      "verification:",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("target\\u000a\\u001b[31m\\u202e");
    expect(text).not.toContain("\u001b[31m");
    expect(text).not.toContain("\u202e");
  });

  it.each([
    ["npm-global", ["npm", "install", "-g", "@station/cli@latest"]],
    ["mise", ["mise", "use", "-g", "station@latest"]],
    ["homebrew", ["brew", "upgrade", "station formula"]],
  ] as const)("renders the exact terminal-safe %s manager command", (channel, argv) => {
    const value = report("deferred");
    value.channel = channel;
    value.plan.phases.artifactApplication = {
      action: "defer",
      reason: "package-manager-deferred",
      before: value.current,
      owner: channel,
      command: { kind: "manager", argv },
    };

    const text = renderUpdateConvergenceReportText(value);
    const expected = argv.map((part) => (part.includes(" ") ? `'${part}'` : part)).join(" ");
    expect(text).toContain(`artifact: defer (package-manager-deferred); command: ${expected}`);
  });

  it("renders driven manager argv and both handoff fidelities", () => {
    for (const fidelity of ["processes", "screen"] as const) {
      const value = report("actionable");
      value.channel = "npm-global";
      value.plan.phases.artifactApplication = {
        action: "apply",
        reason: "selected-artifact-different",
        before: value.current,
        owner: "npm-global",
        command: { kind: "manager", argv: ["npm", "install", "-g", "@station/cli@latest"] },
      };
      value.plan.phases.hostConvergence = {
        action: "handoff",
        reason: "busy-different-host",
        fidelity,
      };
      value.plan.phases.terminalConvergence = {
        action: "preserve-via-handoff",
        reason: "bridge-preservation",
        fidelity,
        terminals: [],
      };

      const text = renderUpdateConvergenceReportText(value);
      expect(text).toContain(
        "artifact: apply (selected-artifact-different); command: npm install -g @station/cli@latest",
      );
      expect(text).toContain(`Host: handoff (busy-different-host); fidelity=${fidelity}`);
      expect(text).toContain(
        `terminals: preserve-via-handoff (bridge-preservation); fidelity=${fidelity}`,
      );
    }
  });

  it("retains terminal and session recovery consequences without private identifiers", () => {
    const text = renderUpdateConvergenceReportText(recoveryReport());
    expect(text).toContain("recovery: evidence=complete; authorization=none");
    expect(text).toContain(
      "terminal public-terminal-target-00000001 pty=public-pty-00000001/public-pty-instance-00000001 session=public-session-00000001 handoff=non-preservable reap=non-resumable",
    );
    expect(text).toContain("reasons: session_non_resumable");
    expect(text).toContain("session public-session-00000001 disposition=non-resumable");
    expect(text).toContain("handle=none rejected=0");
    expect(text).toContain("resume capabilities: codex=enabled");
    expect(text).not.toContain("private-session");
  });
});

function recoveryReport(): PreviewReport {
  const value = report("reap-required");
  value.initial.observer = {
    status: "exact",
    buildVersion: "1.0.0",
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
            sessionId: "public-session-00000001",
            projectId: "public-project-00000001",
            worktreeId: "public-worktree-00000001",
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
  };
  value.initial.host = {
    status: "inspected",
    buildVersion: "1.0.0",
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
  };
  value.initial.terminalDispositions = [
    {
      terminalTargetId: "public-terminal-target-00000001",
      ptyId: "public-pty-00000001",
      ptyInstanceId: "public-pty-instance-00000001",
      sessionId: "public-session-00000001",
      handoff: "non-preservable",
      reapRecovery: "non-resumable",
      reasons: ["session_non_resumable"],
    },
  ];
  value.initial.evidenceComplete = true;
  const disposition = value.initial.terminalDispositions[0];
  if (disposition === undefined) throw new Error("Missing recovery disposition fixture.");
  value.plan.phases.terminalConvergence = {
    action: "reap-required",
    reason: "non-preservable-terminals",
    terminals: [
      {
        ...disposition,
        kind: "agent",
        alive: true,
      },
    ],
  };
  return value;
}

function report(outcome: PreviewReport["plan"]["outcome"], targetVersion = "1.1.0"): PreviewReport {
  const phase = { action: "no-op", reason: "healthy" } as const;
  return {
    schemaVersion: 5,
    kind: "preview",
    channel: "installer-binary",
    current: { version: "1.0.0" },
    target: { version: targetVersion },
    initial: {
      schemaVersion: 1,
      boundary: { authorization: "none", actions: "not-included", digest: "not-included" },
      installed: { version: "1.0.0" },
      target: { version: targetVersion },
      observer: { status: "absent" },
      host: { status: "absent" },
      hookProviderIds: [],
      hooks: [],
      parkedBridges: {
        status: "assessed",
        totalParkedCount: 0,
        unownedParkedCount: 0,
        adoptionRequiredCount: 0,
      },
      terminalDispositions: [],
      evidenceComplete: false,
    },
    plan: {
      authorization: "none",
      selectedTarget: {
        artifact: { version: targetVersion },
        runtimeBuild: { status: "not-yet-provable" },
      },
      outcome,
      phases: {
        artifactApplication: {
          action: "apply",
          reason: "selected-artifact-different",
          before: { version: "1.0.0" },
          owner: "installer-binary",
          command: { kind: "none" },
        },
        hookReconciliation: { ...phase, providers: [] },
        observerConvergence: { action: "reinspect", reason: "target-build-not-yet-provable" },
        terminalConvergence: {
          action: "reinspect",
          reason: "target-build-not-yet-provable",
          terminals: [],
        },
        hostConvergence: { action: "reinspect", reason: "target-build-not-yet-provable" },
        persistedStateReconcile: {
          action: "await-artifact",
          reason: "target-build-not-yet-provable",
        },
        finalVerification: { action: "inspect", reason: "after-actions" },
      },
    },
  };
}
