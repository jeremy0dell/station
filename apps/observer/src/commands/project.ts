import type { RuntimeClock } from "@station/runtime";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import { assertCommandType } from "./assertCommand.js";
import type { ProjectConfigWriter } from "./projectConfigWriter.js";
import type { CommandHandler } from "./queue.js";
import { reconcileAndPublish } from "./reconcile.js";

export type CreateProjectCommandHandlerOptions = {
  core: ObserverCore;
  projectConfigWriter: ProjectConfigWriter;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
};

/**
 * USE CASE
 *
 * Adds a managed project through the configuration port, updates the live
 * configuration, and reconciles the published graph.
 */
export function createProjectAddHandler(
  options: CreateProjectCommandHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "project.add");
    const config = await options.projectConfigWriter.addProject(context.command.payload);
    options.core.updateConfig(config);
    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:project.add",
      trace: context.trace,
    });
  };
}

/**
 * USE CASE
 *
 * Removes a managed project through the configuration port, updates the live
 * configuration, and reconciles the published graph.
 */
export function createProjectRemoveHandler(
  options: CreateProjectCommandHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "project.remove");
    const config = await options.projectConfigWriter.removeProject(context.command.payload);
    options.core.updateConfig(config);
    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:project.remove",
      trace: context.trace,
    });
  };
}

/**
 * USE CASE
 *
 * Changes a project's default harness through the configuration port, updates
 * the live configuration, and reconciles the published graph.
 */
export function createProjectSetDefaultHarnessHandler(
  options: CreateProjectCommandHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "project.setDefaultHarness");
    const config = await options.projectConfigWriter.setDefaultHarness(context.command.payload);
    options.core.updateConfig(config);
    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:project.setDefaultHarness",
      trace: context.trace,
    });
  };
}
