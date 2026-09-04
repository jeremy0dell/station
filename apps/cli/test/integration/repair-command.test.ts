import { runCli } from "@station/cli";
import type { RepairInventory, RepairPlan } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTempState, writeConfigToml } from "../../../../tests/support/temp-projects";
import type { RepairExecutionDeps } from "../../src/repair/execution.js";

const digest = "a".repeat(64);
const planDigest = "b".repeat(64);

describe("registered stn repair command", () => {
  it("routes inventory and preview without any mutation capability", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const deps = fakeDeps();
    const inventory = await runCli(["--config", configPath, "repair", "inventory", "--json"], {
      repairDeps: deps,
    });
    const preview = await runCli(
      ["--config", configPath, "repair", "observer", "cleanup", "--json"],
      { repairDeps: deps },
    );
    expect(inventory).toMatchObject({ code: 0, output: { kind: "inventory" } });
    expect(preview).toMatchObject({
      code: 0,
      output: {
        kind: "preview",
        plan: { authorization: "none", repairPlanDigest: planDigest },
      },
    });
    expect(deps.journal.withLock).not.toHaveBeenCalled();
    expect(deps.cleanupObserver).not.toHaveBeenCalled();
    expect(deps.backup.create).not.toHaveBeenCalled();
    expect(deps.audit.start).not.toHaveBeenCalled();
  });

  it("requires and applies the exact copied preview digest", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    const deps = fakeDeps();
    const result = await runCli(
      [
        "--config",
        configPath,
        "repair",
        "observer",
        "cleanup",
        "--yes",
        "--expect-plan",
        planDigest,
        "--json",
      ],
      { repairDeps: deps },
    );
    expect(result).toMatchObject({
      code: 0,
      output: { kind: "result", status: "completed" },
    });
    expect(deps.cleanupObserver).toHaveBeenCalledOnce();
    expect(deps.audit.start).toHaveBeenCalledOnce();
  });

  it("renders repair help without loading config", async () => {
    const result = await runCli(["--config", "/missing/config.toml", "repair", "--help"]);
    expect(result).toMatchObject({ code: 0, outputFormat: "text" });
    expect(result.output).toContain("--yes --expect-plan");
  });
});

function fakeDeps(): RepairExecutionDeps {
  const inventory: RepairInventory = {
    schemaVersion: 1,
    configuredStateScopeDigest: "c".repeat(64),
    runtime: {
      status: "available",
      preflight: {
        schemaVersion: 1,
        boundary: {
          authorization: "none",
          actions: "not-included",
          digest: "not-included",
        },
        installed: { version: "1.0.0" },
        target: { version: "1.0.0" },
        observer: {
          status: "unknown",
          reason: "stale-socket",
          error: { tag: "Stale", code: "STALE", message: "Stale." },
        },
        host: { status: "absent" },
        hookProviderIds: [],
        hooks: [],
        terminalDispositions: [],
        parkedBridges: {
          status: "assessed",
          totalParkedCount: 0,
          unownedParkedCount: 0,
          adoptionRequiredCount: 0,
        },
        evidenceComplete: false,
      },
    },
    recovery: {
      status: "unavailable",
      error: {
        tag: "Unavailable",
        code: "UNAVAILABLE",
        message: "Unavailable.",
      },
    },
    repairInventoryDigest: digest,
  };
  const plan: RepairPlan = {
    schemaVersion: 1,
    authorization: "none",
    action: { kind: "observer-cleanup" },
    inventoryDigest: digest,
    configuredStateScopeDigest: inventory.configuredStateScopeDigest,
    status: "ready",
    reason: "ready",
    detail: "Ready.",
    recoveryCommands: [],
    repairPlanDigest: planDigest,
  };
  let journal: import("@station/contracts").RepairJournal | undefined;
  let currentAudit: import("@station/contracts").RepairAudit | undefined;
  return {
    inspectInventory: vi.fn(async () => inventory),
    derivePlan: vi.fn(() => plan),
    journal: {
      findIncomplete: vi.fn(async () => journal),
      findByAuditId: vi.fn(async (auditId) => (journal?.auditId === auditId ? journal : undefined)),
      write: vi.fn(async (next) => {
        journal = next;
      }),
      withLock: vi.fn(async (run) => run()),
    },
    audit: {
      findInProgress: vi.fn(async () =>
        currentAudit?.status === "in-progress" ? currentAudit : undefined,
      ),
      read: vi.fn(async () => {
        if (currentAudit === undefined) throw new Error("Audit was not started.");
        return currentAudit;
      }),
      start: vi.fn(async (input) => {
        currentAudit = {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000001",
          ...input,
          status: "in-progress",
          createdAt: "2026-09-04T12:00:00.000Z",
          updatedAt: "2026-09-04T12:00:00.000Z",
        };
        return currentAudit;
      }),
      finalize: vi.fn(async (audit, update) => {
        currentAudit = { ...audit, ...update };
        return currentAudit;
      }),
    },
    updateReapJournal: { withLock: vi.fn(async (run) => run()) },
    backup: { create: vi.fn() },
    authorizeTerminal: vi.fn(),
    reapTerminal: vi.fn(),
    cleanupObserver: vi.fn(async () => undefined),
    resumeRecovery: vi.fn(),
    pruneRecovery: vi.fn(),
    verify: vi.fn(async () => true),
    now: () => "2026-09-04T12:00:00.000Z",
    journalId: () => "00000000-0000-4000-8000-000000000002",
  };
}
