import type { ProviderProjectConfig, StationCommand } from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import { createFeatureFlagEvaluator, type FeatureFlagEvaluator } from "../features/evaluator.js";
import type {
  EventJournal,
  RecoveryRepairStore,
  SessionGroupStore,
  SessionStore,
} from "../persistence/index.js";
import type { RecoveryRepairAuthorizationPort } from "../persistence/recoveryBackup.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import type { StationLogger } from "../stationLogger.js";
import {
  createWorktreeCreateCoordinator,
  type WorktreeCreateCoordinator,
} from "../worktreeCreateCoordinator.js";
import {
  createWorktreeMutationCoordinator,
  type WorktreeMutationCoordinator,
} from "../worktreeMutationCoordinator.js";
import {
  assertHarnessLaunchPreconditionsOrThrow,
  type HarnessLaunchPreflight,
} from "./harnessLaunchPreflight.js";
import {
  createProjectAddHandler,
  createProjectRemoveHandler,
  createProjectSetDefaultHarnessHandler,
} from "./project.js";
import type { ProjectConfigWriter } from "./projectConfigWriter.js";
import type { CommandQueue, ObserverCommandHandlers } from "./queue.js";
import { createObserverReconcileHandler } from "./reconcile.js";
import { createSessionAcknowledgeTurnHandler } from "./session/acknowledgeTurn.js";
import { createSessionCloseHandler } from "./session/close.js";
import { createSessionCreateHandler } from "./session/create.js";
import { createSessionForkHandler } from "./session/fork.js";
import { createSessionImportRecoveryHandleHandler } from "./session/importRecoveryHandle.js";
import { createPruneRecoveryHandleHandler } from "./session/pruneRecoveryHandle.js";
import { createSessionRenameHandler } from "./session/rename.js";
import { createSessionResumeAgentHandler } from "./session/resumeAgent.js";
import type { SessionCommandIdFactory } from "./session/shared.js";
import { createSessionStartAgentHandler } from "./session/startAgent.js";
import {
  createSessionGroupCommandHandlers,
  type SessionGroupCommandIdFactory,
} from "./sessionGroups.js";
import { createTerminalCloseHandler, createTerminalFocusHandler } from "./terminal.js";
import { createWorktreeCreateHandler } from "./worktree/create.js";
import { createWorktreeForkHandler } from "./worktree/fork.js";
import { createWorktreeRemoveHandler } from "./worktree/remove.js";

export type RegisterObserverCommandHandlersOptions = {
  queue: CommandQueue;
  core: ObserverCore;
  providers: ProviderRegistry;
  projects: readonly ProviderProjectConfig[];
  getProjects?: (() => readonly ProviderProjectConfig[]) | undefined;
  persistence: SessionStore & RecoveryRepairStore & SessionGroupStore & EventJournal;
  featureFlags?: FeatureFlagEvaluator | undefined;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  logger?: StationLogger | undefined;
  idFactory?: Partial<SessionCommandIdFactory & SessionGroupCommandIdFactory> | undefined;
  launchPreflight?: HarnessLaunchPreflight | undefined;
  projectConfigWriter: ProjectConfigWriter;
  worktreeMutations?: WorktreeMutationCoordinator | undefined;
  worktreeCreates?: WorktreeCreateCoordinator | undefined;
  repairRecoveryAuthorization?: RecoveryRepairAuthorizationPort | undefined;
};

/**
 * COMPOSITION ROOT
 *
 * Constructs process-lifetime Observer command use cases and registers their
 * handlers with the command queue.
 *
 * Runtime-prebound config-aware launch preflight and ProjectConfigWriter are composed here. One
 * shared create policy bounds per-project provider pressure and retains cross-command branch
 * ownership through rollback; the existing mutation coordinator serializes lifecycle use cases
 * across command and native activation boundaries. Digest-guarded recovery resume and exact-handle
 * prune share the persistence snapshot capability and receive only an injected private repair-proof
 * verifier. Handlers receive no configuration or home paths.
 */
export function registerObserverCommandHandlers(
  options: RegisterObserverCommandHandlersOptions,
): void {
  const getProjects = options.getProjects ?? (() => options.projects);
  const worktreeMutations = options.worktreeMutations ?? createWorktreeMutationCoordinator();
  const worktreeCreates = options.worktreeCreates ?? createWorktreeCreateCoordinator();
  const featureFlags = options.featureFlags ?? createFeatureFlagEvaluator();
  const launchPreflight: HarnessLaunchPreflight =
    options.launchPreflight ??
    ((providerId, context) =>
      assertHarnessLaunchPreconditionsOrThrow({
        providers: options.providers,
        providerId,
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
        ...(context?.beginMutation === undefined ? {} : { beginMutation: context.beginMutation }),
      }));
  const sessionGroupHandlers = createSessionGroupCommandHandlers({
    core: options.core,
    persistence: options.persistence,
    eventBus: options.eventBus,
    clock: options.clock,
    idFactory: options.idFactory,
  });
  const handlers = {
    "worktree.create": createWorktreeCreateHandler({
      getProjects,
      providers: options.providers,
      launchPreflight,
      core: options.core,
      eventBus: options.eventBus,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      logger: options.logger,
      worktreeCreates,
    }),
    "worktree.fork": createWorktreeForkHandler({
      getProjects,
      core: options.core,
      providers: options.providers,
      launchPreflight,
      eventBus: options.eventBus,
      clock: options.clock,
      logger: options.logger,
      worktreeCreates,
    }),
    "worktree.remove": createWorktreeRemoveHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      worktreeMutations,
      eventBus: options.eventBus,
      clock: options.clock,
      logger: options.logger,
    }),
    "session.create": createSessionCreateHandler({
      getProjects,
      providers: options.providers,
      launchPreflight,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      worktreeCreates,
    }),
    "session.startAgent": createSessionStartAgentHandler({
      getProjects,
      providers: options.providers,
      launchPreflight,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      worktreeMutations,
    }),
    "session.resumeAgent": createSessionResumeAgentHandler({
      getProjects,
      providers: options.providers,
      launchPreflight,
      core: options.core,
      persistence: options.persistence,
      featureFlags,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      worktreeMutations,
      ...(options.repairRecoveryAuthorization === undefined
        ? {}
        : { repairRecoveryAuthorization: options.repairRecoveryAuthorization }),
    }),
    "session.pruneRecoveryHandle": createPruneRecoveryHandleHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      featureFlags,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      worktreeMutations,
      ...(options.repairRecoveryAuthorization === undefined
        ? {}
        : { repairRecoveryAuthorization: options.repairRecoveryAuthorization }),
    }),
    "session.importRecoveryHandle": createSessionImportRecoveryHandleHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      featureFlags,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
    "session.fork": createSessionForkHandler({
      getProjects,
      providers: options.providers,
      launchPreflight,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      worktreeCreates,
    }),
    "terminal.focus": createTerminalFocusHandler({
      core: options.core,
      providers: options.providers,
      clock: options.clock,
    }),
    "terminal.close": createTerminalCloseHandler({
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
    "session.close": createSessionCloseHandler({
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      worktreeMutations,
    }),
    "session.rename": createSessionRenameHandler({
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
    "session.acknowledgeTurn": createSessionAcknowledgeTurnHandler({
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
    }),
    "observer.reconcile": createObserverReconcileHandler({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
    "project.add": createProjectAddHandler({
      core: options.core,
      projectConfigWriter: options.projectConfigWriter,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
    "project.remove": createProjectRemoveHandler({
      core: options.core,
      projectConfigWriter: options.projectConfigWriter,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
    "project.setDefaultHarness": createProjectSetDefaultHarnessHandler({
      core: options.core,
      projectConfigWriter: options.projectConfigWriter,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
    ...sessionGroupHandlers,
  } satisfies ObserverCommandHandlers;

  const commandTypes = Object.keys(handlers) as StationCommand["type"][];
  for (const commandType of commandTypes) {
    options.queue.registerHandler(commandType, handlers[commandType]);
  }

  void options.logger?.info("Observer command handlers registered.", {
    commandTypes,
  });
}
