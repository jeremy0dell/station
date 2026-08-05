import { spawn, spawnSync } from "node:child_process";

const fallbackSocketPath = __STATION_SOCKET_PATH__;
const fallbackStateDir = __STATION_STATE_DIR__;
const fallbackSpoolDir = __STATION_SPOOL_DIR__;
const ingressTimeoutMs = 5000;
const sentOpenCodeEventTypes = new Set(__STATION_FORWARDED_EVENT_TYPES__);
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
          const pending =
            requestId === undefined ? undefined : pendingPermissionAsks.get(requestId);
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
  return (
    env.STATION_HARNESS_PROVIDER === "opencode" &&
    stringValue(env.STATION_WORKTREE_ID) !== undefined
  );
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
  if (eventType === "permission.replied")
    assign(payload, "permission_reply", stringValue(properties?.reply));
  if (eventType === "question.replied") {
    assign(
      payload,
      "question_reply",
      properties?.answers === undefined ? stringValue(properties?.reply) : "answered",
    );
  }
  assign(payload, "request_id", stringValue(properties?.requestID) ?? stringValue(properties?.id));
  assign(
    payload,
    "message_id",
    stringValue(properties?.messageID) ?? toolMessageId(properties?.tool),
  );
  assign(payload, "part_id", stringValue(properties?.partID));
  assign(payload, "tool_call_id", stringValue(properties?.callID) ?? toolCallId(properties?.tool));
  assign(payload, "tool_name", toolName(properties));
  assign(
    payload,
    "command_name",
    stringValue(properties?.command) ??
      (eventType === "command.executed" ? stringValue(properties?.name) : undefined),
  );
  assign(payload, "file_path", stringValue(properties?.file) ?? stringValue(properties?.path));
  assign(payload, "error_name", stringValue(recordValue(properties?.error)?.name));
  if (properties !== undefined)
    payload.property_keys = Object.keys(properties).sort().slice(0, 128);
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
      settle(
        code === 0 ? undefined : new Error(`stn-ingress exited with code ${code ?? "unknown"}.`),
      );
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
    throw new Error(`stn-ingress exited with code ${result.status ?? "unknown"}.`);
  }
}

function ingressCommand(env) {
  return stringValue(env.STATION_INGRESS_BIN) ?? "stn-ingress";
}

function ingressArgs(env, eventType) {
  const args = [];
  appendIngressPath(
    args,
    "--socket",
    stringValue(env.STATION_OBSERVER_SOCKET_PATH) ?? stringValue(fallbackSocketPath),
  );
  appendIngressPath(
    args,
    "--state-dir",
    stringValue(env.STATION_OBSERVER_STATE_DIR) ?? stringValue(fallbackStateDir),
  );
  appendIngressPath(
    args,
    "--spool-dir",
    stringValue(env.STATION_HOOK_SPOOL_DIR) ?? stringValue(fallbackSpoolDir),
  );
  appendIngressPath(args, "--config", stringValue(env.STATION_CONFIG_PATH));
  args.push("opencode", eventType);
  return args;
}

function appendIngressPath(args, flag, value) {
  if (value !== undefined) args.push(flag, value);
}

function openCodeSessionId(properties) {
  return (
    stringValue(properties?.sessionID) ??
    stringValue(properties?.sessionId) ??
    stringValue(recordValue(properties?.info)?.id)
  );
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
