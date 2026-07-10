import type { StationCommand, StationEvent } from "@station/contracts";
import { shellQuote } from "@station/tmux";
import { type ExecutableArgv, type SelfExecRuntime, selfExecArgv } from "../../selfExec.js";

type TerminalFocusCommand = Extract<StationCommand, { type: "terminal.focus" }>;
type WorktreeAgentStateChangedEvent = Extract<StationEvent, { type: "worktree.agentStateChanged" }>;

export type BuildClickFocusShellCommandInput = {
  command: TerminalFocusCommand;
  cliCommandParts: readonly string[];
  configPath?: string;
};

export function buildFocusCommand(event: WorktreeAgentStateChangedEvent): TerminalFocusCommand {
  const payload: TerminalFocusCommand["payload"] = {};
  if (event.agent?.sessionId !== undefined) {
    payload.sessionId = event.agent.sessionId;
  } else {
    payload.worktreeId = event.worktreeId;
  }
  return {
    type: "terminal.focus",
    payload,
  };
}

export function buildClickFocusShellCommand(input: BuildClickFocusShellCommandInput): string {
  const commandParts = [...input.cliCommandParts];
  if (input.configPath !== undefined) {
    commandParts.push("--config", input.configPath);
  }
  commandParts.push("command", "dispatch", "--stdin", "--wait", "--timeout-ms", "5000");
  return [
    "printf",
    "'%s\\n'",
    shellQuote(JSON.stringify(input.command)),
    "|",
    ...commandParts.map(shellQuote),
    ">/dev/null",
    "2>&1",
  ].join(" ");
}

export function defaultCliCommandParts(runtime?: SelfExecRuntime): ExecutableArgv {
  const entry = process.argv[1];
  const developmentArgv: ExecutableArgv =
    entry === undefined || entry.length === 0 ? ["stn"] : [process.execPath, entry];
  return selfExecArgv("cli", developmentArgv, runtime);
}
