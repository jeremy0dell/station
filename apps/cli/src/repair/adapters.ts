import type { StationConfig } from "@station/config";
import type {
  ObserverRecoveryAssessment,
  RepairAction,
  RepairJournal,
  RepairRecoveryMutationProof,
  StationCommand,
  UpdateReapJournalTarget,
} from "@station/contracts";
import { worktreeHasLiveAgent } from "@station/contracts";
import {
  createSqliteRecoveryBackupPort,
  type ProviderRegistry,
  recoveryInventoryPublicDigest,
} from "@station/observer/internal";
import { createObserverClient, type ObserverClient } from "@station/protocol";
import type { StationBuildInfo } from "@station/runtime";
import type { HostCommandDeps } from "../commands/host/index.js";
import { repairLocalObserverEvidence } from "../observerProcess/evidenceRepair.js";
import { inspectExactObserverOwnerWithLocalAdapters } from "../observerProcess/inspectExactObserverOwner.js";
import { resolveObserverPaths } from "../paths.js";
import { executeJournaledTerminalReapTargets } from "../update/reapExecution.js";
import { createFilesystemUpdateReapJournalPort } from "../update/reapJournal.js";
import {
  createPosixUpdateReapProcessGroupPort,
  type UpdateReapProcessGroupPort,
} from "../update/reapProcessGroups.js";
import { runUpdateRecoveryPreflight } from "../update/recoveryPreflight.js";
import {
  createUpdateRecoveryPreflightPorts,
  deriveLocalExactTerminalReapAuthorizationEvidence,
} from "../update/recoveryPreflightAdapters.js";
import { createFilesystemRepairAuditPort } from "./audit.js";
import type { RepairExecutionDeps } from "./execution.js";
import {
  configuredRepairStateScopeDigest,
  inspectRepairInventory,
  repairDigest,
  repairInventoryEvidence,
} from "./inventory.js";
import { createFilesystemRepairJournalPort } from "./journal.js";
import { deriveRepairPlan } from "./plan.js";

export type CreateRepairExecutionDepsOptions = {
  config: StationConfig;
  configPath?: string;
  currentBuildInfo: StationBuildInfo;
  providers: ProviderRegistry;
  hostDeps?: HostCommandDeps;
  processGroups?: UpdateReapProcessGroupPort;
};

/** COMPOSITION ROOT: binds repair policy to exact local runtime, SQLite, command, and file adapters. */
export function createRepairExecutionDeps(
  options: CreateRepairExecutionDepsOptions,
): RepairExecutionDeps {
  const paths = resolveObserverPaths(options.config);
  const processGroups = options.processGroups ?? createPosixUpdateReapProcessGroupPort();
  const configuredStateScopeDigest = configuredRepairStateScopeDigest({
    stateDir: paths.stateDir,
    socketPath: paths.socketPath,
    databasePath: paths.dbPath,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  const inspectRuntime = async () => {
    const artifact = {
      version: options.currentBuildInfo.version,
      revision: options.currentBuildInfo.buildIdentity,
    };
    const preflightOptions: Parameters<typeof createUpdateRecoveryPreflightPorts>[0] = {
      config: options.config,
      providers: options.providers,
      currentBuildArtifact: artifact,
      currentBuildInfo: options.currentBuildInfo,
    };
    if (options.configPath !== undefined) preflightOptions.configPath = options.configPath;
    if (options.hostDeps?.inspectHost !== undefined) {
      preflightOptions.inspectHost = options.hostDeps.inspectHost;
    }
    return runUpdateRecoveryPreflight({
      installed: artifact,
      target: artifact,
      ports: createUpdateRecoveryPreflightPorts(preflightOptions),
    });
  };
  const inspectRecovery = () => inspectPinnedRecoveryAssessment(options.config);
  const inspectInventory = () =>
    inspectRepairInventory({
      configuredStateScopeDigest,
      inspectRuntime,
      inspectRecovery,
    });
  const reapTerminal = createRepairTerminalReapAdapter({
    processGroups,
    executeTargets: executeJournaledTerminalReapTargets,
  });
  const dispatchObserverCommand = createRepairObserverCommandAdapter(() =>
    exactPinnedClient(options.config),
  );
  const cleanupObserver = async () => {
    await repairLocalObserverEvidence({
      socketPath: paths.socketPath,
      timeoutMs: 5_000,
    });
  };
  return {
    inspectInventory,
    derivePlan: deriveRepairPlan,
    journal: createFilesystemRepairJournalPort(paths.stateDir),
    audit: createFilesystemRepairAuditPort(paths.stateDir),
    updateReapJournal: createFilesystemUpdateReapJournalPort(paths.stateDir),
    backup: createSqliteRecoveryBackupPort({
      databasePath: paths.dbPath,
      stateDir: paths.stateDir,
    }),
    async authorizeTerminal({ inventory, action, plan }) {
      const preflight = repairInventoryEvidence(inventory).runtime;
      if (preflight === undefined) throw new Error("Private terminal preflight was unavailable.");
      const evidence = await deriveLocalExactTerminalReapAuthorizationEvidence({
        preflight,
        terminalTargetId: action.terminalTargetId,
        processGroups,
      });
      return {
        target: evidence.target,
        authorizationDigest: repairDigest("station-repair-terminal-authorization-v1", {
          schemaVersion: 1,
          repairPlanDigest: plan.repairPlanDigest,
          configuredStateScopeDigest,
          host: evidence.host,
          observer: evidence.observer,
          parkedTerminals: evidence.parkedTerminals,
          target: evidence.target,
        }),
      };
    },
    reapTerminal,
    cleanupObserver,
    resumeRecovery: (action, proof) =>
      dispatchObserverCommand(proof.expectedRecoveryInventoryDigest, resumeCommand(action, proof)),
    pruneRecovery: (action, proof) =>
      dispatchObserverCommand(proof.expectedRecoveryInventoryDigest, pruneCommand(action, proof)),
    verify: (action, journal) =>
      verifyRepairPostcondition({
        action,
        journal,
        config: options.config,
        processGroups,
        cleanupObserver,
      }),
  };
}

async function exactPinnedClient(config: StationConfig): Promise<ObserverClient> {
  const exact = await inspectExactObserverOwnerWithLocalAdapters({
    config,
    timeoutMs: 5_000,
  });
  if (exact.status !== "exact")
    throw new Error("An exact running Observer is required for repair.");
  return createObserverClient({
    socketPath: exact.health.socketPath,
    expectedObserverIdentity: {
      pid: exact.health.pid,
      startedAt: exact.health.startedAt,
      version: exact.health.version,
      socketPath: exact.health.socketPath,
    },
    timeoutMs: 30_000,
  });
}

async function inspectPinnedRecoveryInventory(config: StationConfig) {
  return (await exactPinnedClient(config)).getSessionRecoveryInventory();
}

async function inspectPinnedRecoveryAssessment(
  config: StationConfig,
): Promise<ObserverRecoveryAssessment> {
  return (await exactPinnedClient(config)).getSessionRecoveryAssessment();
}

/**
 * ADAPTER
 *
 * Sends one digest-guarded repair command to the exact running Observer without starting or
 * replacing it.
 */
export function createRepairObserverCommandAdapter(
  connect: () => Promise<
    Pick<ObserverClient, "getSessionRecoveryInventory" | "dispatch" | "waitForCommand">
  >,
): (expectedRecoveryInventoryDigest: string, command: StationCommand) => Promise<void> {
  return async (expectedRecoveryInventoryDigest, command) => {
    const client = await connect();
    const inventory = await client.getSessionRecoveryInventory();
    if (recoveryInventoryPublicDigest(inventory) !== expectedRecoveryInventoryDigest) {
      throw new Error("Recovery inventory changed before repair command dispatch.");
    }
    const receipt = await client.dispatch(command);
    if (!receipt.accepted) throw receipt.error;
    const record = await client.waitForCommand(receipt.commandId, {
      timeoutMs: 30_000,
    });
    if (record.status !== "succeeded" || record.type !== command.type) {
      throw record.status === "failed"
        ? record.error
        : new Error("Repair command did not complete.");
    }
  };
}

/**
 * ADAPTER
 *
 * Restricts the update reaper to one previously authorized terminal target and retains its exact
 * identity and escalation postconditions.
 */
export function createRepairTerminalReapAdapter(input: {
  processGroups: UpdateReapProcessGroupPort;
  executeTargets(
    targets: UpdateReapJournalTarget[],
    processGroups: UpdateReapProcessGroupPort,
    recoveryCommand: readonly [string, ...string[]],
  ): Promise<UpdateReapJournalTarget[]>;
}): RepairExecutionDeps["reapTerminal"] {
  return async (target, planDigest) => {
    const [result] = await input.executeTargets([target], input.processGroups, [
      "stn",
      "repair",
      "terminal",
      "reap",
      "--terminal",
      target.terminal.terminalTargetId,
      "--yes",
      "--expect-plan",
      planDigest,
    ]);
    if (result === undefined) throw new Error("Terminal reap did not return its exact target.");
    return result;
  };
}

function resumeCommand(
  action: Extract<RepairAction, { kind: "recovery-resume" }>,
  proof: RepairRecoveryMutationProof,
): StationCommand {
  return {
    type: "session.resumeAgent",
    payload: {
      projectId: action.projectId,
      worktreeId: action.worktreeId,
      recoveryHandleId: action.recoveryHandleId,
      expected: { sessionId: action.sessionId, provider: action.provider },
      repair: proof,
    },
  };
}

function pruneCommand(
  action: Extract<RepairAction, { kind: "recovery-prune" }>,
  proof: RepairRecoveryMutationProof,
): StationCommand {
  return {
    type: "session.pruneRecoveryHandle",
    payload: {
      projectId: action.projectId,
      worktreeId: action.worktreeId,
      recoveryHandleId: action.recoveryHandleId,
      expected: { sessionId: action.sessionId, provider: action.provider },
      repair: proof,
    },
  };
}

async function verifyRepairPostcondition(input: {
  action: RepairAction;
  journal: RepairJournal;
  config: StationConfig;
  processGroups: UpdateReapProcessGroupPort;
  cleanupObserver(): Promise<void>;
}): Promise<boolean> {
  switch (input.action.kind) {
    case "terminal-reap": {
      const target = input.journal.terminalTarget;
      if (target?.result?.unresolved !== false) return false;
      const current = await input.processGroups.read(target.processGroup.leader.pgid);
      return current.members.length === 0;
    }
    case "observer-cleanup": {
      await input.cleanupObserver();
      return true;
    }
    case "recovery-resume": {
      const action = input.action;
      const row = (await (await exactPinnedClient(input.config)).getSnapshot()).rows.find(
        (candidate) => candidate.id === action.worktreeId,
      );
      return (
        row !== undefined &&
        row.projectId === action.projectId &&
        worktreeHasLiveAgent(row) &&
        row.agent?.sessionId === action.sessionId &&
        row.agent.harness === action.provider
      );
    }
    case "recovery-prune": {
      const action = input.action;
      const inventory = await inspectPinnedRecoveryInventory(input.config);
      return !inventory.recoveryHandles.some((handle) => handle.id === action.recoveryHandleId);
    }
  }
}
