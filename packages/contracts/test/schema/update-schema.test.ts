import {
  UpdateArtifactApplicationSchema,
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandReportSchema,
  UpdateInstallMutationSchema,
  updateCommandReportStatus,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const reportCore = {
  channel: "installer-binary" as const,
  status: "updated" as const,
  current: { version: "0.0.0-local" },
  target: { version: "0.0.1-local", revision: "abc123" },
  warnings: [],
  recoveryCommands: [],
};

const recoveryPreflight = {
  schemaVersion: 2 as const,
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

const digest = "a".repeat(64);
const currentPreflight = {
  ...recoveryPreflight,
  installed: reportCore.target,
  observer: {
    status: "exact" as const,
    buildVersion:
      "0.0.1-local+station.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    relation: "matching-target" as const,
    replacementAdmission: "exact-build" as const,
    health: "healthy" as const,
    recovery: {
      status: "unknown" as const,
      reason: "api-unavailable" as const,
      error: { tag: "UpdatePreflightError", code: "UNAVAILABLE", message: "Unavailable." },
    },
  },
};
const currentPlan = {
  schemaVersion: 1 as const,
  selectedTarget: {
    artifact: reportCore.target,
    buildIdentity: { status: "known" as const, value: digest },
  },
  installation: { owner: "installer-binary" as const, action: "no-op" as const },
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
const actionablePlan = {
  ...currentPlan,
  status: "actionable" as const,
  components: {
    ...currentPlan.components,
    observer: { action: "start" as const, reason: "absent" as const },
    reconcile: { action: "run" as const, reason: "runtime-change" as const },
    verification: {
      action: "reinspect" as const,
      reason: "reinspect-after-actions" as const,
    },
  },
  phases: currentPlan.phases.map((phase) =>
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
const currentReport = {
  schemaVersion: 4 as const,
  channel: reportCore.channel,
  status: "current" as const,
  current: reportCore.target,
  target: reportCore.target,
  artifactApplication: { status: "not-required" as const },
  initial: { evaluator: "successor-cli" as const, preflight: currentPreflight, plan: currentPlan },
  result: {
    kind: "already-converged" as const,
    verification: { status: "converged" as const, source: "initial" as const, planDigest: digest },
  },
  warnings: [],
  recoveryCommands: [],
};

describe("update command schemas", () => {
  it("keeps install owner, action, and manager argv one strict commitment", () => {
    const managerCommand = ["brew", "upgrade", "station"] as const;
    expect(
      UpdateInstallMutationSchema.parse({
        owner: "homebrew",
        action: "defer",
        managerCommand,
      }),
    ).toEqual({ owner: "homebrew", action: "defer", managerCommand });
    expect(
      UpdateInstallMutationSchema.safeParse({ owner: "installer-binary", action: "defer" }).success,
    ).toBe(false);
    expect(
      UpdateInstallMutationSchema.safeParse({ owner: "homebrew", action: "apply" }).success,
    ).toBe(false);
    expect(
      UpdateInstallMutationSchema.safeParse({
        owner: "installer-binary",
        action: "apply",
        managerCommand,
      }).success,
    ).toBe(false);
  });

  it("parses only the current strict output", () => {
    expect(UpdateCommandReportSchema.parse(currentReport)).toEqual(currentReport);
    for (const schemaVersion of [1, 2, 3]) {
      expect(UpdateCommandReportSchema.safeParse({ ...currentReport, schemaVersion }).success).toBe(
        false,
      );
    }
    expect(
      UpdateCommandReportSchema.safeParse({
        schemaVersion: 3,
        channel: currentReport.channel,
        status: "updated",
        current: currentReport.current,
        target: currentReport.target,
        steps: [],
        warnings: [],
        recoveryCommands: [],
      }).success,
    ).toBe(false);
  });

  it("retains normalized failure evidence without requiring unavailable post-action inspection", () => {
    const failed = {
      ...currentReport,
      status: "failed" as const,
      initial: {
        evaluator: "successor-cli" as const,
        preflight: { ...currentPreflight, observer: { status: "absent" as const } },
        plan: actionablePlan,
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
        ...currentReport,
        error: { tag: "UpdateError", code: "UNEXPECTED", message: "Unexpected." },
      }).success,
    ).toBe(false);
    expect(UpdateCommandReportSchema.parse(currentReport)).not.toHaveProperty("error");
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
    for (const stage of [
      "artifact-application",
      "hook-reconciliation",
      "terminal-convergence",
      "host-convergence",
      "runtime-reconcile",
      "verification",
      "successor-boundary",
    ] as const) {
      const wrongStage = structuredClone(failed);
      if (wrongStage.result.kind !== "execution-failed") throw new Error("expected failure");
      wrongStage.result.stage = stage;
      expect(UpdateCommandReportSchema.safeParse(wrongStage).success).toBe(false);
    }
    expect(
      UpdateCommandReportSchema.safeParse({
        ...currentReport,
        cause: failed.cause,
        startupEvidence: failed.startupEvidence,
      }).success,
    ).toBe(false);
  });

  it("rejects successful execution reports whose fresh verification remains actionable", () => {
    const stillActionable = {
      ...currentReport,
      status: "failed" as const,
      initial: {
        evaluator: "successor-cli" as const,
        preflight: { ...currentPreflight, observer: { status: "absent" as const } },
        plan: actionablePlan,
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
          plan: actionablePlan,
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
      ...currentReport,
      artifactApplication: { status: "preview" as const },
      result: {
        kind: "preview" as const,
        planDigest: digest,
        phases: currentPlan.phases.map((phase) => ({
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
        ...currentReport,
        initial: {
          ...currentReport.initial,
          plan: {
            ...currentPlan,
            selectedTarget: {
              ...currentPlan.selectedTarget,
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
      ...currentReport,
      channel: "homebrew" as const,
      initial: {
        ...currentReport.initial,
        plan: {
          ...currentReport.initial.plan,
          installation: {
            owner: "homebrew" as const,
            action: "no-op" as const,
            managerCommand,
          },
        },
      },
      artifactApplication: { status: "preview" as const, managerCommand },
      result: {
        kind: "preview" as const,
        planDigest: digest,
        phases: currentPlan.phases.map((phase) => ({
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
      UpdateCommandReportSchema.safeParse({
        ...managerPreview,
        initial: {
          ...managerPreview.initial,
          plan: {
            ...managerPreview.initial.plan,
            installation: {
              ...managerPreview.initial.plan.installation,
              managerCommand: ["brew", "upgrade", "different-package"] as const,
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateArtifactApplicationSchema.safeParse({
        status: "applied",
        managerCommand,
      }).success,
    ).toBe(false);
    expect(currentReport.artifactApplication).not.toHaveProperty("managerCommand");
  });

  it("rejects plan install owners or actions that contradict the selected channel and artifact", () => {
    expect(
      UpdateCommandReportSchema.safeParse({
        ...currentReport,
        initial: {
          ...currentReport.initial,
          plan: {
            ...currentReport.initial.plan,
            installation: { owner: "dev-checkout" as const, action: "no-op" as const },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({
        ...currentReport,
        initial: {
          ...currentReport.initial,
          plan: {
            ...currentReport.initial.plan,
            installation: { owner: "installer-binary" as const, action: "apply" as const },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the current report strict and rejects removed report fields", () => {
    expect(UpdateCommandReportSchema.safeParse({ ...currentReport, extra: true }).success).toBe(
      false,
    );
    expect(UpdateCommandReportSchema.safeParse({ ...currentReport, steps: [] }).success).toBe(
      false,
    );
    expect(
      UpdateCommandReportSchema.safeParse({ ...currentReport, hookReconciliation: {} }).success,
    ).toBe(false);
  });

  it("keeps private convergence evidence out of current strict serialization", () => {
    expect(
      UpdateCommandReportSchema.safeParse({
        ...currentReport,
        observerProcessToken: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      }).success,
    ).toBe(false);
    expect(
      UpdateCommandReportSchema.safeParse({
        ...currentReport,
        initial: {
          ...currentReport.initial,
          plan: { ...currentPlan, selectedRecoveryHandleId: "station-private-handle" },
        },
      }).success,
    ).toBe(false);
    expect(JSON.stringify(UpdateCommandReportSchema.parse(currentReport))).not.toMatch(
      /processToken|selectedHandleId|providerData|nativeHandle|\/private\//u,
    );
  });

  it("rejects unknown channels and empty commands", () => {
    expect(UpdateChannelIdSchema.safeParse("unknown").success).toBe(false);
    expect(UpdateCommandArgvSchema.safeParse([""]).success).toBe(false);
    expect(UpdateCommandArgvSchema.parse(["stn", "update"])).toEqual(["stn", "update"]);
  });
});
