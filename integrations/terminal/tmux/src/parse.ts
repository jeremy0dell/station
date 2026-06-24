import type { TerminalTargetObservation } from "@station/contracts";
import { buildTmuxTargetId } from "./topology.js";

export const tmuxListTargetsFormat = [
  "#{session_name}",
  "#{window_id}",
  "#{pane_id}",
  "#{session_attached}",
  "#{pane_dead}",
  "#{pane_dead_status}",
  "#{pane_current_path}",
  "#{pane_pid}",
  "#{pane_current_command}",
  "#{window_name}",
  "#{@station.session_id}",
  "#{@station.project_id}",
  "#{@station.worktree_id}",
  "#{@station.worktree_path}",
  "#{@station.role}",
  "#{@station.harness}",
].join("\t");

export function parseTmuxTargetLines(
  stdout: string,
  options: {
    observedAt: string;
  },
): TerminalTargetObservation[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  return trimmed.split(/\r?\n/).map((line) => parseTmuxTargetLine(line, options));
}

function parseTmuxTargetLine(
  line: string,
  options: {
    observedAt: string;
  },
): TerminalTargetObservation {
  const [
    sessionId = "",
    windowId = "",
    paneId = "",
    attached = "0",
    paneDead = "0",
    paneDeadStatus = "",
    cwd = "",
    pid = "",
    currentCommand = "",
    title = "",
    stationSessionId = "",
    projectId = "",
    worktreeId = "",
    ...identityFields
  ] = line.split("\t");
  const [worktreePath = "", role = "", harness = ""] =
    identityFields.length >= 3 ? identityFields : ["", ...identityFields];
  const hasBinding =
    projectId.length > 0 && worktreeId.length > 0 && role === "main-agent" && harness.length > 0;
  const isDead = paneDead === "1";
  const parsedPid = parsePositiveInteger(pid);
  const providerData: Record<string, unknown> = {
    sessionName: sessionId,
    windowId,
    paneId,
    paneTarget: paneId,
    attached: attached === "1",
    dead: isDead,
  };
  if (title.length > 0) {
    providerData.windowName = title;
  }
  if (paneDeadStatus.length > 0) {
    providerData.deadStatus = paneDeadStatus;
  }
  const target: TerminalTargetObservation = {
    id: buildTmuxTargetId({ sessionId, windowId, paneId }),
    provider: "tmux",
    ...(projectId.length === 0 ? {} : { projectId }),
    ...(worktreeId.length === 0 ? {} : { worktreeId }),
    ...(stationSessionId.length === 0 ? {} : { sessionId: stationSessionId }),
    state: isDead ? "stale" : attached === "1" ? "open" : "detached",
    ...(cwd.length === 0 ? {} : { cwd }),
    ...(parsedPid === undefined ? {} : { pid: parsedPid }),
    ...(title.length === 0 ? {} : { title }),
    confidence: hasBinding ? "high" : "low",
    reason: targetReason({ hasBinding, isDead }),
    observedAt: options.observedAt,
    providerData,
  };
  if (hasBinding) {
    target.harnessBinding = {
      role,
      harnessProvider: harness,
    };
    if (worktreePath.length > 0) {
      target.harnessBinding.worktreePath = worktreePath;
    }
    if (currentCommand.length > 0) {
      target.harnessBinding.currentCommand = currentCommand;
    }
  }
  return target;
}

function targetReason(input: { hasBinding: boolean; isDead: boolean }): string {
  if (input.isDead && input.hasBinding) {
    return "tmux pane has station identity binding but is dead.";
  }
  if (input.isDead) {
    return "tmux pane is dead and missing station identity binding.";
  }
  return input.hasBinding
    ? "tmux pane has station identity binding."
    : "tmux pane is missing station identity binding.";
}

function parsePositiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
