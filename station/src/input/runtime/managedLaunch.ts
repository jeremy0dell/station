import {
  executeObserverCommand,
  toSafeError,
  type ObserverService,
  type StationClientStateSource,
} from "@station/client";
import type {
  ProviderId,
  SafeError,
  SessionGroupPlacementIntent,
  StationCommand,
} from "@station/contracts";
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
  group?: SessionGroupPlacementIntent;
  command: Extract<StationCommand, { type: "worktree.create" | "worktree.fork" }>;
  verb: "create" | "fork";
};

/**
 * Create native managed-launch execution without receiving dashboard state or actions.
 *
 * Worktree dispatch/completion failures remain distinguishable from launch preparation
 * failures so the dashboard runtime can remove or retain its optimistic row correctly.
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
        const error =
          execution.status === "rejected" && execution.receipt.error === undefined
            ? {
                ...execution.error,
                tag: "ClientObserverError" as const,
                code: `STATION_WORKTREE_${spec.verb.toUpperCase()}_REJECTED`,
                message: `Station could not ${spec.verb} the worktree.`,
              }
            : execution.error;
        return worktreeFailure(error);
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
          },
        },
        verb: "fork",
      }),
  };
}

function worktreeFailure(error: SafeError): Extract<ManagedLaunchResult, { kind: "failure" }> {
  return { kind: "failure", error, stage: "worktree" };
}
