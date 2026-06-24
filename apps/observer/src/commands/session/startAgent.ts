import type {
  EnsureAgentWorkspaceIntent,
  ProviderProjectConfig,
  WorktreeObservation,
  WorktreeRow,
} from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import type { RuntimeClock } from "@station/runtime";
import type { ObserverPersistence } from "../../persistence/index.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type { ObserverCore } from "../../reconcile/core.js";
import type { ObserverEventBus } from "../../runtime/eventBus.js";
import { nowIso } from "../../utils/time.js";
import { assertCommandType } from "../assertCommand.js";
import { worktreeMissingError } from "../errors.js";
import type { CommandHandler } from "../queue.js";
import { reconcileAndPublish } from "../reconcile.js";
import {
  assertNoCurrentAgent,
  defaultSessionCommandIdFactory,
  deleteSessionTitleSeedBestEffort,
  findProjectOrThrow,
  publishSessionCreated,
  rememberedHarnessProviderForWorktree,
  resolveHarnessProviderOrThrow,
  resolveTerminalProviderOrThrow,
  runProviderMutation,
  type SessionCommandIdFactory,
  seedSessionTitle,
  throwIfAborted,
  worktreeObservationFromRow,
} from "./shared.js";

export type CreateSessionStartAgentHandlerOptions = {
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
            projectId: payload.projectId,
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

    let seededSessionTitle = false;

    try {
      await seedSessionTitle({
        persistence: options.persistence,
        sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        title: worktree.branch,
        clock: options.clock,
      });
      seededSessionTitle = true;
      throwIfAborted(context.signal);

      const receipt = await options.providers.terminalIntentRunner.submitIntent(
        ensureAgentWorkspaceIntent({
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
      if (seededSessionTitle) {
        await deleteSessionTitleSeedBestEffort({
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

function ensureAgentWorkspaceIntent(input: {
  commandId: string;
  project: ProviderProjectConfig;
  worktree: WorktreeObservation;
  sessionId: string;
  terminalProvider: string;
  harnessProvider: string;
  harness:
    | {
        mode?: "interactive" | "exec" | undefined;
        profile?: string | undefined;
      }
    | undefined;
  layout: string;
  focus?: boolean | undefined;
  origin?: EnsureAgentWorkspaceIntent["origin"] | undefined;
  initialPrompt?: string | undefined;
}): EnsureAgentWorkspaceIntent {
  const intent: EnsureAgentWorkspaceIntent = {
    type: "session.ensureAgentWorkspace",
    commandId: input.commandId,
    terminalProvider: input.terminalProvider,
    project: input.project,
    worktree: input.worktree,
    sessionId: input.sessionId,
    harness: {
      provider: input.harnessProvider,
    },
    layout: input.layout,
  };
  if (input.harness?.mode !== undefined) intent.harness.mode = input.harness.mode;
  if (input.harness?.profile !== undefined) intent.harness.profile = input.harness.profile;
  if (input.focus !== undefined) intent.focus = input.focus;
  if (input.origin !== undefined) intent.origin = input.origin;
  if (input.initialPrompt !== undefined) intent.initialPrompt = input.initialPrompt;
  return intent;
}

function validateSnapshotRow(row: WorktreeRow | undefined, projectId: string): void {
  if (row === undefined || row.projectId === projectId) {
    return;
  }
  throw {
    tag: "CommandValidationError",
    code: "WORKTREE_PROJECT_MISMATCH",
    message: "The requested worktree belongs to a different configured project.",
    projectId,
    worktreeId: row.id,
  };
}

async function lookupWorktree(input: {
  providers: ProviderRegistry;
  projectId: string;
  worktreeId: string;
  runtime: {
    clock?: RuntimeClock | undefined;
    commandTimeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    trace?:
      | {
          traceId?: string | undefined;
          spanId?: string | undefined;
          operation?: string | undefined;
        }
      | undefined;
  };
}): Promise<WorktreeObservation> {
  if (input.providers.worktree.getWorktree === undefined) {
    throw worktreeMissingError({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      message: "The requested worktree is not visible to the worktree provider.",
    });
  }

  const worktree = await runProviderMutation(
    {
      ...input.runtime,
      operation: `provider.${input.providers.worktree.id}.getWorktree`,
      fallback: {
        tag: "WorktreeProviderError",
        code: "WORKTREE_LOOKUP_FAILED",
        message: "The worktree provider failed to look up the worktree.",
        provider: input.providers.worktree.id,
      },
    },
    () =>
      input.providers.worktree.getWorktree?.({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
      }) as Promise<WorktreeObservation | null>,
  );
  if (worktree === null) {
    throw worktreeMissingError({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      message: "The requested worktree is not visible to the worktree provider.",
    });
  }
  return worktree;
}
