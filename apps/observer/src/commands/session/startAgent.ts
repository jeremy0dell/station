import type { ProviderProjectConfig, SafeError, SessionView } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal, SessionStore } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { nowIso } from "../../utils/time.js";
import {
  createWorktreeMutationCoordinator,
  type WorktreeMutationCoordinator,
} from "../../worktreeMutationCoordinator.js";
import { assertCommandType } from "../assertCommand.js";
import { closeSessionResources } from "../cleanup/index.js";
import { worktreeMissingError } from "../errors.js";
import type { HarnessLaunchPreflight } from "../harnessLaunchPreflight.js";
import { resolveHarnessProviderOrThrow, resolveTerminalProviderOrThrow } from "../providers.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import { ensureAgentWorkspace } from "../terminalOperations.js";
import {
  assertNoCurrentAgent,
  defaultSessionCommandIdFactory,
  discardSessionSeedBestEffort,
  findProjectOrThrow,
  freshStartSessionMismatchError,
  publishSessionCreated,
  rememberedHarnessProviderForWorktree,
  type SessionCommandIdFactory,
  seedSession,
  throwIfAborted,
  validateSnapshotRow,
  worktreeObservationFromRow,
} from "./shared.js";

export type CreateSessionStartAgentHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  launchPreflight: HarnessLaunchPreflight;
  core: ObserverCore;
  persistence: SessionStore & EventJournal;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  logger?: StationLogger | undefined;
  worktreeMutations?: WorktreeMutationCoordinator | undefined;
};

/**
 * USE CASE
 *
 * Serializes fresh agent launch against lifecycle mutation for one worktree. Ordinary launch seeds a
 * new Station session, while identity-bound fresh-start consent retires the retained provider and
 * terminal execution before launching under the same durable session identity. Failed ordinary
 * launches discard only their seed; confirmed fresh-start failures retain canonical session state.
 */
export function createSessionStartAgentHandler(
  options: CreateSessionStartAgentHandlerOptions,
): CommandHandler {
  const idFactory = {
    ...defaultSessionCommandIdFactory,
    ...options.idFactory,
  };
  const worktreeMutations = options.worktreeMutations ?? createWorktreeMutationCoordinator();

  return async (context) => {
    assertCommandType(context, "session.startAgent");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    await worktreeMutations.run(payload.projectId, payload.worktreeId, async () => {
      throwIfAborted(context.signal);
      const project = findProjectOrThrow(options.getProjects(), payload.projectId);
      const terminalProviderId = payload.terminal?.provider ?? project.defaults.terminal;
      const terminal = resolveTerminalProviderOrThrow(options.providers, terminalProviderId);
      const snapshot = options.core.getSnapshot();
      const row = snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
      validateSnapshotRow(row, payload.projectId);
      assertNoCurrentAgent(row);
      if (row === undefined) {
        throw worktreeMissingError({
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
          message: "The requested worktree is not visible in the current snapshot.",
        });
      }

      const retainedSession = snapshot.sessions.find(
        (candidate) =>
          candidate.origin === "station" &&
          candidate.projectId === payload.projectId &&
          candidate.worktreeId === payload.worktreeId,
      );
      const freshStart = payload.freshStart;
      if (freshStart === undefined && retainedSession !== undefined) {
        throw freshStartRequiredError(retainedSession);
      }
      if (
        freshStart !== undefined &&
        (retainedSession === undefined || retainedSession.id !== freshStart.expectedSessionId)
      ) {
        throw freshStartSessionMismatchError({
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
          sessionId: freshStart.expectedSessionId,
        });
      }

      const worktree = worktreeObservationFromRow(
        row,
        options.providers.worktree.id,
        nowIso(options.clock),
      );
      throwIfAborted(context.signal);
      const harnessProviderId =
        retainedSession?.harness.provider ??
        payload.harness?.provider ??
        (await rememberedHarnessProviderForWorktree({
          persistence: options.persistence,
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
          worktreePath: worktree.path,
        })) ??
        project.defaults.harness;
      const harness = resolveHarnessProviderOrThrow(options.providers, harnessProviderId);
      await options.launchPreflight(harnessProviderId, context.signal);

      if (freshStart !== undefined && retainedSession !== undefined) {
        await closeSessionResources({
          providers: options.providers,
          session: retainedSession,
          row,
          mode: "terminal",
          force: false,
          context,
          clock: options.clock,
        });
        throwIfAborted(context.signal);
        await options.persistence.resetSessionForFreshStart({
          provider: retainedSession.harness.provider,
          sessionId: retainedSession.id,
        });
      }

      const sessionId = retainedSession?.id ?? idFactory.sessionId();
      let sessionSeeded = false;
      try {
        if (retainedSession === undefined) {
          await seedSession({
            persistence: options.persistence,
            sessionId,
            projectId: project.id,
            worktreeId: worktree.id,
            initialTitle: row.title,
            harness: harnessProviderId,
            terminalProvider: terminalProviderId,
            clock: options.clock,
          });
          sessionSeeded = true;
        }
        throwIfAborted(context.signal);

        await ensureAgentWorkspace({
          terminal,
          harness,
          launchPreflight: options.launchPreflight,
          project,
          worktree,
          sessionId,
          harnessOptions: payload.harness,
          layout: payload.terminal?.layout ?? project.defaults.layout,
          focus: payload.terminal?.focus,
          origin: payload.terminal?.origin,
          initialPrompt: payload.initialPrompt,
          context,
          clock: options.clock,
          logger: options.logger,
        });
        throwIfAborted(context.signal);
      } catch (error) {
        if (sessionSeeded) {
          await discardSessionSeedBestEffort({
            persistence: options.persistence,
            sessionId,
            context,
            logger: options.logger,
          });
        }
        throw error;
      }

      const nextSnapshot = await reconcileAndPublish({
        core: options.core,
        eventBus: options.eventBus,
        clock: options.clock,
        reason: "command:session.startAgent",
        trace: context.trace,
      });
      if (sessionSeeded) {
        await publishSessionCreated({
          snapshot: nextSnapshot,
          sessionId,
          persistence: options.persistence,
          eventBus: options.eventBus,
          context,
          clock: options.clock,
        });
      }
    });
  };
}

function freshStartRequiredError(session: SessionView): SafeError {
  return {
    tag: "CommandValidationError",
    code: "SESSION_FRESH_START_REQUIRED",
    message: "This retained Station session requires explicit fresh-start consent.",
    hint: "Refresh the dashboard and confirm Start fresh before replacing its provider session.",
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    sessionId: session.id,
  };
}
