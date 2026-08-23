import {
  CompatibleUpdateCommandReportSchema,
  UpdateArtifactApplicationSchema,
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandReportSchema,
  UpdateCommandReportV1Schema,
  UpdateCommandReportV2Schema,
  UpdateCommandReportV3Schema,
  UpdateCommandReportV4Schema,
  UpdateCommandStepSchema,
  updateCommandReportStatus,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const reportCore = {
  channel: "installer-binary" as const,
  status: "updated" as const,
  current: { version: "0.0.0-local" },
  target: { version: "0.0.1-local", revision: "abc123" },
  steps: [
    { id: "detect" as const, status: "completed" as const, detail: "Detected ownership." },
    { id: "plan" as const, status: "completed" as const, detail: "Resolved builds." },
    { id: "apply" as const, status: "completed" as const, detail: "Installed target." },
    {
      id: "hook-reconciliation" as const,
      status: "completed" as const,
      detail: "Verified provider hooks.",
    },
    {
      id: "observer-restart" as const,
      status: "completed" as const,
      detail: "Restarted Observer.",
    },
    {
      id: "host-handoff" as const,
      status: "completed" as const,
      detail: "Handed off Host.",
    },
  ],
  warnings: [],
  recoveryCommands: [],
  hookReconciliation: {
    provider: "codex",
    status: "healthy" as const,
    changed: false,
    verified: true,
  },
};

const recoveryPreflight = {
  schemaVersion: 1 as const,
  boundary: {
    authorization: "none" as const,
    actions: "not-included" as const,
    digest: "not-included" as const,
  },
  installed: reportCore.current,
  target: reportCore.target,
  observer: { status: "absent" as const },
  host: { status: "absent" as const },
  hookProviderIds: [],
  hooks: [],
  terminalDispositions: [],
  evidenceComplete: false,
};

const reportV3 = { schemaVersion: 3 as const, ...reportCore, recoveryPreflight };
const reportV2 = { schemaVersion: 2 as const, ...reportCore };
const reportV1 = {
  schemaVersion: 1 as const,
  channel: reportCore.channel,
  status: reportCore.status,
  current: reportCore.current,
  target: reportCore.target,
  steps: reportCore.steps.filter((step) => step.id !== "hook-reconciliation"),
  warnings: reportCore.warnings,
  recoveryCommands: reportCore.recoveryCommands,
};

const digest = "a".repeat(64);
const currentPreflight = {
  ...recoveryPreflight,
  installed: reportCore.target,
  observer: {
    status: "exact" as const,
    buildVersion:
      "0.0.1-local+station.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    relation: "matching-target" as const,
    health: "healthy" as const,
    recovery: {
      status: "unknown" as const,
      reason: "api-unavailable" as const,
      error: { tag: "UpdatePreflightError", code: "UNAVAILABLE", message: "Unavailable." },
    },
  },
};
const planV4 = {
  schemaVersion: 1 as const,
  selectedTarget: {
    artifact: reportCore.target,
    buildIdentity: { status: "known" as const, value: digest },
  },
  status: "converged" as const,
  digest: { algorithm: "sha256" as const, canonicalizationVersion: 1 as const, value: digest },
  components: {
    hooks: [],
    observer: { action: "no-op" as const, reason: "matching-healthy" as const },
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
      reason: "no-terminals" as const,
    },
    { id: "host-convergence" as const, action: "no-op" as const, reason: "absent" as const },
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
const actionablePlanV4 = {
  ...planV4,
  status: "actionable" as const,
  components: {
    ...planV4.components,
    observer: { action: "start" as const, reason: "absent" as const },
    reconcile: { action: "run" as const, reason: "runtime-change" as const },
    verification: {
      action: "reinspect" as const,
      reason: "reinspect-after-actions" as const,
    },
  },
  phases: planV4.phases.map((phase) =>
    phase.id === "observer-convergence"
      ? { ...phase, action: "start" as const, reason: "absent" as const }
      : phase.id === "runtime-reconcile"
        ? { ...phase, action: "run" as const, reason: "runtime-change" as const }
        : phase.id === "verification"
          ? {
              ...phase,
              action: "reinspect" as const,
              reason: "reinspect-after-actions" as const,
            }
          : phase,
  ),
};
const reportV4 = {
  schemaVersion: 4 as const,
  channel: reportCore.channel,
  status: "current" as const,
  current: reportCore.target,
  target: reportCore.target,
  artifactApplication: { status: "not-required" as const },
  initial: { evaluator: "successor-cli" as const, preflight: currentPreflight, plan: planV4 },
  result: {
    kind: "already-converged" as const,
    verification: { status: "converged" as const, source: "initial" as const, planDigest: digest },
  },
  warnings: [],
  recoveryCommands: [],
};

describe("update command schemas", () => {
  it("parses strict v4 output and retains explicit v1/v2/v3 compatible parsers", () => {
    expect(UpdateCommandReportSchema.parse(reportV4)).toEqual(reportV4);
    expect(UpdateCommandReportV4Schema.parse(reportV4)).toEqual(reportV4);
    expect(UpdateCommandReportV3Schema.parse(reportV3)).toEqual(reportV3);
    expect(UpdateCommandReportV2Schema.parse(reportV2)).toEqual(reportV2);
    expect(UpdateCommandReportV1Schema.parse(reportV1)).toEqual(reportV1);
    for (const report of [reportV1, reportV2, reportV3, reportV4]) {
      expect(CompatibleUpdateCommandReportSchema.parse(report)).toEqual(report);
    }
  });

  it("retains normalized failure evidence without requiring unavailable post-action inspection", () => {
    const failed = {
      ...reportV4,
      status: "failed" as const,
      initial: {
        evaluator: "successor-cli" as const,
        preflight: { ...currentPreflight, observer: { status: "absent" as const } },
        plan: actionablePlanV4,
      },
      result: {
        kind: "execution-failed" as const,
        stage: "observer-convergence" as const,
        actionAudits: [
          {
            executor: "successor-cli" as const,
            planDigest: digest,
            actions: [
              {
                phase: "observer-convergence" as const,
                action: "start" as const,
                status: "failed" as const,
              },
            ],
          },
        ],
        finalInspection: {
          status: "failed" as const,
          error: { tag: "UpdatePreflightError", code: "FINAL_FAILED", message: "Failed." },
        },
      },
      error: { tag: "UpdateError", code: "UPDATE_RUNTIME_CROSSOVER_FAILED", message: "Failed." },
      cause: {
        tag: "ObserverProcessIdentityError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Observer executable arguments did not match.",
      },
      startupEvidence: {
        bootLogPath: "/tmp/station/logs/observer-boot.log",
        bootLogTail: "API_TOKEN=[REDACTED]",
      },
    };
    expect(UpdateCommandReportSchema.parse(failed)).toEqual(failed);
    const { error: omittedError, ...withoutError } = failed;
    expect(omittedError).toBeDefined();
    expect(UpdateCommandReportSchema.safeParse(withoutError).success).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({
        ...reportV4,
        error: { tag: "UpdateError", code: "UNEXPECTED", message: "Unexpected." },
      }).success,
    ).toBe(false);
    expect(UpdateCommandReportSchema.parse(reportV4)).not.toHaveProperty("error");
    expect(
      UpdateCommandReportSchema.safeParse({
        ...failed,
        cause: { ...failed.cause, stack: "private stack" },
      }).success,
    ).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({
        ...failed,
        startupEvidence: { ...failed.startupEvidence, providerData: { token: "private" } },
      }).success,
    ).toBe(false);
  });

  it("rejects successful execution reports whose fresh verification remains actionable", () => {
    const stillActionable = {
      ...reportV4,
      status: "failed" as const,
      initial: {
        evaluator: "successor-cli" as const,
        preflight: { ...currentPreflight, observer: { status: "absent" as const } },
        plan: actionablePlanV4,
      },
      result: {
        kind: "current-runtime-execution" as const,
        actionAudits: [
          {
            executor: "successor-cli" as const,
            planDigest: digest,
            actions: [
              {
                phase: "observer-convergence" as const,
                action: "start" as const,
                status: "completed" as const,
              },
              {
                phase: "runtime-reconcile" as const,
                action: "run" as const,
                status: "completed" as const,
              },
            ],
          },
        ],
        postAction: {
          evaluator: "successor-cli" as const,
          preflight: { ...currentPreflight, observer: { status: "absent" as const } },
          plan: actionablePlanV4,
        },
        verification: {
          status: "not-converged" as const,
          source: "post-action" as const,
          planDigest: digest,
          disposition: "actionable" as const,
        },
      },
    };

    expect(updateCommandReportStatus(stillActionable)).toBe("failed");
    const parsed = UpdateCommandReportSchema.safeParse(stillActionable);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        "Executed convergence with remaining actions must use a verification-stage failure.",
      );
    }
  });

  it("enforces canonical non-executed phases and installed target build knowledge", () => {
    const preview = {
      ...reportV4,
      artifactApplication: { status: "preview" as const },
      result: {
        kind: "preview" as const,
        planDigest: digest,
        phases: planV4.phases.map((phase) => ({
          id: phase.id,
          status: "not-executed" as const,
        })),
        verification: {
          status: "converged" as const,
          source: "initial" as const,
          planDigest: digest,
        },
      },
    };
    expect(UpdateCommandReportSchema.parse(preview)).toEqual(preview);
    const reversed = [...preview.result.phases].reverse();
    expect(
      UpdateCommandReportSchema.safeParse({
        ...preview,
        result: { ...preview.result, phases: reversed },
      }).success,
    ).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({
        ...reportV4,
        initial: {
          ...reportV4.initial,
          plan: {
            ...planV4,
            selectedTarget: {
              ...planV4.selectedTarget,
              buildIdentity: { status: "not-yet-provable" as const },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("retains manager argv only on manager-owned preview or deferral", () => {
    const managerCommand = [
      "/opt/homebrew/bin/brew",
      "upgrade",
      "--formula",
      "jeremy0dell/station/station",
    ] as const;
    const managerPreview = {
      ...reportV4,
      channel: "homebrew" as const,
      artifactApplication: { status: "preview" as const, managerCommand },
      result: {
        kind: "preview" as const,
        planDigest: digest,
        phases: planV4.phases.map((phase) => ({
          id: phase.id,
          status: "not-executed" as const,
        })),
        verification: {
          status: "converged" as const,
          source: "initial" as const,
          planDigest: digest,
        },
      },
    };

    expect(UpdateCommandReportSchema.parse(managerPreview)).toEqual(managerPreview);
    expect(UpdateArtifactApplicationSchema.parse({ status: "deferred", managerCommand })).toEqual({
      status: "deferred",
      managerCommand,
    });
    expect(
      UpdateArtifactApplicationSchema.parse({ status: "preview", managerCommand: undefined }),
    ).toEqual({ status: "preview" });
    expect(
      UpdateCommandReportSchema.safeParse({
        ...managerPreview,
        artifactApplication: { status: "preview" as const },
      }).success,
    ).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({
        ...managerPreview,
        channel: "installer-binary" as const,
      }).success,
    ).toBe(false);
    expect(
      UpdateArtifactApplicationSchema.safeParse({
        status: "applied",
        managerCommand,
      }).success,
    ).toBe(false);
    expect(reportV4.artifactApplication).not.toHaveProperty("managerCommand");
  });

  it("keeps report versions strict and prevents preflight or hook fields from backporting", () => {
    expect(UpdateCommandReportSchema.safeParse({ ...reportV4, extra: true }).success).toBe(false);
    expect(UpdateCommandReportV3Schema.safeParse(reportV2).success).toBe(false);
    expect(UpdateCommandReportV2Schema.safeParse(reportV3).success).toBe(false);
    expect(
      UpdateCommandReportV1Schema.safeParse({
        ...reportV1,
        hookReconciliation: reportCore.hookReconciliation,
      }).success,
    ).toBe(false);
    expect(UpdateCommandReportV1Schema.safeParse(reportV2).success).toBe(false);
    expect(UpdateCommandStepSchema.safeParse({ ...reportCore.steps[0], extra: true }).success).toBe(
      false,
    );
    expect(
      UpdateCommandReportV3Schema.safeParse({
        ...reportV3,
        recoveryPreflight: {
          ...recoveryPreflight,
          target: { version: "contradictory-target" },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps private convergence evidence out of strict v4 serialization", () => {
    expect(
      UpdateCommandReportSchema.safeParse({
        ...reportV4,
        observerProcessToken: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      }).success,
    ).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({
        ...reportV4,
        initial: {
          ...reportV4.initial,
          plan: { ...planV4, selectedRecoveryHandleId: "station-private-handle" },
        },
      }).success,
    ).toBe(false);
    expect(JSON.stringify(UpdateCommandReportSchema.parse(reportV4))).not.toMatch(
      /processToken|selectedHandleId|providerData|nativeHandle|\/private\//u,
    );
  });

  it("rejects unknown channels and empty commands", () => {
    expect(UpdateChannelIdSchema.safeParse("unknown").success).toBe(false);
    expect(UpdateCommandArgvSchema.safeParse([""]).success).toBe(false);
    expect(UpdateCommandArgvSchema.parse(["stn", "update"])).toEqual(["stn", "update"]);
  });
});
