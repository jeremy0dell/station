import { tmuxWindowTarget } from "./topology.js";

export function buildGuardedTmuxCommandArgs(input: {
  target: string;
  serverPid: number;
  sessionId: string;
  windowId: string;
  paneId: string;
  panePid?: number;
  commands: readonly string[];
  /** Format expressions must survive the outer parser for the nested command to evaluate them. */
  rawFormatArgs?: readonly string[];
  rejectionMarker: string;
}): string[] {
  const conditions = [
    `#{==:#{pid},${input.serverPid}}`,
    `#{==:#{session_id},${input.sessionId}}`,
    `#{==:#{window_id},${input.windowId}}`,
    `#{==:#{pane_id},${input.paneId}}`,
  ];
  if (input.panePid !== undefined) {
    conditions.push(`#{==:#{pane_pid},${input.panePid}}`);
  }
  return [
    "if-shell",
    "-F",
    "-t",
    input.target,
    combineTmuxConditions(conditions),
    tmuxCommandSequence(input.commands, input.rawFormatArgs),
    tmuxCommandSequence(["display-message", "-p", input.rejectionMarker]),
  ];
}

export function buildQualifiedKillWindowArgs(input: {
  sessionId: string;
  windowId: string;
  serverPid: number;
  bindingToken: string;
  stationSessionId: string;
  rejectionMarker: string;
}): string[] {
  const target = tmuxWindowTarget({
    sessionId: input.sessionId,
    windowNameOrId: input.windowId,
  });
  const conditions = [
    `#{==:#{pid},${input.serverPid}}`,
    `#{==:#{@station.open_token},${input.bindingToken}}`,
    `#{==:#{@station.session_id},${input.stationSessionId}}`,
  ];
  return [
    "if-shell",
    "-F",
    "-t",
    target,
    combineTmuxConditions(conditions),
    tmuxCommandSequence(["kill-window", "-t", target]),
    tmuxCommandSequence(["display-message", "-p", input.rejectionMarker]),
  ];
}

function combineTmuxConditions(conditions: readonly string[]): string {
  const first = conditions[0];
  if (first === undefined) throw new Error("A tmux mutation guard requires evidence.");
  return conditions
    .slice(1)
    .reduce((combined, condition) => `#{&&:${combined},${condition}}`, first);
}

function tmuxCommandSequence(
  args: readonly string[],
  rawFormatArgs: readonly string[] = [],
): string {
  return args
    .map((arg) => (arg === ";" ? ";" : quoteTmuxCommandArgument(arg, rawFormatArgs.includes(arg))))
    .join(" ");
}

function quoteTmuxCommandArgument(value: string, rawFormat = false): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("#", rawFormat ? "#" : "##")}"`;
}
