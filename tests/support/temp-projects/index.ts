import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StationConfig } from "@station/config";

const tempRoots = new Set<string>();
let exitCleanupRegistered = false;

export async function createTempState(): Promise<{
  root: string;
  stateDir: string;
  socketPath: string;
  hookSpoolDir: string;
  config: StationConfig;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "station-project-"));
  registerTempRoot(root);
  const stateDir = join(root, "state");
  const socketPath = join(root, "run", "observer.sock");
  await mkdir(stateDir, { recursive: true });
  return {
    root,
    stateDir,
    socketPath,
    hookSpoolDir: join(stateDir, "spool", "hooks"),
    config: {
      schemaVersion: 1,
      observer: {
        stateDir,
        socketPath,
        autoStartFromHooks: true,
      },
      defaults: {
        worktreeProvider: "fake-worktree",
        terminal: "fake-terminal",
        harness: "fake-harness",
        layout: "agent-shell",
      },
      projects: [],
    },
    cleanup: () => cleanupTempRoot(root),
  };
}

export async function writeConfigToml(root: string, config: StationConfig): Promise<string> {
  const path = join(root, "config.toml");
  await writeFile(
    path,
    [
      "schema_version = 1",
      "projects = []",
      "",
      "[observer]",
      `socket_path = ${JSON.stringify(config.observer?.socketPath)}`,
      `state_dir = ${JSON.stringify(config.observer?.stateDir)}`,
      `auto_start_from_hooks = ${config.observer?.autoStartFromHooks ?? true}`,
      "",
      "[defaults]",
      `worktree_provider = ${JSON.stringify(config.defaults.worktreeProvider)}`,
      `terminal = ${JSON.stringify(config.defaults.terminal)}`,
      `harness = ${JSON.stringify(config.defaults.harness)}`,
      `layout = ${JSON.stringify(config.defaults.layout)}`,
      "",
      ...tuiConfigToml(config),
      ...(config.terminal?.tmux === undefined
        ? []
        : [
            "[terminal.tmux]",
            ...(config.terminal.tmux.popupWidth === undefined
              ? []
              : [`popup_width = ${JSON.stringify(config.terminal.tmux.popupWidth)}`]),
            ...(config.terminal.tmux.popupHeight === undefined
              ? []
              : [`popup_height = ${JSON.stringify(config.terminal.tmux.popupHeight)}`]),
            ...(config.terminal.tmux.popupPosition === undefined
              ? []
              : [`popup_position = ${JSON.stringify(config.terminal.tmux.popupPosition)}`]),
            "",
          ]),
    ].join("\n"),
  );
  return path;
}

function tuiConfigToml(config: StationConfig): string[] {
  if (config.tui === undefined) {
    return [];
  }
  if (config.tui.widgets === undefined) {
    return ["[tui]", ""];
  }
  if (config.tui.widgets.length === 0) {
    return ["[tui]", "widgets = []", ""];
  }

  return config.tui.widgets.flatMap((widget) => {
    if (widget.type === "time") {
      return [
        "[[tui.widgets]]",
        'type = "time"',
        ...(widget.timeFormat === undefined
          ? []
          : [`time_format = ${JSON.stringify(widget.timeFormat)}`]),
        "",
      ];
    }

    return [
      "[[tui.widgets]]",
      'type = "weather"',
      `city = ${JSON.stringify(widget.city)}`,
      ...(widget.label === undefined ? [] : [`label = ${JSON.stringify(widget.label)}`]),
      ...(widget.temperatureUnit === undefined
        ? []
        : [`temperature_unit = ${JSON.stringify(widget.temperatureUnit)}`]),
      ...(widget.refreshIntervalMinutes === undefined
        ? []
        : [`refresh_interval_minutes = ${widget.refreshIntervalMinutes}`]),
      "",
    ];
  });
}

async function cleanupTempRoot(root: string): Promise<void> {
  tempRoots.delete(root);
  await rm(root, { recursive: true, force: true });
}

function registerTempRoot(root: string): void {
  tempRoots.add(root);
  if (exitCleanupRegistered) {
    return;
  }
  exitCleanupRegistered = true;
  process.once("exit", cleanupTempRootsSync);
}

function cleanupTempRootsSync(): void {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
}
