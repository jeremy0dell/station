import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RealE2eEnvironment } from "./env";
import { requireToolPath } from "./env";
import type { RealTempRepo } from "./repo";
import { closeRealTmuxEndpoint, createRealTmuxEndpoint, type RealTmuxEndpoint } from "./tmux";

export type RealStationConfigFixture = {
  configPath: string;
  stateDir: string;
  socketPath: string;
  worktrunkConfigPath: string;
  tmuxEndpoint: RealTmuxEndpoint;
  tmuxSession: string;
  projectId: string;
};

export type WriteRealStationConfigOptions = {
  env: RealE2eEnvironment;
  repo: RealTempRepo;
  projectId?: string;
  autoStartFromHooks?: boolean;
  harnessProvider?: "claude" | "codex" | "pi" | "opencode" | "scripted";
  claudeCommand?: string;
  codexCommand?: string;
  piCommand?: string;
  opencodeCommand?: string;
  scriptedCommand?: string;
  installClaudeHooks?: boolean;
  installCodexHooks?: boolean;
  installOpenCodeHooks?: boolean;
  useLifecycleHooks?: boolean;
  recovery?: boolean;
  stationPersistentAgents?: boolean;
  tmuxSession?: string;
  sessionCreatePolicy?: {
    focusCreatedSession: boolean;
    dismissDashboard: boolean;
    terminals?: Readonly<
      Record<string, { focusCreatedSession?: boolean; dismissDashboard?: boolean }>
    >;
  };
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
  const worktrunkCommand = requireToolPath(options.env, "worktrunk");
  const harnessLines = harnessConfigLines(options, harnessProvider);
  await ensurePrivateDirectory(stateDir);
  await ensurePrivateDirectory(dirname(socketPath));
  await mkdir(join(options.repo.root, "worktrunk"), { recursive: true });
  const tmuxEndpoint = await createRealTmuxEndpoint(options.env);

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
    `command = ${tomlString(worktrunkCommand)}`,
    `config_path = ${tomlString(worktrunkConfigPath)}`,
    `use_lifecycle_hooks = ${options.useLifecycleHooks === true ? "true" : "false"}`,
    `hook_mode = ${tomlString(options.useLifecycleHooks === true ? "required-for-mvp" : "disabled")}`,
    "",
    "[terminal.tmux]",
    `command = ${tomlString(tmuxEndpoint.wrapperPath)}`,
    `workbench_socket_path = ${tomlString(tmuxEndpoint.socketPath)}`,
    `workbench_session = ${tomlString(tmuxSession)}`,
    "",
    ...sessionCreateConfigLines(options),
    ...harnessLines,
    ...eventHookConfigLines(options),
    ...featureFlagConfigLines(options),
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
  try {
    await writeFile(configPath, lines.join("\n"), "utf8");
  } catch (error) {
    try {
      await closeRealTmuxEndpoint(tmuxEndpoint);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "config write and tmux cleanup failed");
    }
    throw error;
  }

  return {
    configPath,
    stateDir,
    socketPath,
    tmuxEndpoint,
    worktrunkConfigPath,
    tmuxSession,
    projectId,
  };
}

function sessionCreateConfigLines(options: WriteRealStationConfigOptions): string[] {
  const policy = options.sessionCreatePolicy;
  if (policy === undefined) return [];
  const lines = [
    "[tui.session_create]",
    `focus_created_session = ${policy.focusCreatedSession}`,
    `dismiss_dashboard = ${policy.dismissDashboard}`,
    "",
  ];
  for (const [provider, override] of Object.entries(policy.terminals ?? {})) {
    lines.push(`[tui.session_create.terminals.${tomlKey(provider)}]`);
    if (override.focusCreatedSession !== undefined) {
      lines.push(`focus_created_session = ${override.focusCreatedSession}`);
    }
    if (override.dismissDashboard !== undefined) {
      lines.push(`dismiss_dashboard = ${override.dismissDashboard}`);
    }
    lines.push("");
  }
  return lines;
}

function featureFlagConfigLines(options: WriteRealStationConfigOptions): string[] {
  if (options.recovery !== true && options.stationPersistentAgents !== true) {
    return [];
  }
  return [
    "[feature_flags]",
    `session_resume_agent = ${options.recovery === true ? "true" : "false"}`,
    `station_persistent_agents = ${options.stationPersistentAgents === true ? "true" : "false"}`,
    "",
  ];
}

function eventHookConfigLines(options: WriteRealStationConfigOptions): string[] {
  if (options.eventHook === undefined) {
    return [];
  }
  return [
    "[[hooks.event]]",
    'id = "notify-agent-state"',
    'events = ["worktree.agentStateChanged"]',
    `command = ${tomlString(options.eventHook.command)}`,
    `args = [${(options.eventHook.args ?? []).map(tomlString).join(", ")}]`,
    "timeout_ms = 3000",
    "",
  ];
}

function harnessConfigLines(
  options: WriteRealStationConfigOptions,
  harnessProvider: "claude" | "codex" | "pi" | "opencode" | "scripted",
): string[] {
  if (harnessProvider === "claude") {
    return [
      "[harness.claude]",
      "enabled = true",
      `command = ${tomlString(options.claudeCommand ?? requireToolPath(options.env, "claude"))}`,
      'permission_mode = "yolo"',
      `install_hooks = ${options.installClaudeHooks === true ? "true" : "false"}`,
      ...(options.recovery === true ? ["resume = true"] : []),
      "",
    ];
  }

  if (harnessProvider === "pi") {
    return [
      "[harness.pi]",
      "enabled = true",
      `command = ${tomlString(options.piCommand ?? requireToolPath(options.env, "pi"))}`,
      ...(options.recovery === true ? ["resume = true"] : []),
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
      ...(options.recovery === true ? ["resume = true"] : []),
      "",
    ];
  }

  if (harnessProvider === "scripted") {
    return [
      "[harness.scripted]",
      "enabled = true",
      `command = ${tomlString(options.scriptedCommand ?? process.execPath)}`,
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
    ...(options.recovery === true ? ["resume = true"] : []),
    "",
  ];
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export function uniqueTmuxSession(prefix = "station-real"): string {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : tomlString(value);
}
