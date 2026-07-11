import type { ProviderProjectConfig, StationCommand } from "@station/contracts";
import type { JsonlLogger } from "@station/observability";
import type { RuntimeClock } from "@station/runtime";
import { createFeatureFlagEvaluator, type FeatureFlagEvaluator } from "../features/evaluator.js";
import type { EventJournal, SessionStore } from "../persistence/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import {
  createProjectAddHandler,
  createProjectRemoveHandler,
  createProjectSetDefaultHarnessHandler,
} from "./project.js";
import type { CommandHandler, CommandQueue } from "./queue.js";
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
import { createTerminalIntentRunner, type TerminalIntentRunner } from "./terminalIntentRunner.js";
import { createWorktreeCreateHandler } from "./worktree/create.js";
import { createWorktreeForkHandler } from "./worktree/fork.js";
import { createWorktreeRemoveHandler } from "./worktree/remove.js";

export type RegisterObserverCommandHandlersOptions = {
  queue: CommandQueue;
  core: ObserverCore;
  providers: ProviderRegistry;
  projects: readonly ProviderProjectConfig[];
  getProjects?: (() => readonly ProviderProjectConfig[]) | undefined;
  persistence: SessionStore & EventJournal;
  featureFlags?: FeatureFlagEvaluator | undefined;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
  logger?: JsonlLogger | undefined;
  idFactory?: Partial<SessionCommandIdFactory> | undefined;
  commandTimeoutMs?: number | undefined;
  terminalIntentRunner?: TerminalIntentRunner | undefined;
  configPath?: string | undefined;
  homeDir?: string | undefined;
};

/**
 * COMPOSITION ROOT
 *
 * Constructs process-lifetime Observer command use cases and registers their
 * handlers with the command queue.
 *
 * Terminal intent orchestration is created once here and injected directly
 * into every handler that uses it.
 */
export function registerObserverCommandHandlers(
  options: RegisterObserverCommandHandlersOptions,
): void {
  const getProjects = options.getProjects ?? (() => options.projects);
  const featureFlags = options.featureFlags ?? createFeatureFlagEvaluator();
  const terminalIntentRunner =
    options.terminalIntentRunner ??
    createTerminalIntentRunner({
      providers: {
        terminals: options.providers.terminals,
        harnesses: options.providers.harnesses,
      },
      clock: options.clock,
      logger: options.logger,
      commandTimeoutMs: options.commandTimeoutMs,
    });
  const handlers = {
    "worktree.create": createWorktreeCreateHandler({
      getProjects,
      providers: options.providers,
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      logger: options.logger,
    }),
    "worktree.fork": createWorktreeForkHandler({
      getProjects,
      core: options.core,
      providers: options.providers,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
      logger: options.logger,
    }),
    "worktree.remove": createWorktreeRemoveHandler({
      providers: options.providers,
      terminalIntentRunner,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    "session.create": createSessionCreateHandler({
      getProjects,
      providers: options.providers,
      terminalIntentRunner,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    "session.startAgent": createSessionStartAgentHandler({
      getProjects,
      providers: options.providers,
      terminalIntentRunner,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    "session.resumeAgent": createSessionResumeAgentHandler({
      getProjects,
      providers: options.providers,
      terminalIntentRunner,
      core: options.core,
      persistence: options.persistence,
      featureFlags,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    "session.fork": createSessionForkHandler({
      getProjects,
      providers: options.providers,
      terminalIntentRunner,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      idFactory: options.idFactory,
      logger: options.logger,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    "terminal.focus": createTerminalFocusHandler({
      core: options.core,
      providers: options.providers,
      terminalIntentRunner,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    "terminal.close": createTerminalCloseHandler({
      providers: options.providers,
      terminalIntentRunner,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
    }),
    "session.close": createSessionCloseHandler({
      providers: options.providers,
      terminalIntentRunner,
      core: options.core,
      persistence: options.persistence,
      eventBus: options.eventBus,
      clock: options.clock,
      commandTimeoutMs: options.commandTimeoutMs,
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
      eventBus: options.eventBus,
      clock: options.clock,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    }),
    "project.remove": createProjectRemoveHandler({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    }),
    "project.setDefaultHarness": createProjectSetDefaultHarnessHandler({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    }),
  } satisfies Record<StationCommand["type"], CommandHandler>;

  const commandTypes = Object.keys(handlers) as StationCommand["type"][];
  for (const commandType of commandTypes) {
    options.queue.registerHandler(commandType, handlers[commandType]);
  }

  void options.logger?.info("Observer command handlers registered.", {
    commandTypes,
  });
}
