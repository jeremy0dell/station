import type { ProviderProjectConfig } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type { EventJournal, SessionStore } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { nowIso } from "../../utils/time.js";
import { assertCommandType } from "../assertCommand.js";
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
};

/**
 * USE CASE
 *
 * Requires the selected worktree in the current Observer snapshot, then validates and preflights a fresh
 * agent lifecycle before inheriting its canonical display title. Failed launches discard only the fresh session projection.
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
    const terminal = resolveTerminalProviderOrThrow(options.providers, terminalProviderId);
    const snapshot = options.core.getSnapshot();
    const row = snapshot.rows.find((candidate) => candidate.id === payload.worktreeId);
    validateSnapshotRow(row, payload.projectId);
    assertNoCurrentAgent(row);
    const sessionId = idFactory.sessionId();
    if (row === undefined) {
      throw worktreeMissingError({
        projectId: payload.projectId,
        worktreeId: payload.worktreeId,
        message: "The requested worktree is not visible in the current snapshot.",
      });
    }
    const worktree = worktreeObservationFromRow(
      row,
      options.providers.worktree.id,
      nowIso(options.clock),
    );
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
    const harness = resolveHarnessProviderOrThrow(options.providers, harnessProviderId);
    await options.launchPreflight(harnessProviderId, context.signal);

    let sessionSeeded = false;

    try {
      await seedSession({
        persistence: options.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        initialTitle: row?.title ?? worktree.branch,
        harness: harnessProviderId,
        terminalProvider: terminalProviderId,
        clock: options.clock,
      });
      sessionSeeded = true;
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
    await publishSessionCreated({
      snapshot: nextSnapshot,
      sessionId,
      persistence: options.persistence,
      eventBus: options.eventBus,
      context,
      clock: options.clock,
    });
  };
}
