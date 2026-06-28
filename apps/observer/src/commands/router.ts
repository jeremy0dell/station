import type { ProviderProjectConfig } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import type { RuntimeClock } from "@station/runtime";
import { createFeatureFlagEvaluator, type FeatureFlagEvaluator } from "../features/evaluator.js";
import type { ObserverPersistence } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import {
  createProjectAddHandler,
  createProjectRemoveHandler,
  createProjectSetDefaultHarnessHandler,
} from "./project.js";
import type { CommandQueue } from "./queue.js";
import { createObserverReconcileHandler } from "./reconcile.js";
import { createSessionAcknowledgeTurnHandler } from "./session/acknowledgeTurn.js";
import { createSessionCloseHandler } from "./session/close.js";
import { createSessionCreateHandler } from "./session/create.js";
import { createSessionForkHandler } from "./session/fork.js";
import { createSessionRenameHandler } from "./session/rename.js";
import { createSessionResumeAgentHandler } from "./session/resumeAgent.js";
import type { SessionCommandIdFactory } from "./session/shared.js";
import { createSessionStartAgentHandler } from "./session/startAgent.js";
import { createTerminalCloseHandler, createTerminalFocusHandler } from "./terminal.js";
import { createWorktreeCreateHandler } from "./worktree/create.js";
import { createWorktreeRemoveHandler } from "./worktree/remove.js";

export type RegisterObserverCommandHandlersOptions = {
  queue: CommandQueue;
  core: ObserverCore;
  providers: ProviderRegistry;
  projects: readonly ProviderProjectConfig[];
  getProjects?: (() => readonly ProviderProjectConfig[]) | undefined;
  persistence: ObserverPersistence;
  featureFlags?: FeatureFlagEvaluator | undefined;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  logger?: JsonlLogger | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  commandTimeoutMs?: number | undefined;
  configPath?: string | undefined;
  homeDir?: string | undefined;
};

export function registerObserverCommandHandlers(
  options: RegisterObserverCommandHandlersOptions,
): void {
  const getProjects = options.getProjects ?? (() => options.projects);
  const featureFlags = options.featureFlags ?? createFeatureFlagEvaluator();
  options.queue.registerHandler(
    "observer.reconcile",
    createObserverReconcileHandler({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
  );
  options.queue.registerHandler(
    "terminal.focus",
    createTerminalFocusHandler({
      core: options.core,
      providers: options.providers,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
  );
  options.queue.registerHandler(
    "terminal.close",
    createTerminalCloseHandler({
      core: options.core,
      providers: options.providers,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
  );
  options.queue.registerHandler(
    "session.create",
    createSessionCreateHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
  );
  options.queue.registerHandler(
    "session.startAgent",
    createSessionStartAgentHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
  );
  options.queue.registerHandler(
    "session.resumeAgent",
    createSessionResumeAgentHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      featureFlags,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
  );
  options.queue.registerHandler(
    "session.fork",
    createSessionForkHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
  );
  options.queue.registerHandler(
    "session.close",
    createSessionCloseHandler({
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
  );
  options.queue.registerHandler(
    "session.rename",
    createSessionRenameHandler({
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
    }),
  );
  options.queue.registerHandler(
    "session.acknowledgeTurn",
    createSessionAcknowledgeTurnHandler({
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
    }),
  );
  options.queue.registerHandler(
    "worktree.create",
    createWorktreeCreateHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      logger: options.logger,
    }),
  );
  options.queue.registerHandler(
    "worktree.remove",
    createWorktreeRemoveHandler({
      providers: options.providers,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
  );
  options.queue.registerHandler(
    "project.add",
    createProjectAddHandler({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    }),
  );
  options.queue.registerHandler(
    "project.remove",
    createProjectRemoveHandler({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    }),
  );
  options.queue.registerHandler(
    "project.setDefaultHarness",
    createProjectSetDefaultHarnessHandler({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    }),
  );

  void options.logger?.info("Observer command handlers registered.", {
    commandTypes: [
      "observer.reconcile",
      "terminal.focus",
      "terminal.close",
      "session.create",
      "session.startAgent",
      "session.resumeAgent",
      "session.fork",
      "session.close",
      "session.rename",
      "session.acknowledgeTurn",
      "worktree.create",
      "worktree.remove",
      "project.add",
      "project.remove",
      "project.setDefaultHarness",
    ],
  });
}
