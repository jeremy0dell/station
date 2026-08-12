import type { ProviderProjectConfig } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal, ObservationStore, SessionStore } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { nowIso } from "../../utils/time.js";
import { assertCommandType } from "../assertCommand.js";
import type { HarnessLaunchPreflight } from "../harnessLaunchPreflight.js";
import type { CommandHandler } from "../queue.js";
import type { TerminalIntentRunner } from "../terminalIntentRunner.js";
import {
  assertNoCurrentAgent,
  buildEnsureAgentWorkspaceIntent,
  defaultSessionCommandIdFactory,
  discardSessionSeedBestEffort,
  findProjectOrThrow,
  lookupWorktree,
  reconcileAndPublishSessionCreated,
  rememberedHarnessProviderForWorktree,
  resolveHarnessProviderOrThrow,
  resolveTerminalProviderOrThrow,
  type SessionCommandIdFactory,
  seedSession,
  throwIfAborted,
  validateSnapshotRow,
  worktreeObservationFromRow,
} from "./shared.js";

export type CreateSessionStartAgentHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  terminalIntentRunner: TerminalIntentRunner;
  launchPreflight: HarnessLaunchPreflight;
  core: ObserverCore;
  persistence: SessionStore & EventJournal & ObservationStore;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  logger?: StationLogger | undefined;
  commandTimeoutMs?: number | undefined;
};

/**
 * USE CASE
 *
 * Validates and preflights a fresh agent lifecycle before inheriting the worktree's canonical
 * display title. Failed launches discard only the fresh session projection.
 */
export function createSessionStartAgentHandler(
  options: CreateSessionStartAgentHandlerOptions,
): CommandHandler {
  const idFactory = {
    ...defaultSessionCommandIdFactory,
    ...options.idFactory,
  };

  return async (context) => {
    assertCommandType(context, "session.startAgent");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const project = findProjectOrThrow(options.getProjects(), payload.projectId);
    const terminalProviderId = payload.terminal?.provider ?? project.defaults.terminal;
    resolveTerminalProviderOrThrow(options.providers, terminalProviderId);
    const snapshot = options.core.getSnapshot();
    const row = snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
    validateSnapshotRow(row, payload.projectId);
    assertNoCurrentAgent(row);
    const sessionId = idFactory.sessionId();
    const runtime = {
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      signal: context.signal,
      trace: context.trace,
    };
    const worktree =
      row === undefined
        ? await lookupWorktree({
            providers: options.providers,
            persistence: options.persistence,
            project,
            worktreeId: payload.worktreeId,
            runtime,
          })
        : worktreeObservationFromRow(row, options.providers.worktree.id, nowIso(options.clock));
    throwIfAborted(context.signal);
    const harnessProviderId =
      payload.harness?.provider ??
      (await rememberedHarnessProviderForWorktree({
        persistence: options.persistence,
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        worktreePath: worktree.path,
      })) ??
      project.defaults.harness;
    resolveHarnessProviderOrThrow(options.providers, harnessProviderId);
    await options.launchPreflight(harnessProviderId, context.signal);

    let sessionSeeded = false;

    try {
      await seedSession({
        persistence: options.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        initialTitle: row?.title ?? worktree.branch,
        clock: options.clock,
      });
      sessionSeeded = true;
      throwIfAborted(context.signal);

      const receipt = await options.terminalIntentRunner.submitIntent(
        buildEnsureAgentWorkspaceIntent({
          commandId: context.commandId,
          project,
          worktree,
          sessionId,
          terminalProvider: terminalProviderId,
          harnessProvider: harnessProviderId,
          harness: payload.harness,
          layout: payload.terminal?.layout ?? project.defaults.layout,
          focus: payload.terminal?.focus,
          origin: payload.terminal?.origin,
          initialPrompt: payload.initialPrompt,
        }),
        {
          trace: context.trace,
          signal: context.signal,
          commandTimeoutMs: options.commandTimeoutMs,
        },
      );
      if (receipt.status === "rejected") {
        throw receipt.error;
      }
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

    const convergence = reconcileAndPublishSessionCreated({
      core: options.core,
      eventBus: options.eventBus,
      persistence: options.persistence,
      context,
      sessionId,
      clock: options.clock,
      reason: "command:session.startAgent",
    });
    if (row === undefined) {
      // A targeted restart lookup must not wait behind the full discovery it bypassed.
      void convergence.catch((error: unknown) => {
        void options.logger
          ?.warn("Deferred session start convergence failed.", {
            commandId: context.commandId,
            traceId: context.trace.traceId,
            sessionId,
            error,
          })
          .catch(() => undefined);
      });
      return;
    }
    await convergence;
  };
}
