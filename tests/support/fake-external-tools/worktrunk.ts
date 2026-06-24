import type {
  ExternalCommandInput,
  ExternalCommandResult,
  ExternalCommandRunner,
} from "@station/runtime";

export type FakeWorktrunkRunnerOptions = {
  listJson: unknown;
  version?: string;
  onCall?: (input: ExternalCommandInput) => void;
};

export function createFakeWorktrunkRunner(
  options: FakeWorktrunkRunnerOptions,
): ExternalCommandRunner {
  return async (input) => {
    options.onCall?.(input);
    const args = input.args ?? [];
    if (args.includes("--version")) {
      return result(input, options.version ?? "wt 0.0.0");
    }
    if (args.includes("list")) {
      return result(input, JSON.stringify(options.listJson));
    }
    if (args.includes("switch")) {
      return result(input, JSON.stringify(options.listJson));
    }
    if (args.includes("remove")) {
      return result(input, "{}");
    }
    return result(input, "{}");
  };
}

function result(input: ExternalCommandInput, stdout: string): ExternalCommandResult {
  return {
    command: input.command,
    args: input.args ?? [],
    stdout,
    stderr: "",
    exitCode: 0,
  };
}
