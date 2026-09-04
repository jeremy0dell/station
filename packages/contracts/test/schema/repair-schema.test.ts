import {
  RepairAuditSchema,
  RepairBackupSchema,
  RepairInventorySchema,
  RepairJournalSchema,
  RepairPlanSchema,
  RepairRecoveryMutationProofSchema,
  RepairResultSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const digest = "a".repeat(64);
const now = "2026-09-04T12:00:00.000Z";
const error = {
  tag: "RepairInventoryError",
  code: "REPAIR_RUNTIME_INVENTORY_UNAVAILABLE",
  message: "Runtime repair inventory is unavailable.",
};
const inventory = {
  schemaVersion: 1 as const,
  configuredStateScopeDigest: digest,
  runtime: { status: "unavailable" as const, error },
  recovery: {
    status: "available" as const,
    assessment: {
      schemaVersion: 1 as const,
      inventory: { schemaVersion: 1 as const, sessions: [], recoveryHandles: [] },
      resumeEnabled: true,
      providerCapabilities: [],
      sessions: [],
    },
    recoveryInventoryDigest: "b".repeat(64),
  },
  repairInventoryDigest: "c".repeat(64),
};
const action = { kind: "observer-cleanup" as const };
const plan = {
  schemaVersion: 1 as const,
  authorization: "none" as const,
  action,
  inventoryDigest: inventory.repairInventoryDigest,
  configuredStateScopeDigest: digest,
  status: "refused" as const,
  reason: "runtime-unavailable" as const,
  detail: "Runtime inventory is unavailable.",
  recoveryCommands: [["stn", "repair", "inventory"]] as const,
  repairPlanDigest: "d".repeat(64),
};

describe("repair schemas", () => {
  it("strictly parses inventory, non-authorizing plans, and redacted results", () => {
    expect(RepairInventorySchema.parse(inventory)).toEqual(inventory);
    expect(RepairPlanSchema.parse(plan)).toEqual(plan);
    expect(
      RepairResultSchema.parse({
        schemaVersion: 1,
        kind: "result",
        status: "refused",
        action,
        planDigest: plan.repairPlanDigest,
        inventoryDigest: inventory.repairInventoryDigest,
        recoveryCommands: [["stn", "repair", "observer", "cleanup"]],
      }),
    ).not.toHaveProperty("path");
    expect(RepairPlanSchema.safeParse({ ...plan, authorization: "signal" }).success).toBe(false);
  });

  it("separates backup content and recovery inventory digests", () => {
    const backup = {
      schemaVersion: 1 as const,
      id: "00000000-0000-4000-8000-000000000001",
      contentDigest: "e".repeat(64),
      recoveryInventoryDigest: "f".repeat(64),
    };
    expect(RepairBackupSchema.parse(backup)).toEqual(backup);
    expect(
      RepairBackupSchema.safeParse({
        ...backup,
        path: "/private/observer.sqlite",
      }).success,
    ).toBe(false);
  });

  it("keeps private process authority only in a mode-protected terminal journal", () => {
    const journal = {
      schemaVersion: 1 as const,
      id: "00000000-0000-4000-8000-000000000002",
      auditId: "00000000-0000-4000-8000-000000000003",
      planDigest: plan.repairPlanDigest,
      inventoryDigest: inventory.repairInventoryDigest,
      configuredStateScopeDigest: digest,
      action,
      phase: "mutation-started" as const,
      createdAt: now,
      updatedAt: now,
    };
    expect(RepairJournalSchema.parse(journal)).toEqual(journal);
    expect(RepairJournalSchema.safeParse({ ...journal, pid: 99 }).success).toBe(false);
  });

  it("binds recovery mutation proof to exact private transaction identities", () => {
    const backup = {
      schemaVersion: 1 as const,
      id: "00000000-0000-4000-8000-000000000001",
      contentDigest: "e".repeat(64),
      recoveryInventoryDigest: "f".repeat(64),
    };
    const proof = {
      journalId: "00000000-0000-4000-8000-000000000002",
      auditId: "00000000-0000-4000-8000-000000000003",
      planDigest: plan.repairPlanDigest,
      inventoryDigest: inventory.repairInventoryDigest,
      expectedRecoveryInventoryDigest: backup.recoveryInventoryDigest,
      backup,
    };
    expect(RepairRecoveryMutationProofSchema.parse(proof)).toEqual(proof);
    expect(RepairRecoveryMutationProofSchema.safeParse({ ...proof, pid: 99 }).success).toBe(false);
  });

  it("accepts durable in-progress and finalized redacted audits", () => {
    const audit = {
      schemaVersion: 1 as const,
      id: "00000000-0000-4000-8000-000000000003",
      action,
      planDigest: plan.repairPlanDigest,
      inventoryDigest: inventory.repairInventoryDigest,
      status: "in-progress" as const,
      errorCodes: [],
      recoveryCommands: [["stn", "repair", "observer", "cleanup"]] as const,
      createdAt: now,
      updatedAt: now,
    };
    expect(RepairAuditSchema.parse(audit)).toEqual(audit);
    expect(RepairAuditSchema.safeParse({ ...audit, socketPath: "/private/socket" }).success).toBe(
      false,
    );
    expect(
      RepairAuditSchema.parse({
        ...audit,
        status: "completed",
        recoveryCommands: [],
      }),
    ).toBeDefined();
  });
});
