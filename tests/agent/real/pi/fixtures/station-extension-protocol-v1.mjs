import { spawn } from "node:child_process";

const legacyEvents = ["session_start", "agent_start", "agent_end", "session_shutdown"];

export default function legacyStationPiExtension(pi) {
  for (const eventType of legacyEvents) {
    pi.on(eventType, async (_event, context) => {
      await sendLegacyReport(eventType, context);
    });
  }
}

function sendLegacyReport(eventType, context) {
  const payload = {
    event_type: eventType,
    cwd: context.cwd,
    pid: process.pid,
  };
  assignEnv(payload, "station_project_id", "STATION_PROJECT_ID");
  assignEnv(payload, "station_worktree_id", "STATION_WORKTREE_ID");
  assignEnv(payload, "station_session_id", "STATION_SESSION_ID");
  assignEnv(payload, "station_terminal_target_id", "STATION_TERMINAL_TARGET_ID");

  // Protocol-v1 reports intentionally have no settlement capability marker.
  return new Promise((resolve) => {
    const child = spawn(process.env.STATION_INGRESS_BIN || "stn-ingress", ["pi", eventType], {
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
}

function assignEnv(payload, field, variable) {
  const value = process.env[variable];
  if (value) payload[field] = value;
}
