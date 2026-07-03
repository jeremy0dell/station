import { createHostAttachedTerminal } from "../../terminal/pty/hostAttachedTerminal.js";
import type { PtyRegistry } from "../../terminal/registry/ptyRegistry.js";
import type { StationTerminalSpawnOptions } from "../../terminal/types.js";
import type { StoreApi } from "zustand/vanilla";
import { selectPaneRecord } from "../../state/selectors.js";
import type { StationStore } from "../../state/store.js";
import { agentWorktreePaneId, type AgentIdentity, type PaneId } from "../../state/types.js";
import { dispatchStationKey } from "../../station/input/stationActions.js";
import { safeErrorToNotice, toSafeError, type ObserverService } from "@station/client";
import type { ProviderId, StationCommand } from "@station/contracts";
import {
  addPendingCreateSessionRow,
  removeCreateSessionLocalRow,
  type TuiStore,
} from "@station/dashboard-core";
import {
  externalTerminalProviderForWorktree,
  inheritedForkHarness,
  nonFocusableStationTerminalForWorktree,
  readinessForWorktree,
  unreachableTerminalRow,
  waitForWorktreeByBranch,
} from "./stationRows.js";

/** What a managed primary-agent launch needs to ask the observer to prepare it. */
export type ManagedLaunchTarget = {
  projectId: string;
  worktreeId: string;
  cwd: string;
  /**
   * Harness to launch when minting a fresh session (the New Session wizard's
   * pick). Absent for a row click, where the observer uses the worktree's
   * remembered harness or the project default.
   */
  harness?: ProviderId;
  /**
   * Spawn the agent pane but leave the STATION overlay open and unfocused — the New
   * Session flow stays on the dashboard instead of focusing the pane. A row click
   * omits this and focuses the new pane.
   */
  background?: boolean;
};

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
  launchHostedNewSession(target: { projectId: string; branch: string; harness: ProviderId }): void;
  /**
   * Seed a worktree off a source's HEAD (worktree.fork) and host the inherited
   * harness in a Station pane (the Fork details submit). Fire-and-forget too.
   */
  launchHostedForkSession(target: {
    projectId: string;
    sourceWorktreeId: string;
    branch: string;
    copyDirty: boolean;
  }): void;
};

type ManagedLaunchDeps = {
  store: StationStore;
  stationViewStore: StoreApi<TuiStore> | undefined;
  observerService: ObserverService | undefined;
  registry: PtyRegistry | undefined;
};

export function createManagedLaunch(deps: ManagedLaunchDeps): ManagedLaunch {
  const { store, stationViewStore, observerService, registry } = deps;
  // Guards a managed launch's async window: between a click's synchronous return
  // and its `prepareExternalLaunch` resolving, no pane record exists yet, so a
  // second click would otherwise fire a second prepare for the same pane and
  // orphan an observer session/target. Keyed by the deterministic agent pane id.
  const launchesInFlight = new Set<PaneId>();

  function pushLaunchToast(message: string, kind: "info" | "error" = "error"): void {
    stationViewStore?.getState().pushToast({ kind, message });
  }

  function pushLaunchError(error: unknown): void {
    stationViewStore?.getState().pushToast(safeErrorToNotice(toSafeError(error, { clientLabel: "Station" })));
  }

  function clearPendingCreateRow(localId: string): void {
    if (stationViewStore !== undefined) {
      stationViewStore.setState(removeCreateSessionLocalRow(stationViewStore.getState(), localId));
    }
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

  async function acknowledgeTurnReadiness(
    readiness: { sessionId: string; token: string } | undefined,
  ): Promise<void> {
    if (readiness === undefined || observerService === undefined) {
      return;
    }
    try {
      const receipt = await observerService.dispatch({
        type: "session.acknowledgeTurn",
        payload: readiness,
      });
      if (receipt.accepted) {
        await observerService.waitForCommandCompletion(receipt.commandId);
      }
    } catch {
      // Opening the pane succeeded; a best-effort acknowledgement must not turn
      // that successful focus into an error path.
    }
  }

  async function focusExistingSession(sessionId: string): Promise<boolean> {
    if (observerService === undefined) {
      pushLaunchToast("No observer connection; cannot focus the existing agent.");
      return false;
    }
    try {
      const receipt = await observerService.dispatch({ type: "terminal.focus", payload: { sessionId } });
      if (!receipt.accepted) {
        pushLaunchError(
          receipt.error ?? {
            tag: "ClientObserverError",
            code: "STATION_FOCUS_REJECTED",
            message: "Station could not focus the existing agent.",
          },
        );
        return false;
      }
      const completion = await observerService.waitForCommandCompletion(receipt.commandId);
      if (completion.status === "failed") {
        pushLaunchError(completion.error);
        return false;
      }
      return true;
    } catch (error: unknown) {
      pushLaunchError(error);
      return false;
    }
  }

  /** Close the overlay onto the opened pane and acknowledge a ready turn (best-effort). */
  async function landOnPane(turnReadiness: { sessionId: string; token: string } | undefined): Promise<void> {
    store.actions.closeOverlay();
    await acknowledgeTurnReadiness(turnReadiness);
  }

  // Seed the registry entry (observer-built command/args/env) *before* createPane, same ordering
  // reason openPane documents, then record the STATION identity so the agent's exit can be reported.
  async function runManagedLaunch(paneId: PaneId, target: ManagedLaunchTarget): Promise<void> {
    // A background launch (New Session) keeps the overlay open; a row click focuses the pane.
    const landInPane = target.background !== true;
    const turnReadiness =
      stationViewStore === undefined ? undefined : readinessForWorktree(stationViewStore, target.worktreeId);
    if (selectPaneRecord(store.getState(), paneId) !== null) {
      if (landInPane) {
        store.actions.revealPane(paneId);
        await landOnPane(turnReadiness);
      }
      return;
    }
    // A detached/stale terminal is running but not attached anywhere Station can render; report
    // where it lives instead of dispatching a terminal.focus the observer accepts yet paints
    // nothing. Open terminals fall through below.
    const unreachable =
      stationViewStore === undefined ? undefined : unreachableTerminalRow(stationViewStore, target.worktreeId);
    if (unreachable !== undefined) {
      pushLaunchToast(
        `${unreachable.label}: agent is ${unreachable.state} under '${unreachable.provider}'; Station can't focus it here.`,
        "info",
      );
      return;
    }
    // A launch for this pane is already underway (its pane record does not exist
    // yet); a second click must not fire a second prepare.
    if (launchesInFlight.has(paneId)) {
      return;
    }
    if (observerService === undefined) {
      pushLaunchToast("No observer connection; cannot launch the agent.");
      return;
    }
    launchesInFlight.add(paneId);
    try {
      let prepared: Awaited<ReturnType<ObserverService["prepareExternalLaunch"]>>;
      try {
        const prepareParams: Parameters<ObserverService["prepareExternalLaunch"]>[0] = {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
        };
        // Honor the New Session wizard's harness pick when minting a fresh session;
        // a row click leaves it absent (observer uses remembered/default).
        if (target.harness !== undefined) {
          prepareParams.harness = target.harness;
        }
        prepared = await observerService.prepareExternalLaunch(prepareParams);
      } catch (error) {
        pushLaunchError(error);
        return;
      }
      // A persistent host PTY backs this worktree (the observer spawned it): attach to the host
      // instead of spawning locally. Covers both a fresh launch and a reopen onto a running agent.
      if (prepared.reattachHandle !== undefined) {
        const handle = prepared.reattachHandle;
        registry?.ensure(paneId, { cwd: target.cwd }, (spawn) =>
          createHostAttachedTerminal({
            hostSocketPath: handle.hostSocketPath,
            ptyId: handle.ptyId,
            size: { cols: spawn.size?.cols ?? 80, rows: spawn.size?.rows ?? 24 },
          }),
        );
        store.actions.createPane(paneId, { role: "primary-agent" });
        const identity: AgentIdentity = {
          sessionId: prepared.sessionId,
          terminalTargetId: handle.terminalTargetId,
          harnessProvider:
            prepared.kind === "prepared" ? prepared.launchPlan.provider : prepared.harnessProvider,
        };
        store.actions.setPrimaryAgent(paneId, identity);
        if (landInPane) {
          await landOnPane(turnReadiness);
        }
        return;
      }

      if (prepared.kind === "existing-session") {
        // A live agent already holds this worktree. If it runs in an external terminal (tmux)
        // Station can't render, say so — focusing would have no visible effect; otherwise focus it.
        const nonFocusableStation =
          stationViewStore !== undefined
            ? nonFocusableStationTerminalForWorktree(stationViewStore, target.worktreeId)
            : undefined;
        if (nonFocusableStation !== undefined) {
          pushLaunchToast(
            `${nonFocusableStation.label}: Station has no attachable host PTY for this existing agent.`,
            "info",
          );
          return;
        }
        const externalProvider =
          stationViewStore !== undefined
            ? externalTerminalProviderForWorktree(stationViewStore, target.worktreeId)
            : undefined;
        if (externalProvider !== undefined) {
          // Keep the overlay open: this is an informational notice, not an open. Closing would flash
          // the toast away before the user could read it.
          pushLaunchToast(
            `This agent runs in the "${externalProvider}" terminal, which Station can't display. Attach to it from a ${externalProvider} client.`,
            "info",
          );
          return;
        }
        if (landInPane && (await focusExistingSession(prepared.sessionId))) {
          await landOnPane(turnReadiness);
        }
        return;
      }
      const { launchPlan, sessionId, terminalTargetId } = prepared;
      const spawnOptions: StationTerminalSpawnOptions = {
        cwd: target.cwd,
        command: launchPlan.command,
        args: launchPlan.args,
      };
      if (launchPlan.env !== undefined) {
        spawnOptions.env = launchPlan.env;
      }
      registry?.ensure(paneId, spawnOptions);
      store.actions.createPane(paneId, { role: "primary-agent" });
      store.actions.setPrimaryAgent(paneId, {
        sessionId,
        terminalTargetId,
        harnessProvider: launchPlan.provider,
      });
      if (landInPane) {
        await landOnPane(turnReadiness);
      }
    } finally {
      launchesInFlight.delete(paneId);
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
    branch: string;
    harness: ProviderId | undefined;
    command: Extract<StationCommand, { type: "worktree.create" | "worktree.fork" }>;
    verb: "create" | "fork";
  };

  function startHostedWorktreeLaunch(spec: HostedWorktreeLaunch): void {
    if (stationViewStore !== undefined) {
      stationViewStore.setState(
        addPendingCreateSessionRow(stationViewStore.getState(), {
          localId: spec.localId,
          projectId: spec.projectId,
          branch: spec.branch,
          createdAt: new Date().toISOString(),
          // Fork can inherit no harness (source has none, project has no default); the row still
          // shows, agent column blank until the launch picks a default.
          ...(spec.harness === undefined ? {} : { harnessProvider: spec.harness }),
        }),
      );
    }
    void runHostedWorktreeLaunch(spec).catch((error) => {
      clearPendingCreateRow(spec.localId);
      pushLaunchError(error);
    });
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
    // The optimistic row auto-prunes when the worktree reaches the snapshot, which is also when this resolves.
    const row = await waitForWorktreeByBranch(stationViewStore, spec.projectId, spec.branch);
    if (row === undefined) {
      clearPendingCreateRow(spec.localId);
      pushLaunchToast(
        `${spec.verb === "create" ? "Created" : "Forked"} the worktree, but it didn't appear in time to launch the agent — open it from the dashboard.`,
        "info",
      );
      return;
    }
    const launchTarget: ManagedLaunchTarget = {
      projectId: spec.projectId,
      worktreeId: row.id,
      cwd: row.path,
      background: true,
    };
    if (spec.harness !== undefined) {
      launchTarget.harness = spec.harness;
    }
    await runManagedLaunch(agentWorktreePaneId(row.id), launchTarget);
  }

  return {
    launchPrimaryAgent: (paneId, target) => {
      // Fire-and-forget so executeOutcome stays synchronous; any throw becomes a toast, never an
      // unhandled rejection, so the failures-toast contract holds end to end.
      void runManagedLaunch(paneId, target).catch((error) => {
        pushLaunchError(error);
      });
    },
    launchHostedNewSession: (target) => {
      // Harness comes from the wizard pick; New Session keeps the overlay open.
      closeNewSessionWizard();
      startHostedWorktreeLaunch({
        localId: `station-create:${target.projectId}:${target.branch}`,
        projectId: target.projectId,
        branch: target.branch,
        harness: target.harness,
        command: {
          type: "worktree.create",
          payload: { projectId: target.projectId, branch: target.branch },
        },
        verb: "create",
      });
    },
    launchHostedForkSession: (target) => {
      // Fork inherits the source's harness (the seeded worktree has none yet).
      closeForkSheet();
      startHostedWorktreeLaunch({
        localId: `station-fork:${target.sourceWorktreeId}:${target.branch}`,
        projectId: target.projectId,
        branch: target.branch,
        harness:
          stationViewStore === undefined
            ? undefined
            : inheritedForkHarness(stationViewStore, target.projectId, target.sourceWorktreeId),
        command: { type: "worktree.fork", payload: { ...target } },
        verb: "fork",
      });
    },
  };
}
