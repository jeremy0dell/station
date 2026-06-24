import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RealE2eEnvironment } from "./env";
import { requireToolPath } from "./env";
import type { RealTempRepo } from "./repo";

export type RealStationConfigFixture = {
  configPath: string;
  stateDir: string;
  socketPath: string;
  worktrunkConfigPath: string;
  tmuxSession: string;
  projectId: string;
};

export type WriteRealStationConfigOptions = {
  env: RealE2eEnvironment;
  repo: RealTempRepo;
  projectId?: string;
  autoStartFromHooks?: boolean;
  harnessProvider?: "claude" | "codex" | "pi" | "opencode";
  claudeCommand?: string;
  codexCommand?: string;
  piCommand?: string;
  opencodeCommand?: string;
  installClaudeHooks?: boolean;
  installCodexHooks?: boolean;
  installOpenCodeHooks?: boolean;
  useLifecycleHooks?: boolean;
  tmuxSession?: string;
  eventHook?: {
    command: string;
    args?: string[];
  };
};

export async function writeRealStationConfig(
  options: WriteRealStationConfigOptions,
): Promise<RealStationConfigFixture> {
  const projectId = options.projectId ?? "station-real";
  const harnessProvider = options.harnessProvider ?? "codex";
  const stateDir = join(options.repo.root, "state");
  const socketPath = join(options.repo.root, "run", "observer.sock");
  const worktrunkConfigPath = join(options.repo.root, "worktrunk", "config.toml");
  const configPath = join(options.repo.root, "station.config.toml");
  const tmuxSession = options.tmuxSession ?? uniqueTmuxSession();
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(options.repo.root, "run"), { recursive: true });
  await mkdir(join(options.repo.root, "worktrunk"), { recursive: true });

  const lines = [
    "schema_version = 1",
    "",
    "[observer]",
    `socket_path = ${tomlString(socketPath)}`,
    `state_dir = ${tomlString(stateDir)}`,
    `auto_start_from_hooks = ${options.autoStartFromHooks === false ? "false" : "true"}`,
    "",
    "[defaults]",
    'worktree_provider = "worktrunk"',
    'terminal = "tmux"',
    `harness = ${tomlString(harnessProvider)}`,
    'layout = "agent-shell"',
    "",
    "[worktree.worktrunk]",
    `command = ${tomlString(requireToolPath(options.env, "worktrunk"))}`,
    `config_path = ${tomlString(worktrunkConfigPath)}`,
    `use_lifecycle_hooks = ${options.useLifecycleHooks === true ? "true" : "false"}`,
    `hook_mode = ${tomlString(options.useLifecycleHooks === true ? "required-for-mvp" : "disabled")}`,
    "",
    "[terminal.tmux]",
    `workbench_session = ${tomlString(tmuxSession)}`,
    "",
    ...harnessConfigLines(options, harnessProvider),
    ...eventHookConfigLines(options),
    "[[projects]]",
    `id = ${tomlString(projectId)}`,
    'label = "station real E2E"',
    `root = ${tomlString(options.repo.repoPath)}`,
    `default_branch = ${tomlString(options.repo.baseBranch)}`,
    "",
    "[projects.defaults]",
    `harness = ${tomlString(harnessProvider)}`,
    'terminal = "tmux"',
    'layout = "agent-shell"',
    "",
    "[projects.worktrunk]",
    "enabled = true",
    `base = ${tomlString(options.repo.baseBranch)}`,
    'managed_root = ".station-real-e2e/worktrees"',
    "include_main = false",
    "include_external = false",
    "",
  ];
  await writeFile(configPath, lines.join("\n"), "utf8");

  return {
    configPath,
    stateDir,
    socketPath,
    worktrunkConfigPath,
    tmuxSession,
    projectId,
  };
}

function eventHookConfigLines(options: WriteRealStationConfigOptions): string[] {
  if (options.eventHook === undefined) {
    return [];
  }
  return [
    "[[hooks.event]]",
    'id = "notify-agent-idle"',
    'events = ["worktree.agentStateChanged"]',
    `command = ${tomlString(options.eventHook.command)}`,
    `args = [${(options.eventHook.args ?? []).map(tomlString).join(", ")}]`,
    "timeout_ms = 3000",
    "",
  ];
}

function harnessConfigLines(
  options: WriteRealStationConfigOptions,
  harnessProvider: "claude" | "codex" | "pi" | "opencode",
): string[] {
  if (harnessProvider === "claude") {
    return [
      "[harness.claude]",
      "enabled = true",
      `command = ${tomlString(options.claudeCommand ?? requireToolPath(options.env, "claude"))}`,
      'permission_mode = "yolo"',
      `install_hooks = ${options.installClaudeHooks === true ? "true" : "false"}`,
      "",
    ];
  }

  if (harnessProvider === "pi") {
    return [
      "[harness.pi]",
      "enabled = true",
      `command = ${tomlString(options.piCommand ?? requireToolPath(options.env, "pi"))}`,
      "",
    ];
  }

  if (harnessProvider === "opencode") {
    return [
      "[harness.opencode]",
      "enabled = true",
      `command = ${tomlString(options.opencodeCommand ?? requireToolPath(options.env, "opencode"))}`,
      'sandbox_mode = "workspace-write"',
      'approval_policy = "never"',
      `install_hooks = ${options.installOpenCodeHooks === true ? "true" : "false"}`,
      "",
    ];
  }

  return [
    "[harness.codex]",
    "enabled = true",
    `command = ${tomlString(options.codexCommand ?? requireToolPath(options.env, "codex"))}`,
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    `install_hooks = ${options.installCodexHooks === true ? "true" : "false"}`,
    "",
  ];
}

export function uniqueTmuxSession(prefix = "station-real"): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
