import { DEFAULT_WORKSPACE_CONFIG, type StationConfig } from "@station/config";
import type {
  ObserverRepairInventory,
  RepairInventory,
  RepairPreviewReport,
  RepairRecoveryHandle,
  RepairRuntimeOwnership,
  RepairTerminalGroup,
} from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RepairCommandDeps } from "../../src/commands/repair";
import { runRepairCommand } from "../../src/commands/repair/index";
import {
  canonicalRepairDigest,
  captureRepairInventory,
  repairInventoryDigestProjection,
} from "../../src/commands/repair/inventory";
import { planRecoveryRepair } from "../../src/commands/repair/recoveryPlan";

const firstNow = "2026-08-20T12:00:00.000Z";
const later = "2026-08-20T13:00:00.000Z";
const processIdentity = {
  pid: 50,
  startToken: "Thu Aug 20 08:00:00 2026",
  executablePath: "/opt/stn",
  argv: ["/opt/stn", "__station-host"],
};
const socketIdentity = { inode: "10", birthtimeNs: "20" };

describe("repair command", () => {
  it("keeps inventory digests stable across capture and presentation changes", async () => {
    const deps = repairDeps(observerInventory());
    deps.now = () => new Date(firstNow);
    const first = await captureRepairInventory({ config }, deps);
    deps.now = () => new Date(later);
    const second = await captureRepairInventory({ config }, deps);
    expect(second.capturedAt).not.toBe(first.capturedAt);
    expect(second.inventoryDigest).toBe(first.inventoryDigest);

    const changedPresentation: Omit<RepairInventory, "inventoryDigest"> = {
      ...first,
      findings: [
        {
          severity: "warning",
          code: "SAME_CODE",
          message: "First presentation text.",
          recoveryCommands: [["stn", "one"]],
        },
      ],
    };
    const otherPresentation = {
      ...changedPresentation,
      findings: [
        {
          ...changedPresentation.findings[0],
          message: "Changed presentation text.",
          recoveryCommands: [["stn", "two"]] as [string, ...string[]][],
        },
      ],
    };
    expect(canonicalRepairDigest(repairInventoryDigestProjection(changedPresentation))).toBe(
      canonicalRepairDigest(repairInventoryDigestProjection(otherPresentation)),
    );
  });

  it("produces exact runtime previews and refuses changed inventories", async () => {
    const deps = repairDeps(observerInventory());
    const inventoryResult = await runRepairCommand(["inventory", "--json"], { config }, deps);
    const inventory = inventoryResult.output as RepairInventory;
    const planned = await runRepairCommand(
      [
        "runtime",
        "--dry-run",
        "--expect-inventory",
        inventory.inventoryDigest,
        "--target",
        "runtime:target-1",
        "--json",
      ],
      { config },
      deps,
    );
    expect(planned).toMatchObject({
      code: 0,
      output: {
        mode: "preview",
        action: "runtime",
        status: "planned",
        selectedTargets: ["runtime:target-1"],
      },
    });
    const plannedReport = planned.output as RepairPreviewReport;
    expect(JSON.stringify(plannedReport)).toContain('"ptyInstanceId":"instance-1"');
    const copyable = await runRepairCommand(
      plannedReport.recoveryCommands[0]?.slice(2) ?? [],
      { config },
      deps,
    );
    expect(copyable).toMatchObject({
      code: 0,
      output: expect.stringContaining(`planDigest: ${plannedReport.planDigest}`),
    });
    expect(String(copyable.output)).toContain(
      `run: ${plannedReport.recoveryCommands[0]?.join(" ")}`,
    );

    const refused = await runRepairCommand(
      [
        "runtime",
        "--dry-run",
        "--expect-inventory",
        "f".repeat(64),
        "--target",
        "runtime:target-1",
      ],
      { config },
      deps,
    );
    expect(refused).toMatchObject({
      code: 1,
      outputFormat: "text",
      output: expect.stringContaining("REPAIR_INVENTORY_CHANGED"),
    });
  });

  it("previews explicit recovery keep/prune without dispatching or writing", async () => {
    const inspectRepairInventory = vi.fn(async () => observerInventory());
    const deps = repairDeps(observerInventory(), inspectRepairInventory);
    const inventory = (await runRepairCommand(["inventory", "--json"], { config }, deps))
      .output as RepairInventory;
    const result = await runRepairCommand(
      [
        "recovery",
        "--dry-run",
        "--expect-inventory",
        inventory.inventoryDigest,
        "--session",
        "session-1",
        "--keep-handle",
        "handle-new",
        "--prune-handle",
        "handle-old",
        "--json",
      ],
      { config },
      deps,
    );
    expect(result).toMatchObject({
      code: 0,
      output: {
        action: "recovery",
        status: "planned",
        selectedTargets: ["handle-new", "handle-old"],
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("native-session-secret");
    expect(inspectRepairInventory).toHaveBeenCalledTimes(2);
  });

  it("refuses ambiguous, missing, and cross-session recovery selections", async () => {
    const inventory = (
      await runRepairCommand(["inventory", "--json"], { config }, repairDeps(observerInventory()))
    ).output as RepairInventory;
    const ambiguous = planRecoveryRepair(inventory, {
      schemaVersion: 1,
      dryRun: true,
      expectInventory: inventory.inventoryDigest,
      sessionId: "session-1",
      pruneHandleIds: [],
    });
    expect(ambiguous).toMatchObject({
      status: "refused",
      blockers: [expect.objectContaining({ code: "REPAIR_HANDLE_AMBIGUOUS" })],
    });

    const withoutHandles = planRecoveryRepair(
      { ...inventory, recoveryHandles: [] },
      {
        schemaVersion: 1,
        dryRun: true,
        expectInventory: inventory.inventoryDigest,
        sessionId: "session-1",
        pruneHandleIds: [],
      },
    );
    expect(withoutHandles).toMatchObject({
      status: "refused",
      blockers: [expect.objectContaining({ code: "REPAIR_NO_VIABLE_HANDLE" })],
    });

    const crossSession = {
      ...inventory.recoveryHandles[1],
      id: "handle-other-session",
      sessionId: "session-other",
    } as RepairRecoveryHandle;
    const crossScope = planRecoveryRepair(
      {
        ...inventory,
        recoveryHandles: [...inventory.recoveryHandles, crossSession].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      },
      {
        schemaVersion: 1,
        dryRun: true,
        expectInventory: inventory.inventoryDigest,
        sessionId: "session-1",
        keepHandleId: "handle-new",
        pruneHandleIds: [crossSession.id],
      },
    );
    expect(crossScope).toMatchObject({
      status: "refused",
      blockers: [expect.objectContaining({ code: "REPAIR_HANDLE_SCOPE_MISMATCH" })],
    });
  });
});

function repairDeps(
  inventory: ObserverRepairInventory,
  inspectRepairInventory = vi.fn(async () => inventory),
): RepairCommandDeps {
  const health = {
    schemaVersion: "0.11.0" as const,
    status: "healthy" as const,
    pid: 40,
    startedAt: firstNow,
    version: "build-1",
    socketPath: "/state/observer.sock",
  };
  return {
    now: () => new Date(firstNow),
    observer: {
      probeSocket: async () => ({
        status: "listening" as const,
        identity: { ino: 1n, birthtimeNs: 2n },
      }),
      clientFactory: () => ({ health: async () => health, inspectRepairInventory }) as never,
    },
    runtimeEvidence: {
      inspectObserver: async () => verifiedOwnership("observer", "/state/observer.sock", 40),
      inspectHost: async () => ({
        ownership: verifiedOwnership("host", "/state/station-host.sock", 50),
        terminalGroups: [terminalGroup()],
      }),
    },
  };
}

function verifiedOwnership(
  component: "observer" | "host",
  socketPath: string,
  pid: number,
): RepairRuntimeOwnership {
  return {
    component,
    status: "verified",
    socketPath,
    socketIdentity,
    holderPids: [pid],
    process: { ...processIdentity, pid },
    buildVersion: "build-1",
    ...(component === "host" ? { protocolVersion: 8 } : {}),
  };
}

function terminalGroup(): RepairTerminalGroup {
  return {
    targetKey: "runtime:target-1",
    disposition: "verified",
    kind: "agent",
    hostSocketIdentity: socketIdentity,
    hostProcess: processIdentity,
    hostBuildVersion: "build-1",
    hostProtocolVersion: 8,
    ptyId: "pty-1",
    ptyInstanceId: "instance-1",
    terminalTargetId: "terminal-1",
    projectId: "project-1",
    worktreeId: "worktree-1",
    stationSessionId: "session-1",
    harnessProvider: "codex",
    childPid: 200,
    processGroupId: 200,
    terminalSessionId: 200,
    tty: "ttys001",
    leaderStartToken: processIdentity.startToken,
    members: [
      {
        pid: 200,
        processGroupId: 200,
        sessionId: 200,
        tty: "ttys001",
        startToken: processIdentity.startToken,
      },
    ],
  };
}

function observerInventory(): ObserverRepairInventory {
  return {
    schemaVersion: 1,
    sessions: [
      {
        id: "session-1",
        projectId: "project-1",
        worktreeId: "worktree-1",
        lifecycle: "open",
        harnessProvider: "codex",
        terminalProvider: "station",
        createdAt: firstNow,
        lastSeenAt: firstNow,
      },
    ],
    recoveryHandles: [
      {
        id: "handle-new",
        provider: "codex",
        projectId: "project-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        targetKind: "native-session",
        observedAt: firstNow,
        lastSeenAt: firstNow,
        disposition: "viable",
        eligible: true,
      },
      {
        id: "handle-old",
        provider: "codex",
        projectId: "project-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        targetKind: "native-session",
        observedAt: "2026-08-19T12:00:00.000Z",
        lastSeenAt: "2026-08-19T12:00:00.000Z",
        disposition: "viable",
        eligible: true,
      },
    ],
  };
}

const config: StationConfig = {
  schemaVersion: 1,
  observer: {
    socketPath: "/state/observer.sock",
    stateDir: "/state",
    autoStartFromHooks: false,
  },
  defaults: {
    worktreeProvider: "worktrunk",
    terminal: "noop-terminal",
    harness: "noop-harness",
    layout: "agent-shell",
  },
  projects: [],
  workspace: DEFAULT_WORKSPACE_CONFIG,
};
