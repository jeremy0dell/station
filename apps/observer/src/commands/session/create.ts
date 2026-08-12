import type { ProviderProjectConfig, WorktreeObservation } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import type {
  EventJournal,
  SessionSeedGroupProvenance,
  SessionStore,
} from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import type { StationLogger } from "../../stationLogger.js";
import { assertCommandType } from "../assertCommand.js";
import type { HarnessLaunchPreflight } from "../harnessLaunchPreflight.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import type { TerminalIntentRunner } from "../terminalIntentRunner.js";
import {
  buildEnsureAgentWorkspaceIntent,
  defaultSessionCommandIdFactory,
  discardSessionSeedBestEffort,
  findProjectOrThrow,
  publishSessionCreated,
  removeWorktreeBestEffort,
  resolveHarnessProviderOrThrow,
  resolveTerminalProviderOrThrow,
  runProviderMutation,
  type SessionCommandIdFactory,
  seedSession,
  sessionSeedGroupPlacement,
  throwIfAborted,
} from "./shared.js";

export type CreateSessionCreateHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  terminalIntentRunner: TerminalIntentRunner;
  launchPreflight: HarnessLaunchPreflight;
  core: ObserverCore;
  persistence: SessionStore & EventJournal;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  logger?: StationLogger | undefined;
  commandTimeoutMs?: number | undefined;
};

/**
 * USE CASE
 *
 * Preflights the selected harness, creates a session worktree on its generated branch, durably
 * seeds its independent title with optional atomic root Group placement or inline Group creation,
 * and launches its primary agent; cleanup removes owned placement only after verified rollback.
 */
export function createSessionCreateHandler(
  options: CreateSessionCreateHandlerOptions,
): CommandHandler {
  const idFactory = {
    ...defaultSessionCommandIdFactory,
    ...options.idFactory,
  };

  return async (context) => {
    assertCommandType(context, "session.create");
    throwIfAborted(context.signal);

    const payload = context.command.payload;
    const project = findProjectOrThrow(options.getProjects(), payload.projectId);
    resolveTerminalProviderOrThrow(options.providers, payload.terminal.provider);
    resolveHarnessProviderOrThrow(options.providers, payload.harness.provider);
    await options.launchPreflight(payload.harness.provider, context.signal);
    const sessionId = idFactory.sessionId();
    const group = sessionSeedGroupPlacement(payload.group, idFactory.sessionGroupId);
    const runtime = {
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      signal: context.signal,
      trace: context.trace,
    };
    let createdWorktree: WorktreeObservation | undefined;
    let sessionSeeded = false;
    let groupProvenance: SessionSeedGroupProvenance | undefined;

    try {
      const worktree = await runProviderMutation(
        {
          ...runtime,
          operation: `provider.${options.providers.worktree.id}.createWorktree`,
          fallback: {
            tag: "WorktreeProviderError",
            code: "WORKTREE_CREATE_FAILED",
            message: "The worktree provider failed to create the session worktree.",
            provider: options.providers.worktree.id,
          },
        },
        () =>
          options.providers.worktree.createWorktree({
            project,
            branch: payload.branch,
            ...(payload.base === undefined ? {} : { base: payload.base }),
          }),
      );
      createdWorktree = worktree;
      throwIfAborted(context.signal);

      const seed = await seedSession({
        persistence: options.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        initialTitle: payload.title ?? payload.branch,
        ...(group === undefined ? {} : { group }),
        clock: options.clock,
      });
      sessionSeeded = true;
      groupProvenance = seed.groupProvenance;
      throwIfAborted(context.signal);

      const receipt = await options.terminalIntentRunner.submitIntent(
        buildEnsureAgentWorkspaceIntent({
          commandId: context.commandId,
          project,
          worktree,
          sessionId,
          terminalProvider: payload.terminal.provider,
          harnessProvider: payload.harness.provider,
          harness: payload.harness,
          layout: payload.terminal.layout ?? project.defaults.layout,
          focus: payload.terminal.focus,
          origin: payload.terminal.origin,
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
      const worktreeRemoved =
        createdWorktree === undefined
          ? false
          : await removeWorktreeBestEffort({
              providers: options.providers,
              projectId: project.id,
              worktreeId: createdWorktree.id,
              expectedPath: createdWorktree.path,
              expectedBranch: createdWorktree.branch,
              expectedRegistrationIdentity: createdWorktree.registrationIdentity,
              context,
              logger: options.logger,
              clock: options.clock,
              commandTimeoutMs: options.commandTimeoutMs,
            });
      if (sessionSeeded) {
        await discardSessionSeedBestEffort({
          persistence: options.persistence,
          sessionId,
          ...(groupProvenance === undefined ? {} : { groupProvenance }),
          ...(worktreeRemoved && createdWorktree !== undefined
            ? { removedWorktree: { projectId: project.id, worktreeId: createdWorktree.id } }
            : {}),
          context,
          logger: options.logger,
          clock: options.clock,
        });
      }
      throw error;
    }

    const snapshot = await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:session.create",
      trace: context.trace,
    });
    await publishSessionCreated({
      snapshot,
      sessionId,
      persistence: options.persistence,
      eventBus: options.eventBus,
      context,
      clock: options.clock,
    });
  };
}
