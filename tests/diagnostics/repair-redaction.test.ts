import { describe, expect, it } from "vitest";
import { RepairAuditSchema, RepairResultSchema } from "../../packages/contracts/src/index.js";

describe("repair redaction", () => {
  it("rejects raw runtime and provider identity at public and audit boundaries", () => {
    const base = {
      schemaVersion: 1 as const,
      kind: "result" as const,
      status: "completed" as const,
      action: { kind: "observer-cleanup" as const },
      planDigest: "a".repeat(64),
      inventoryDigest: "b".repeat(64),
      recoveryCommands: [],
    };
    for (const raw of [
      { pid: 42 },
      { pgid: 42 },
      { socketPath: "/private/observer.sock" },
      { providerTarget: "native-secret" },
      { transcript: "secret" },
    ]) {
      expect(RepairResultSchema.safeParse({ ...base, ...raw }).success).toBe(false);
    }
    expect(
      RepairAuditSchema.safeParse({
        schemaVersion: 1,
        id: "00000000-0000-4000-8000-000000000001",
        action: {
          kind: "recovery-prune",
          recoveryHandleId: "handle-1",
          projectId: "p",
          worktreeId: "w",
          sessionId: "s",
          provider: "codex",
        },
        planDigest: "a".repeat(64),
        inventoryDigest: "b".repeat(64),
        status: "completed",
        errorCodes: [],
        recoveryCommands: [],
        createdAt: "2026-09-04T12:00:00.000Z",
        updatedAt: "2026-09-04T12:00:00.000Z",
        path: "/private/backup.sqlite",
      }).success,
    ).toBe(false);
  });
});
