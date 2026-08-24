import {
  executeObserverCommand,
  toSafeError,
  type ObserverService,
  type StationClientStateSource,
} from "@station/client";
import type {
  FreshSessionGroupPlacementIntent,
  ProviderId,
  SafeError,
  SessionGroupPlacementIntent,
  SourceSessionGroupPlacementIntent,
  StationCommand,
  WorktreeRow,
} from "@station/contracts";
import { buildRemoveWorktreeCommand } from "@station/dashboard-core/runtime";
import type { ManagedTerminalAttacher } from "../../terminal/pty/managedTerminalAttacher.js";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import type { StationStore } from "../../state/store.js";
import { agentWorktreePaneId, type PaneId } from "../../state/types.js";
import { waitForWorktreeByBranch } from "./stationRows.js";
import {
  createManagedLaunchAttempt,
  type ManagedLaunchAttemptResult,
  type ManagedLaunchTarget,
} from "./managedLaunchAttempt.js";

export type { ManagedLaunchTarget } from "./managedLaunchAttempt.js";

export type ManagedHostedSessionRequest = {
  projectId: string;
  title: string;
  branch: string;
  harness: ProviderId;
  group?: SessionGroupPlacementIntent;
};

export type ManagedHostedForkRequest = Omit<ManagedHostedSessionRequest, "group"> & {
  sourceWorktreeId: string;
  copyDirty: boolean;
  group?: SourceSessionGroupPlacementIntent;
};

export type ManagedLaunchResult =
  | Exclude<ManagedLaunchAttemptResult, { kind: "failure" }>
  | { kind: "failure"; error: SafeError; stage: "worktree" | "launch" };

/** Promise-based native activate, create, and fork execution boundary. */
export type ManagedLaunch = {
  activate(paneId: PaneId, target: ManagedLaunchTarget): Promise<ManagedLaunchResult>;
  create(request: ManagedHostedSessionRequest): Promise<ManagedLaunchResult>;
  fork(request: ManagedHostedForkRequest): Promise<ManagedLaunchResult>;
};

type ManagedLaunchDeps = {
  store: StationStore;
  clientState: StationClientStateSource;
  observerService: ObserverService | undefined;
  registry: PtyRegistry | undefined;
  managedTerminalAttacher: ManagedTerminalAttacher | undefined;
};

type HostedWorktreeLaunch = {
  projectId: string;
  title: string;
  branch: string;
  harness: ProviderId;
  group?: FreshSessionGroupPlacementIntent;
  command: Extract<StationCommand, { type: "worktree.create" | "worktree.fork" }>;
  verb: "create" | "fork";
};

/**
 * Create native managed-launch execution without receiving dashboard state or actions.
 *
 * Worktree dispatch/completion failures remain distinguishable from launch preparation failures;
 * explicit New Session Group rejection rolls back only the exact fresh worktree without force.
 */
export function createManagedLaunch(deps: ManagedLaunchDeps): ManagedLaunch {
  const runManagedLaunchAttempt = createManagedLaunchAttempt(deps);

  async function runHostedWorktreeLaunch(
    spec: HostedWorktreeLaunch,
  ): Promise<ManagedLaunchResult> {
    const service = deps.observerService;
    if (service === undefined) {
      return worktreeFailure({
        tag: "ClientObserverError",
        code: "OBSERVER_UNAVAILABLE",
        message: `No observer connection; cannot ${spec.verb} the session.`,
      });
    }
    try {
      const execution = await executeObserverCommand(service, spec.command, {
        clientLabel: "Station",
      });
      if (execution.status !== "succeeded" && execution.status !== "accepted") {
        if (execution.status === "rejected" && execution.receipt.error === undefined) {
          return worktreeFailure({
            ...execution.error,
            tag: "ClientObserverError",
            code: `STATION_WORKTREE_${spec.verb.toUpperCase()}_REJECTED`,
            message: `Station could not ${spec.verb} the worktree.`,
          });
        }
        return worktreeFailure(execution.error);
      }
      // A bare worktree does not prune the optimistic row; only canonical session projection does.
      const row = await waitForWorktreeByBranch(deps.clientState, spec.projectId, spec.branch);
      if (row === undefined) {
        const completedVerb = spec.verb === "create" ? "Created" : "Forked";
        return {
          kind: "notice",
          notice: {
            kind: "info",
            message: `${completedVerb} the worktree, but it didn't appear in time to launch the agent — open it from the dashboard.`,
          },
        };
      }
      const attempt = await runManagedLaunchAttempt(agentWorktreePaneId(row.id), {
        projectId: spec.projectId,
        worktreeId: row.id,
        cwd: row.path,
        title: spec.title,
        background: true,
        harness: spec.harness,
        ...(spec.group === undefined ? {} : { group: spec.group }),
      });
      if (
        attempt.kind === "failure" &&
        spec.verb === "create" &&
        spec.group !== undefined &&
        isSessionGroupPlacementFailure(attempt.error)
      ) {
        return rollbackRejectedGroupPlacement(service, row, attempt.error);
      }
      return attempt.kind === "failure"
        ? { kind: "failure", error: attempt.error, stage: "launch" }
        : attempt;
    } catch (error: unknown) {
      return worktreeFailure(toSafeError(error, { clientLabel: "Station" }));
    }
  }

  return {
    activate: async (paneId, target) => {
      const result = await runManagedLaunchAttempt(paneId, target);
      return result.kind === "failure"
        ? { kind: "failure", error: result.error, stage: "launch" }
        : result;
    },
    create: (request) =>
      runHostedWorktreeLaunch({
        ...request,
        command: {
          type: "worktree.create",
          payload: {
            projectId: request.projectId,
            branch: request.branch,
            launchHarness: request.harness,
          },
        },
        verb: "create",
      }),
    fork: (request) =>
      runHostedWorktreeLaunch({
        ...request,
        command: {
          type: "worktree.fork",
          payload: {
            projectId: request.projectId,
            sourceWorktreeId: request.sourceWorktreeId,
            branch: request.branch,
            copyDirty: request.copyDirty,
            launchHarness: request.harness,
            ...(request.group === undefined ? {} : { group: request.group }),
          },
        },
        verb: "fork",
      }),
  };
}

async function rollbackRejectedGroupPlacement(
  service: ObserverService,
  row: WorktreeRow,
  error: SafeError,
): Promise<ManagedLaunchResult> {
  try {
    const rollback = await executeObserverCommand(service, buildRemoveWorktreeCommand(row, false), {
      clientLabel: "Station",
    });
    if (rollback.status === "succeeded") {
      return { kind: "failure", error, stage: "worktree" };
    }
  } catch {
    // The original Group error remains the useful failure; the notice owns rollback uncertainty.
  }
  return {
    kind: "notice",
    notice: {
      kind: "error",
      message: `${error.message} Station kept the new worktree because safe rollback was not confirmed.`,
      hint: "Refresh the dashboard, then open or remove that worktree before retrying this branch.",
    },
  };
}

function isSessionGroupPlacementFailure(error: SafeError): boolean {
  switch (error.code) {
    case "SESSION_GROUP_NOT_FOUND":
    case "SESSION_GROUP_PROJECT_MISMATCH":
    case "SESSION_GROUP_NOT_ROOT":
    case "SESSION_GROUP_ID_COLLISION":
    case "SESSION_GROUP_ASSIGNMENT_CONFLICT":
      return true;
    default:
      return false;
  }
}

function worktreeFailure(error: SafeError): Extract<ManagedLaunchResult, { kind: "failure" }> {
  return { kind: "failure", error, stage: "worktree" };
}
