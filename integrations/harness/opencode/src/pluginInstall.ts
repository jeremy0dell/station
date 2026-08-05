import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderHookArtifactOwner, ProviderHookArtifactOwnership } from "@station/contracts";
import {
  assertProviderHookArtifactOwnership,
  classifyProviderHookArtifactOwnership,
  createHookSetupFileOps,
  providerHookOwnerMarker,
} from "@station/runtime";
import { openCodeForwardedEventTypes } from "./ingressRules.js";

export const OPENCODE_STATION_PLUGIN_NAME = "station-agent-state.js";
export const OPENCODE_STATION_PLUGIN_MARKER = "station-opencode-observer-plugin:v1";

export type OpenCodePluginPlanOptions = {
  opencodeConfigDir?: string;
  pluginPath?: string;
  observerSocketPath?: string;
  stateDir?: string;
  hookSpoolDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  artifactOwner?: ProviderHookArtifactOwner;
  takeover?: boolean;
};

export type OpenCodePluginPlan = {
  provider: "opencode";
  configDir: string;
  pluginPath: string;
  changed: boolean;
  installed: boolean;
  before: string;
  after: string;
  ownership?: ProviderHookArtifactOwnership;
};

export type OpenCodePluginInstallResult = OpenCodePluginPlan & {
  installed: boolean;
  backupPath?: string;
  removed?: boolean;
};

export type OpenCodePluginDoctorResult = {
  provider: "opencode";
  configDir: string;
  pluginPath: string;
  status: "ok" | "warn";
  installed: boolean;
  changed: boolean;
  message: string;
  ownership?: ProviderHookArtifactOwnership;
};

const fileOps = createHookSetupFileOps(({ operation, path, cause }) => {
  return new Error(`OpenCode plugin setup ${operation} failed for ${path}.`, { cause });
});

export async function planOpenCodePlugin(
  options: OpenCodePluginPlanOptions = {},
): Promise<OpenCodePluginPlan> {
  const configDir = resolveOpenCodeConfigDir(options);
  const pluginPath = resolveOpenCodePluginPath(options);
  const before = await fileOps.readOptionalFile(pluginPath);
  const after = expectedOpenCodePluginScript(options);
  const changed = before !== after;
  const ownership = openCodePluginOwnership(before, options);
  const result: OpenCodePluginPlan = {
    provider: "opencode",
    configDir,
    pluginPath,
    changed,
    installed: before.includes(OPENCODE_STATION_PLUGIN_MARKER),
    before,
    after,
  };
  if (ownership !== undefined) result.ownership = ownership;
  return result;
}

export async function installOpenCodePlugin(
  options: OpenCodePluginPlanOptions = {},
): Promise<OpenCodePluginInstallResult> {
  const plan = await planOpenCodePlugin(options);
  const current = await fileOps.readOptionalFile(plan.pluginPath);
  assertOpenCodePluginOwnership("install", plan.pluginPath, current, options);
  let backupPath: string | undefined;
  if (plan.changed) {
    backupPath = await fileOps.backupIfPresent(plan.pluginPath);
    await fileOps.writeHookConfig(plan.pluginPath, plan.after);
  }
  const result: OpenCodePluginInstallResult = {
    ...plan,
    installed: true,
  };
  if (options.artifactOwner !== undefined) {
    result.ownership = {
      status: "same-owner",
      requested: options.artifactOwner,
      currentLauncher: options.artifactOwner.launcher,
    };
  }
  if (backupPath !== undefined) {
    result.backupPath = backupPath;
  }
  return result;
}

export async function uninstallOpenCodePlugin(
  options: OpenCodePluginPlanOptions = {},
): Promise<OpenCodePluginInstallResult> {
  const plan = await planOpenCodePlugin(options);
  const current = await fileOps.readOptionalFile(plan.pluginPath);
  assertOpenCodePluginOwnership("uninstall", plan.pluginPath, current, options);
  let removed = false;
  if (plan.before.includes(OPENCODE_STATION_PLUGIN_MARKER)) {
    removed = await fileOps.removeHookFileIfPresent(plan.pluginPath);
  }
  return {
    ...plan,
    changed: removed,
    installed: false,
    removed,
  };
}

export async function doctorOpenCodePlugin(
  options: OpenCodePluginPlanOptions & { enabled?: boolean } = {},
): Promise<OpenCodePluginDoctorResult> {
  const plan = await planOpenCodePlugin(options);
  const installed = plan.before.includes(OPENCODE_STATION_PLUGIN_MARKER);
  const ownershipConflict =
    plan.ownership?.status === "different-owner" || plan.ownership?.status === "unknown-owner";
  if (!installed && options.enabled === true) {
    return {
      provider: "opencode",
      configDir: plan.configDir,
      pluginPath: plan.pluginPath,
      status: "warn",
      installed: ownershipConflict ? false : installed,
      changed: true,
      message: "OpenCode event plugin is not installed.",
      ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
    };
  }
  if (installed && (plan.changed || ownershipConflict)) {
    return {
      provider: "opencode",
      configDir: plan.configDir,
      pluginPath: plan.pluginPath,
      status: "warn",
      installed: ownershipConflict ? false : installed,
      changed: true,
      message: ownershipConflict
        ? "OpenCode event plugin ownership conflicts with this Station runtime; run `stn hooks install opencode --yes --takeover` only to transfer it."
        : "OpenCode event plugin is installed but differs from the expected STATION plugin.",
      ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
    };
  }
  return {
    provider: "opencode",
    configDir: plan.configDir,
    pluginPath: plan.pluginPath,
    status: "ok",
    installed,
    changed: false,
    message: installed
      ? "OpenCode event plugin is installed."
      : "OpenCode event plugin is not requested.",
    ...(plan.ownership === undefined ? {} : { ownership: plan.ownership }),
  };
}

export function resolveOpenCodeConfigDir(options: OpenCodePluginPlanOptions = {}): string {
  if (options.opencodeConfigDir !== undefined) {
    return options.opencodeConfigDir;
  }
  const env = options.env ?? process.env;
  if (env.OPENCODE_CONFIG_DIR !== undefined && env.OPENCODE_CONFIG_DIR.length > 0) {
    return env.OPENCODE_CONFIG_DIR;
  }
  return join(options.homeDir ?? homedir(), ".config", "opencode");
}

export function resolveOpenCodePluginPath(options: OpenCodePluginPlanOptions = {}): string {
  return (
    options.pluginPath ??
    join(resolveOpenCodeConfigDir(options), "plugins", OPENCODE_STATION_PLUGIN_NAME)
  );
}

/**
 * ADAPTER
 *
 * Generates the OpenCode boundary that compacts events and delegates delivery to CLI ingress.
 */
export function expectedOpenCodePluginScript(options: OpenCodePluginPlanOptions = {}): string {
  const observerSocketPath = options.observerSocketPath ?? "";
  const stateDir = options.stateDir ?? "";
  const hookSpoolDir = options.hookSpoolDir ?? "";
  const ownerMarker =
    options.artifactOwner === undefined
      ? []
      : [`// ${providerHookOwnerMarker(options.artifactOwner)}`];
  const header = [
    `// ${OPENCODE_STATION_PLUGIN_MARKER}`,
    ...ownerMarker,
    "// Generated by STATION. Do not edit by hand.",
  ].join("\n");
  return `${header}
import { spawn, spawnSync } from "node:child_process";

const fallbackSocketPath = ${JSON.stringify(observerSocketPath)};
const fallbackStateDir = ${JSON.stringify(stateDir)};
const fallbackSpoolDir = ${JSON.stringify(hookSpoolDir)};
const ingressTimeoutMs = 5000;
const sentOpenCodeEventTypes = new Set(${JSON.stringify(openCodeForwardedEventTypes)});
// OpenCode's own auto-accept can resolve a permission ask within milliseconds of
// emitting it. A resolved-before-confirmation ask never blocked a user, so hold it
// briefly and suppress it when its matching reply arrives first.
const permissionConfirmWindowMs = 300;
const pendingPermissionAsks = new Map();

export const StationObserverPlugin = async ({ directory, worktree }) => {
  return {
    event: async ({ event }) => {
      try {
        if (!isStationOpenCodeSession(process.env)) return;
        if (!shouldSendOpenCodeEvent(event)) return;
        const receivedAt = new Date().toISOString();
        const eventType = stringValue(event?.type);
        if (eventType === "permission.asked") {
          const requestId = permissionRequestId(event);
          if (requestId !== undefined) {
            const payload = compactOpenCodeEvent(event, { directory, worktree, receivedAt });
            const timer = setTimeout(() => {
              pendingPermissionAsks.delete(requestId);
              void sendHookEvent(payload, eventType, process.env).catch(() => undefined);
            }, permissionConfirmWindowMs);
            if (typeof timer.unref === "function") timer.unref();
            pendingPermissionAsks.set(requestId, timer);
            return;
          }
        }
        const payload = compactOpenCodeEvent(event, { directory, worktree, receivedAt });
        if (eventType === "permission.replied") {
          const requestId = permissionRequestId(event);
          const pending = requestId === undefined ? undefined : pendingPermissionAsks.get(requestId);
          if (pending !== undefined) {
            // The ask was auto-resolved before any human could see it; suppress both events.
            clearTimeout(pending);
            pendingPermissionAsks.delete(requestId);
            return;
          }
        }
        if (eventType === "session.idle" || eventType === "session.deleted") {
          clearPendingPermissionAsks();
        }
        if (payload.event_type === "session.idle") {
          sendHookEventSync(payload, payload.event_type, process.env);
          return;
        }
        void sendHookEvent(payload, payload.event_type, process.env).catch(() => undefined);
      } catch {
        // Provider telemetry must never interrupt the OpenCode session.
      }
    },
  };
};

function isStationOpenCodeSession(env) {
  return env.STATION_HARNESS_PROVIDER === "opencode" && stringValue(env.STATION_WORKTREE_ID) !== undefined;
}

function shouldSendOpenCodeEvent(event) {
  const eventType = stringValue(event?.type);
  return eventType !== undefined && sentOpenCodeEventTypes.has(eventType);
}

function compactOpenCodeEvent(event, context) {
  const properties = recordValue(event?.properties);
  const eventType = stringValue(event?.type) ?? "unknown";
  const payload = {
    event_type: eventType,
    observed_at: context.receivedAt,
    cwd:
      stringValue(process.env.STATION_WORKTREE_PATH) ??
      stringValue(properties?.cwd) ??
      stringValue(event?.cwd) ??
      stringValue(context.worktree) ??
      stringValue(context.directory) ??
      process.cwd(),
    pid: process.pid,
  };
  assign(payload, "event_id", stringValue(event?.id));
  assign(payload, "opencode_session_id", openCodeSessionId(properties));
  assign(payload, "status_type", statusType(properties?.status));
  if (eventType === "permission.replied") assign(payload, "permission_reply", stringValue(properties?.reply));
  if (eventType === "question.replied") {
    assign(payload, "question_reply", properties?.answers === undefined ? stringValue(properties?.reply) : "answered");
  }
  assign(payload, "request_id", stringValue(properties?.requestID) ?? stringValue(properties?.id));
  assign(payload, "message_id", stringValue(properties?.messageID) ?? toolMessageId(properties?.tool));
  assign(payload, "part_id", stringValue(properties?.partID));
  assign(payload, "tool_call_id", stringValue(properties?.callID) ?? toolCallId(properties?.tool));
  assign(payload, "tool_name", toolName(properties));
  assign(payload, "command_name", stringValue(properties?.command) ?? (eventType === "command.executed" ? stringValue(properties?.name) : undefined));
  assign(payload, "file_path", stringValue(properties?.file) ?? stringValue(properties?.path));
  assign(payload, "error_name", stringValue(recordValue(properties?.error)?.name));
  if (properties !== undefined) payload.property_keys = Object.keys(properties).sort().slice(0, 128);
  assignEnv(payload, "station_project_id", "STATION_PROJECT_ID");
  assignEnv(payload, "station_worktree_id", "STATION_WORKTREE_ID");
  assignEnv(payload, "station_worktree_path", "STATION_WORKTREE_PATH");
  assignEnv(payload, "station_session_id", "STATION_SESSION_ID");
  assignEnv(payload, "station_terminal_provider", "STATION_TERMINAL_PROVIDER");
  assignEnv(payload, "station_terminal_target_id", "STATION_TERMINAL_TARGET_ID");
  payload.station_integration_id = "opencode";
  payload.station_integration_version = "1";
  return payload;
}

function sendHookEvent(payload, eventType, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(ingressCommand(env), ingressArgs(env, eventType), {
      env,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: ingressTimeoutMs,
      killSignal: "SIGKILL",
    });
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (error) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already be gone; settling the provider callback still wins.
      }
      settle(error);
    };
    child.once("error", abort);
    child.stdin.once("error", abort);
    child.once("close", (code) => {
      settle(code === 0 ? undefined : new Error(\`stn-ingress exited with code \${code ?? "unknown"}.\`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function sendHookEventSync(payload, eventType, env) {
  const result = spawnSync(ingressCommand(env), ingressArgs(env, eventType), {
    env,
    input: JSON.stringify(payload),
    stdio: ["pipe", "ignore", "ignore"],
    timeout: ingressTimeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(\`stn-ingress exited with code \${result.status ?? "unknown"}.\`);
  }
}

function ingressCommand(env) {
  return stringValue(env.STATION_INGRESS_BIN) ?? "stn-ingress";
}

function ingressArgs(env, eventType) {
  const args = [];
  appendIngressPath(args, "--socket", stringValue(env.STATION_OBSERVER_SOCKET_PATH) ?? stringValue(fallbackSocketPath));
  appendIngressPath(args, "--state-dir", stringValue(env.STATION_OBSERVER_STATE_DIR) ?? stringValue(fallbackStateDir));
  appendIngressPath(args, "--spool-dir", stringValue(env.STATION_HOOK_SPOOL_DIR) ?? stringValue(fallbackSpoolDir));
  appendIngressPath(args, "--config", stringValue(env.STATION_CONFIG_PATH));
  args.push("opencode", eventType);
  return args;
}

function appendIngressPath(args, flag, value) {
  if (value !== undefined) args.push(flag, value);
}

function openCodeSessionId(properties) {
  return stringValue(properties?.sessionID) ?? stringValue(properties?.sessionId) ?? stringValue(recordValue(properties?.info)?.id);
}

function statusType(status) {
  if (typeof status === "string" && status.length > 0) return status;
  return stringValue(recordValue(status)?.type);
}

function toolMessageId(tool) {
  return stringValue(recordValue(tool)?.messageID);
}

function toolCallId(tool) {
  return stringValue(recordValue(tool)?.callID);
}

function toolName(properties) {
  if (typeof properties?.tool === "string" && properties.tool.length > 0) return properties.tool;
  return stringValue(properties?.name) ?? stringValue(properties?.permission);
}

function assign(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function assignEnv(target, key, envKey) {
  assign(target, key, stringValue(process.env[envKey]));
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function permissionRequestId(event) {
  const properties = recordValue(event?.properties);
  return stringValue(properties?.requestID) ?? stringValue(properties?.id);
}

function clearPendingPermissionAsks() {
  for (const timer of pendingPermissionAsks.values()) {
    clearTimeout(timer);
  }
  pendingPermissionAsks.clear();
}
`;
}

function openCodePluginOwnership(
  contents: string,
  options: OpenCodePluginPlanOptions,
): ProviderHookArtifactOwnership | undefined {
  if (options.artifactOwner === undefined) return undefined;
  return classifyProviderHookArtifactOwnership({
    contents,
    requested: options.artifactOwner,
  });
}

function assertOpenCodePluginOwnership(
  action: "install" | "uninstall",
  pluginPath: string,
  contents: string,
  options: OpenCodePluginPlanOptions,
): void {
  assertProviderHookArtifactOwnership({
    provider: "opencode",
    action,
    artifactPath: pluginPath,
    contents,
    ...(options.artifactOwner === undefined ? {} : { requested: options.artifactOwner }),
    ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
  });
}
