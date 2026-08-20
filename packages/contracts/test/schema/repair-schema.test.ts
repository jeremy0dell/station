import {
  ObserverRepairInventorySchema,
  PersistenceBackupReceiptSchema,
  RecoveryRepairDryRunRequestSchema,
  RepairAuditResultSchema,
  RepairInventorySchema,
  RepairPreviewReportSchema,
  RuntimeRepairDryRunRequestSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

const now = "2026-08-20T12:00:00.000Z";
const digest = "a".repeat(64);
const socketIdentity = { inode: "10", birthtimeNs: "20" };
const processIdentity = {
  pid: 100,
  startToken: "Thu Aug 20 08:00:00 2026",
  executablePath: "/opt/stn",
  argv: ["/opt/stn", "__station-host"],
};
const ownership = {
  component: "observer" as const,
  status: "verified" as const,
  socketPath: "/tmp/observer.sock",
  socketIdentity,
  holderPids: [100],
  process: processIdentity,
  buildVersion: "build-1",
};
const recoveryHandle = {
  id: "handle-1",
  provider: "codex",
  projectId: "project-1",
  worktreeId: "worktree-1",
  sessionId: "session-1",
  targetKind: "native-session" as const,
  observedAt: now,
  lastSeenAt: now,
  disposition: "viable" as const,
  eligible: true,
};

describe("repair schemas", () => {
  it("parses a strict, deterministically ordered aggregate inventory", () => {
    const inventory = {
      schemaVersion: 1,
      capturedAt: now,
      inventoryDigest: digest,
      completeness: "complete",
      observer: ownership,
      host: {
        ...ownership,
        component: "host",
        socketPath: "/tmp/host.sock",
        protocolVersion: 8,
      },
      terminalGroups: [],
      sessions: [
        {
          id: "session-1",
          projectId: "project-1",
          worktreeId: "worktree-1",
          lifecycle: "open",
          harnessProvider: "codex",
          createdAt: now,
          lastSeenAt: now,
        },
      ],
      recoveryHandles: [recoveryHandle],
      findings: [],
    } as const;
    expect(RepairInventorySchema.parse(inventory)).toEqual(inventory);
    expect(RepairInventorySchema.safeParse({ ...inventory, mutationAllowed: true }).success).toBe(
      false,
    );
  });

  it("rejects unsorted arrays and redacted-handle leaks", () => {
    const observerInventory = {
      schemaVersion: 1,
      sessions: [],
      recoveryHandles: [
        { ...recoveryHandle, id: "z" },
        { ...recoveryHandle, id: "a" },
      ],
    };
    expect(ObserverRepairInventorySchema.safeParse(observerInventory).success).toBe(false);
    expect(
      ObserverRepairInventorySchema.safeParse({
        schemaVersion: 1,
        sessions: [],
        recoveryHandles: [{ ...recoveryHandle, cwd: "/private", nativeId: "native-1" }],
      }).success,
    ).toBe(false);
  });

  it("preserves absence for optional recovery metadata", () => {
    const parsed = ObserverRepairInventorySchema.parse({
      schemaVersion: 1,
      sessions: [],
      recoveryHandles: [{ ...recoveryHandle, sessionId: undefined }],
    });
    expect(parsed.recoveryHandles[0]).toHaveProperty("sessionId", undefined);
    const absent = ObserverRepairInventorySchema.parse({
      schemaVersion: 1,
      sessions: [],
      recoveryHandles: [
        {
          ...recoveryHandle,
          id: "handle-2",
          disposition: "missing-session",
          eligible: false,
          reasonCode: "missing-session",
          sessionId: undefined,
        },
      ].map(({ sessionId: _sessionId, ...handle }) => handle),
    });
    expect(absent.recoveryHandles[0]).not.toHaveProperty("sessionId");
  });

  it("requires preview-only requests and exact selection invariants", () => {
    expect(
      RuntimeRepairDryRunRequestSchema.parse({
        schemaVersion: 1,
        dryRun: true,
        expectInventory: digest,
        targetKeys: ["a", "b"],
      }),
    ).toBeDefined();
    expect(
      RuntimeRepairDryRunRequestSchema.safeParse({
        schemaVersion: 1,
        dryRun: false,
        expectInventory: digest,
        targetKeys: ["a"],
      }).success,
    ).toBe(false);
    expect(
      RecoveryRepairDryRunRequestSchema.safeParse({
        schemaVersion: 1,
        dryRun: true,
        expectInventory: digest,
        sessionId: "session-1",
        keepHandleId: "handle-1",
        pruneHandleIds: ["handle-1"],
      }).success,
    ).toBe(false);
  });

  it("prevents previews and audits from claiming mutation", () => {
    const preview = {
      schemaVersion: 1,
      mode: "preview",
      action: "recovery",
      status: "planned",
      inventoryDigest: digest,
      planDigest: digest,
      selectedTargets: ["handle-1"],
      plannedActions: [
        {
          order: 1,
          action: "keep-recovery-handle",
          targetKey: "handle-1",
          handle: recoveryHandle,
        },
      ],
      blockers: [],
      warnings: [],
      recoveryCommands: [["stn", "repair", "recovery", "--dry-run"]],
    } as const;
    expect(RepairPreviewReportSchema.parse(preview)).toEqual(preview);
    expect(
      RepairPreviewReportSchema.safeParse({ ...preview, appliedActions: ["handle-1"] }).success,
    ).toBe(false);

    const audit = {
      schemaVersion: 1,
      auditId: "audit-1",
      mode: "apply",
      action: "recovery",
      status: "completed",
      beforeDigest: digest,
      finalDigest: digest,
      targets: [{ targetKey: "handle-1", status: "applied" }],
      errors: [],
      warnings: [],
      recoveryCommands: [],
    } as const;
    expect(RepairAuditResultSchema.safeParse(audit).success).toBe(false);
    expect(
      RepairAuditResultSchema.parse({
        ...audit,
        backup: PersistenceBackupReceiptSchema.parse({
          path: "/tmp/observer.backup.sqlite",
          createdAt: now,
          sha256: digest,
          byteSize: 100,
          sourceSchema: "observer-sqlite-v16",
        }),
      }),
    ).toBeDefined();
    expect(
      RepairAuditResultSchema.safeParse({
        ...audit,
        mode: "preview",
        status: "planned",
        targets: [{ targetKey: "handle-1", status: "applied" }],
      }).success,
    ).toBe(false);
  });
});
