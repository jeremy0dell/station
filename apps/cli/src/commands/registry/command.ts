import { readStdinIfAvailable } from "../../stdin.js";
import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import type { CommandCommandOptions } from "../command.js";
import { commandCommandExitCode, runCommandCommand } from "../command.js";

export const commandCliCommand: CliCommandNode = {
  name: "command",
  description: "Dispatch typed observer commands and inspect command records.",
  requiresConfig: true,
  run: runCommandCliCommand,
  usage: [
    "stn command dispatch --stdin [--wait] [--timeout-ms <ms>]",
    "stn command get <commandId> [--timeout-ms <ms>]",
  ],
  examples: [
    'printf \'%s\\n\' \'{"type":"observer.reconcile","payload":{"reason":"manual"}}\' | pnpm stn command dispatch --stdin --wait',
  ],
  notes: [
    "Command dispatch input is validated against shared STATION command schemas.",
    "Normal command execution may start or contact the observer.",
  ],
  children: [
    {
      name: "dispatch",
      description: "Read a STATION command JSON payload from stdin and dispatch it.",
      usage: ["stn command dispatch --stdin [--wait] [--timeout-ms <ms>]"],
      options: [
        { name: "--stdin", description: "Read the command JSON payload from stdin." },
        {
          name: "--wait",
          description: "Wait until the observer records a terminal command status.",
        },
        { name: "--timeout-ms <ms>", description: "Override dispatch and wait timeout." },
      ],
      examples: [
        'printf \'%s\\n\' \'{"type":"observer.reconcile","payload":{"reason":"manual"}}\' | pnpm stn command dispatch --stdin --wait',
      ],
    },
    {
      name: "get",
      description: "Fetch a command lifecycle record from the observer.",
      usage: ["stn command get <commandId> [--timeout-ms <ms>]"],
      options: [{ name: "--timeout-ms <ms>", description: "Override observer request timeout." }],
      notes: [
        "Use a command id returned by command dispatch, observe --json, or debug trace output.",
      ],
    },
  ],
};

async function runCommandCliCommand(context: CliCommandRunContext) {
  const stdin = context.args.includes("--stdin")
    ? (context.options.stdin ?? (await readStdinIfAvailable()))
    : context.options.stdin;
  const commandOptions: CommandCommandOptions = loadedCommandOptions(context);
  if (stdin !== undefined) {
    commandOptions.stdin = stdin;
  }
  const result = await runCommandCommand(
    context.args,
    commandOptions,
    context.options.observerDeps,
  );
  return { code: commandCommandExitCode(result), output: result };
}
