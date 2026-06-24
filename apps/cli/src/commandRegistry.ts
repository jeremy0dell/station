import { createCliCommandRegistryApi } from "./commands/cliCommand/logic.js";
import type { CliCommandNode } from "./commands/cliCommand/types.js";
import { commandCliCommand } from "./commands/registry/command.js";
import { debugCliCommand } from "./commands/registry/debug.js";
import { doctorCliCommand } from "./commands/registry/doctor.js";
import { eventHooksCliCommand } from "./commands/registry/eventHooks.js";
import { hooksCliCommand } from "./commands/registry/hooks.js";
import { notifyCliCommand } from "./commands/registry/notify.js";
import { observeCliCommand } from "./commands/registry/observe.js";
import { observerCliCommand } from "./commands/registry/observer.js";
import { popupCliCommand } from "./commands/registry/popup.js";
import { projectCliCommand } from "./commands/registry/project.js";
import { reconcileCliCommand } from "./commands/registry/reconcile.js";
import { setupCliCommand } from "./commands/registry/setup.js";
import { snapshotCliCommand } from "./commands/registry/snapshot.js";
import { tuiCliCommand } from "./commands/registry/tui.js";
import { worktrunkCliCommand } from "./commands/registry/worktrunk.js";

export type {
  CliCommandConfigErrorContext,
  CliCommandNode,
  CliCommandOption,
  CliCommandRoute,
  CliCommandRunContext,
  CliCommandTopic,
  CliHelpMode,
} from "./commands/cliCommand/types.js";

export const cliCommandRegistry: CliCommandNode = {
  name: "stn",
  description: "STATION is a terminal-native control plane for AI-agent worktree sessions.",
  usage: ["stn [--config <path>] [command]", "stn --help", "stn --man"],
  options: [
    { name: "--config <path>", description: "Use a specific STATION config file." },
    { name: "-h, --help", description: "Print concise help for a command path." },
    { name: "--man", description: "Print the fuller manual for a command path." },
  ],
  examples: ["pnpm stn --help", "pnpm stn doctor --help", "pnpm stn project add --man"],
  notes: [
    "Help and manual topics are resolved before STATION reads config or starts the observer.",
    "Running STATION without a command opens the popup inside tmux and the fullscreen TUI outside tmux.",
    "Commands that inspect or mutate live state may contact or start the observer when run without --help or --man.",
  ],
  verification: ["pnpm stn --help", "pnpm stn doctor --help", "pnpm stn project add --man"],
  children: [
    commandCliCommand,
    debugCliCommand,
    doctorCliCommand,
    eventHooksCliCommand,
    hooksCliCommand,
    notifyCliCommand,
    observeCliCommand,
    observerCliCommand,
    popupCliCommand,
    projectCliCommand,
    reconcileCliCommand,
    setupCliCommand,
    snapshotCliCommand,
    tuiCliCommand,
    worktrunkCliCommand,
  ],
};

const registryApi = createCliCommandRegistryApi(cliCommandRegistry);

export const isTopLevelCliCommand = registryApi.isTopLevelCliCommand;
export const cliCommandRequiresConfig = registryApi.cliCommandRequiresConfig;
export const resolveCliCommandRoute = registryApi.resolveCliCommandRoute;
export const runCliCommandRoute = registryApi.runCliCommandRoute;
export const handleCliCommandConfigError = registryApi.handleCliCommandConfigError;
export const resolveCliCommandTopic = registryApi.resolveCliCommandTopic;
export const renderCliCommandHelpTopic = registryApi.renderCliCommandHelpTopic;
