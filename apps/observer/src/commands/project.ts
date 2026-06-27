import {
  addProjectToConfig,
  removeProjectFromConfig,
  setProjectDefaultHarnessInConfig,
} from "@station/config";
import type { RuntimeClock } from "@station/runtime";
import type { ObserverCore } from "../reconcile/core.js";
import type { ObserverEventBus } from "../runtime/eventBus.js";
import { assertCommandType } from "./assertCommand.js";
import type { CommandHandler } from "./queue.js";
import { reconcileAndPublish } from "./reconcile.js";

export type CreateProjectCommandHandlerOptions = {
  core: ObserverCore;
  configPath?: string | undefined;
  homeDir?: string | undefined;
  eventBus?: ObserverEventBus | undefined;
  clock?: RuntimeClock | undefined;
};

export function createProjectAddHandler(
  options: CreateProjectCommandHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "project.add");
    const payload = context.command.payload;
    const result = await addProjectToConfig({
      path: payload.path,
      ...(payload.id === undefined ? {} : { id: payload.id }),
      ...(payload.label === undefined ? {} : { label: payload.label }),
      ...(payload.allowNonGit === undefined ? {} : { allowNonGit: payload.allowNonGit }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    });

    options.core.updateConfig(result.config);
    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:project.add",
      trace: context.trace,
    });
  };
}

export function createProjectRemoveHandler(
  options: CreateProjectCommandHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "project.remove");
    const result = await removeProjectFromConfig({
      projectId: context.command.payload.projectId,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    });

    options.core.updateConfig(result.config);
    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:project.remove",
      trace: context.trace,
    });
  };
}

export function createProjectSetDefaultHarnessHandler(
  options: CreateProjectCommandHandlerOptions,
): CommandHandler {
  return async (context) => {
    assertCommandType(context, "project.setDefaultHarness");
    const result = await setProjectDefaultHarnessInConfig({
      projectId: context.command.payload.projectId,
      harness: context.command.payload.harness,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    });

    options.core.updateConfig(result.config);
    await reconcileAndPublish({
      core: options.core,
      eventBus: options.eventBus,
      clock: options.clock,
      reason: "command:project.setDefaultHarness",
      trace: context.trace,
    });
  };
}
