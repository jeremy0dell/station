import type { ProviderProjectConfig, WorktreeObservation } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import type { RuntimeClock } from "@station/runtime";
import type { ObserverPersistence } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { assertCommandType } from "../assertCommand.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import {
  buildEnsureAgentWorkspaceIntent,
  defaultSessionCommandIdFactory,
  deleteSessionTitleSeedBestEffort,
  findProjectOrThrow,
  publishSessionCreated,
  removeWorktreeBestEffort,
  resolveHarnessProviderOrThrow,
  resolveTerminalProviderOrThrow,
  runProviderMutation,
  type SessionCommandIdFactory,
  seedSessionTitle,
  throwIfAborted,
} from "./shared.js";

export type CreateSessionCreateHandlerOptions = {
  getProjects: () => readonly ProviderProjectConfig[];
  providers: ProviderRegistry;
  core: ObserverCore;
  persistence: ObserverPersistence;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  logger?: JsonlLogger | undefined;
  commandTimeoutMs?: number | undefined;
};

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
    const sessionId = idFactory.sessionId();
    const runtime = {
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      signal: context.signal,
      trace: context.trace,
    };
    let createdWorktree: WorktreeObservation | undefined;
    let seededSessionTitle = false;

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

      await seedSessionTitle({
        persistence: options.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        title: payload.branch.trim(),
        clock: options.clock,
      });
      seededSessionTitle = true;
      throwIfAborted(context.signal);

      const receipt = await options.providers.terminalIntentRunner.submitIntent(
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
      if (seededSessionTitle) {
        await deleteSessionTitleSeedBestEffort({
          persistence: options.persistence,
          sessionId,
          context,
          logger: options.logger,
        });
      }
      if (createdWorktree !== undefined) {
        await removeWorktreeBestEffort({
          providers: options.providers,
          projectId: project.id,
          worktreeId: createdWorktree.id,
          context,
          logger: options.logger,
          clock: options.clock,
          commandTimeoutMs: options.commandTimeoutMs,
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
