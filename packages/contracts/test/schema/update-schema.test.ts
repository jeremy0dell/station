import {
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandReportSchema,
  UpdateCommandStepSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const report = {
  schemaVersion: 2,
  channel: "installer-binary",
  status: "updated",
  current: { version: "0.0.0-local" },
  target: { version: "0.0.1-local", revision: "abc123" },
  steps: [
    { id: "detect", status: "completed", detail: "Detected installer ownership." },
    { id: "plan", status: "completed", detail: "Resolved builds." },
    { id: "apply", status: "completed", detail: "Installed target." },
    {
      id: "hook-reconciliation",
      status: "completed",
      detail: "Verified provider hooks.",
    },
    { id: "observer-restart", status: "completed", detail: "Restarted Observer." },
    { id: "host-handoff", status: "completed", detail: "Handed off Host." },
  ],
  warnings: [],
  recoveryCommands: [],
  hookReconciliation: {
    provider: "codex",
    status: "healthy",
    changed: false,
    verified: true,
  },
} as const;

describe("update command schemas", () => {
  it("parses the strict schema-version-2 report contract", () => {
    expect(UpdateCommandReportSchema.parse(report)).toEqual(report);
    const failed = {
      ...report,
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
  });

  it("rejects unknown report and step fields", () => {
    expect(UpdateCommandReportSchema.safeParse({ ...report, extra: true }).success).toBe(false);
    expect(UpdateCommandStepSchema.safeParse({ ...report.steps[0], extra: true }).success).toBe(
      false,
    );
  });

  it("rejects the superseded schema version", () => {
    expect(UpdateCommandReportSchema.safeParse({ ...report, schemaVersion: 1 }).success).toBe(
      false,
    );
  });

  it("rejects unknown channels and empty commands", () => {
    expect(UpdateChannelIdSchema.safeParse("unknown").success).toBe(false);
    expect(UpdateCommandArgvSchema.safeParse([""]).success).toBe(false);
    expect(UpdateCommandArgvSchema.parse(["stn", "update"])).toEqual(["stn", "update"]);
  });
});
