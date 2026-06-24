import type { ExternalCommandInput, ExternalCommandResult } from "@station/runtime";

export function tmuxCommandResult(input: ExternalCommandInput, stdout = ""): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
