import type { ManagedTerminalAttacher } from "../../terminal/pty/managedTerminalAttacher.js";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import type { StoreApi } from "zustand/vanilla";
import type { StationStore } from "../../state/store.js";
import { agentWorktreePaneId, type PaneId } from "../../state/types.js";
import { dispatchStationKey } from "../../station/input/stationActions.js";
import { safeErrorToNotice, toSafeError, type ObserverService } from "@station/client";
import type { ProviderId, SafeError, StationCommand } from "@station/contracts";
import { FAILED_CREATE_ROW_TTL_MS, type TuiStore } from "@station/dashboard-core";
import { inheritedForkHarness, waitForWorktreeByBranch } from "./stationRows.js";
import {
  createManagedLaunchAttempt,
  type ManagedLaunchTarget,
} from "./managedLaunchAttempt.js";

export type { ManagedLaunchTarget } from "./managedLaunchAttempt.js";

export type ManagedLaunch = {
  /**
   * Managed launches are fire-and-forget so input stays consumed while observer
   * preparation and local spawn finish; failures surface as STATION toasts.
   */
  launchPrimaryAgent(paneId: PaneId, target: ManagedLaunchTarget): void;
  /**
   * Create a new worktree and host its primary agent in a Station pane (the New
   * Session wizard's submit). Fire-and-forget like launchPrimaryAgent.
   */
  launchHostedNewSession(target: {
    projectId: string;
    title: string;
    branch: string;
    harness: ProviderId;
  }): void;
  /**
   * Seed a worktree off a source's HEAD (worktree.fork) and host the inherited
   * harness in a Station pane (the Fork details submit). Fire-and-forget too.
   */
  launchHostedForkSession(target: {
    projectId: string;
    sourceWorktreeId: string;
    title: string;
    branch: string;
    copyDirty: boolean;
  }): void;
};

type ManagedLaunchDeps = {
  store: StationStore;
  stationViewStore: StoreApi<TuiStore> | undefined;
  observerService: ObserverService | undefined;
  registry: PtyRegistry | undefined;
  managedTerminalAttacher: ManagedTerminalAttacher | undefined;
};

export function createManagedLaunch(deps: ManagedLaunchDeps): ManagedLaunch {
  const { stationViewStore, observerService } = deps;
  const runManagedLaunchAttempt = createManagedLaunchAttempt(deps);

  function pushLaunchToast(message: string, kind: "info" | "error" = "error"): void {
    stationViewStore?.getState().pushToast({ kind, message });
  }

  function pushLaunchError(error: unknown): void {
    stationViewStore?.getState().pushToast(safeErrorToNotice(toSafeError(error, { clientLabel: "Station" })));
  }

  function clearPendingCreateRow(localId: string): void {
    stationViewStore?.getState().removePendingCreateSession(localId);
  }

  function failPendingCreateRow(localId: string, error: SafeError): void {
    if (stationViewStore === undefined) {
      return;
    }
    stationViewStore
      .getState()
      .failPendingCreateSession(localId, error, Date.now() + FAILED_CREATE_ROW_TTL_MS);
    setTimeout(() => clearPendingCreateRow(localId), FAILED_CREATE_ROW_TTL_MS);
  }

  /**
   * Return the STATION view store to the dashboard from the New Session wizard via
   * the shared reducer. Station hosts the create itself, so the wizard's own tmux
   * submit must not also run.
   */
  function closeNewSessionWizard(): void {
    if (stationViewStore !== undefined && stationViewStore.getState().screen.name === "newSession") {
      dispatchStationKey(stationViewStore, { input: "", escape: true });
    }
  }

  function closeForkSheet(): void {
    if (stationViewStore === undefined) {
      return;
    }
    // Submit is intercepted before submitFork runs, so unwind to the dashboard here.
    // Esc steps details → chooseSlot → dashboard; the hop cap can't spin.
    for (let hop = 0; hop < 2 && stationViewStore.getState().screen.name === "fork"; hop += 1) {
      dispatchStationKey(stationViewStore, { input: "", escape: true });
    }
  }

  // Station hosts agents itself (worktree.create/fork + a managed launch), never the machine's
  // session.create/fork — those spawn a tmux terminal it can't render.
  type HostedWorktreeLaunch = {
    localId: string;
    projectId: string;
    title: string;
    branch: string;
    harness: ProviderId;
    command: Extract<StationCommand, { type: "worktree.create" | "worktree.fork" }>;
    verb: "create" | "fork";
  };

  function startHostedWorktreeLaunch(spec: HostedWorktreeLaunch): void {
    if (stationViewStore !== undefined) {
      stationViewStore.getState().addPendingCreateSession({
        localId: spec.localId,
        projectId: spec.projectId,
        title: spec.title,
        branch: spec.branch,
        createdAt: new Date().toISOString(),
        harnessProvider: spec.harness,
      });
    }
    void runHostedWorktreeLaunch(spec).catch((error) => {
      clearPendingCreateRow(spec.localId);
      pushLaunchError(error);
    });
  }

  function missingWorktreeMessage(verb: HostedWorktreeLaunch["verb"]): string {
    const completedVerb = verb === "create" ? "Created" : "Forked";
    return `${completedVerb} the worktree, but it didn't appear in time to launch the agent — open it from the dashboard.`;
  }

  async function runHostedWorktreeLaunch(spec: HostedWorktreeLaunch): Promise<void> {
    if (observerService === undefined) {
      clearPendingCreateRow(spec.localId);
      pushLaunchToast(`No observer connection; cannot ${spec.verb} the session.`);
      return;
    }
    if (stationViewStore === undefined) {
      pushLaunchToast(`The dashboard is not available; cannot ${spec.verb} the session.`);
      return;
    }
    const receipt = await observerService.dispatch(spec.command);
    if (!receipt.accepted) {
      clearPendingCreateRow(spec.localId);
      pushLaunchError(
        receipt.error ?? {
          tag: "ClientObserverError",
          code: `STATION_WORKTREE_${spec.verb.toUpperCase()}_REJECTED`,
          message: `Station could not ${spec.verb} the worktree.`,
        },
      );
      return;
    }
    const completion = await observerService.waitForCommandCompletion(receipt.commandId);
    if (completion.status === "failed") {
      clearPendingCreateRow(spec.localId);
      pushLaunchError(completion.error);
      return;
    }
    // A bare worktree does not prune the optimistic row; only the matching canonical session does.
    const row = await waitForWorktreeByBranch(stationViewStore, spec.projectId, spec.branch);
    if (row === undefined) {
      clearPendingCreateRow(spec.localId);
      pushLaunchToast(missingWorktreeMessage(spec.verb), "info");
      return;
    }
    const launchTarget: ManagedLaunchTarget = {
      projectId: spec.projectId,
      worktreeId: row.id,
      cwd: row.path,
      title: spec.title,
      background: true,
      harness: spec.harness,
    };
    const result = await runManagedLaunchAttempt(agentWorktreePaneId(row.id), launchTarget);
    if (result.kind === "preparation-failed") {
      failPendingCreateRow(spec.localId, result.error);
    }
  }

  return {
    launchPrimaryAgent: (paneId, target) => {
      // Fire-and-forget so executeOutcome stays synchronous; any throw becomes a toast, never an
      // unhandled rejection, so the failures-toast contract holds end to end.
      void runManagedLaunchAttempt(paneId, target).catch((error) => {
        pushLaunchError(error);
      });
    },
    launchHostedNewSession: (target) => {
      // Harness comes from the wizard pick; New Session keeps the overlay open.
      closeNewSessionWizard();
      startHostedWorktreeLaunch({
        localId: `station-create:${target.projectId}:${target.branch}`,
        projectId: target.projectId,
        title: target.title,
        branch: target.branch,
        harness: target.harness,
        command: {
          type: "worktree.create",
          payload: {
            projectId: target.projectId,
            branch: target.branch,
            launchHarness: target.harness,
          },
        },
        verb: "create",
      });
    },
    launchHostedForkSession: (target) => {
      // Fork inherits the source's harness (the seeded worktree has none yet).
      closeForkSheet();
      const harness =
        stationViewStore === undefined
          ? undefined
          : inheritedForkHarness(stationViewStore, target.projectId, target.sourceWorktreeId);
      if (harness === undefined) {
        pushLaunchError({
          tag: "CommandValidationError",
          code: "HARNESS_PROVIDER_UNAVAILABLE",
          message: "Station could not resolve a harness for the fork.",
          hint: "Configure a project default harness and retry.",
        });
        return;
      }
      startHostedWorktreeLaunch({
        localId: `station-fork:${target.sourceWorktreeId}:${target.branch}`,
        projectId: target.projectId,
        title: target.title,
        branch: target.branch,
        harness,
        command: {
          type: "worktree.fork",
          payload: {
            projectId: target.projectId,
            sourceWorktreeId: target.sourceWorktreeId,
            branch: target.branch,
            copyDirty: target.copyDirty,
            launchHarness: harness,
          },
        },
        verb: "fork",
      });
    },
  };
}
