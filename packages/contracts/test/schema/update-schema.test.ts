import {
  CompatibleUpdateCommandReportSchema,
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandReportSchema,
  UpdateCommandReportV1Schema,
  UpdateCommandReportV2Schema,
  UpdateCommandReportV3Schema,
  UpdateCommandStepSchema,
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

describe("update command schemas", () => {
  it("parses strict v3 output and retains explicit v1/v2 compatible parsers", () => {
    expect(UpdateCommandReportSchema.parse(reportV3)).toEqual(reportV3);
    expect(UpdateCommandReportV3Schema.parse(reportV3)).toEqual(reportV3);
    expect(UpdateCommandReportV2Schema.parse(reportV2)).toEqual(reportV2);
    expect(UpdateCommandReportV1Schema.parse(reportV1)).toEqual(reportV1);
    for (const report of [reportV1, reportV2, reportV3]) {
      expect(CompatibleUpdateCommandReportSchema.parse(report)).toEqual(report);
    }
  });

  it("retains optional lifecycle evidence without explicit undefined fields", () => {
    const failed = {
      ...reportV3,
      status: "failed" as const,
      error: { tag: "UpdateError", code: "UPDATE_RUNTIME_CROSSOVER_FAILED", message: "Failed." },
      cause: {
        tag: "ObserverProcessIdentityError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Mismatch.",
      },
      startupEvidence: { bootLogPath: "/tmp/station/logs/observer-boot.log" },
    };
    expect(UpdateCommandReportSchema.parse(failed)).toEqual(failed);
    expect(UpdateCommandReportSchema.parse(reportV3)).not.toHaveProperty("error");
  });

  it("keeps report versions strict and prevents preflight or hook fields from backporting", () => {
    expect(UpdateCommandReportSchema.safeParse({ ...reportV3, extra: true }).success).toBe(false);
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
  });

  it("rejects unknown channels and empty commands", () => {
    expect(UpdateChannelIdSchema.safeParse("unknown").success).toBe(false);
    expect(UpdateCommandArgvSchema.safeParse([""]).success).toBe(false);
    expect(UpdateCommandArgvSchema.parse(["stn", "update"])).toEqual(["stn", "update"]);
  });
});
