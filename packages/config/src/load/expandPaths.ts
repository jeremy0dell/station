import type { MutableRecord } from "./common.js";
import { isRecord } from "./common.js";
import { resolveConfigPath } from "./paths.js";

type ExpandConfigPathsOptions = { configDir: string; homeDir: string };

export function expandConfigPaths(
  config: MutableRecord,
  options: ExpandConfigPathsOptions,
): MutableRecord {
  const observer = isRecord(config.observer)
    ? expandObserverPaths(config.observer, options)
    : config.observer;
  const worktree = isRecord(config.worktree)
    ? expandWorktreePaths(config.worktree, options)
    : config.worktree;
  const terminal = isRecord(config.terminal)
    ? expandTerminalPaths(config.terminal, options)
    : config.terminal;
  return { ...config, observer, worktree, terminal };
}

function expandObserverPaths(
  observer: MutableRecord,
  options: ExpandConfigPathsOptions,
): MutableRecord {
  const expandedObserver = { ...observer };
  if (typeof observer.socketPath === "string") {
    expandedObserver.socketPath = resolveConfigPath(
      observer.socketPath,
      options.homeDir,
      options.configDir,
    );
  }
  if (typeof observer.stateDir === "string") {
    expandedObserver.stateDir = resolveConfigPath(
      observer.stateDir,
      options.homeDir,
      options.configDir,
    );
  }
  return expandedObserver;
}

function expandWorktreePaths(
  worktree: MutableRecord,
  options: ExpandConfigPathsOptions,
): MutableRecord {
  const worktrunk = isRecord(worktree.worktrunk)
    ? expandWorktrunkPaths(worktree.worktrunk, options)
    : worktree.worktrunk;
  return {
    ...worktree,
    ...(worktrunk === undefined ? {} : { worktrunk }),
  };
}

function expandWorktrunkPaths(
  worktrunk: MutableRecord,
  options: ExpandConfigPathsOptions,
): MutableRecord {
  const expandedWorktrunk = { ...worktrunk };
  if (typeof worktrunk.configPath === "string") {
    expandedWorktrunk.configPath = resolveConfigPath(
      worktrunk.configPath,
      options.homeDir,
      options.configDir,
    );
  }
  if (typeof worktrunk.managedRoot === "string") {
    expandedWorktrunk.managedRoot = resolveConfigPath(
      worktrunk.managedRoot,
      options.homeDir,
      options.configDir,
    );
  }
  return expandedWorktrunk;
}

function expandTerminalPaths(
  terminal: MutableRecord,
  options: ExpandConfigPathsOptions,
): MutableRecord {
  const tmux = isRecord(terminal.tmux) ? expandTmuxPaths(terminal.tmux, options) : terminal.tmux;
  return {
    ...terminal,
    ...(tmux === undefined ? {} : { tmux }),
  };
}

function expandTmuxPaths(tmux: MutableRecord, options: ExpandConfigPathsOptions): MutableRecord {
  const expandedTmux = { ...tmux };
  if (typeof tmux.workbenchSocketPath === "string") {
    expandedTmux.workbenchSocketPath = resolveConfigPath(
      tmux.workbenchSocketPath,
      options.homeDir,
      options.configDir,
    );
  }
  return expandedTmux;
}
