import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import {
  type ProjectCommandOptions,
  projectCommandExitCode,
  runProjectCommand,
} from "../project.js";

export const projectCliCommand: CliCommandNode = {
  name: "project",
  description: "List, add, remove, or diagnose configured projects.",
  requiresConfig: true,
  run: runProjectCliCommand,
  usage: [
    "stn project list",
    "stn project add <path> [options]",
    "stn project remove <projectId> [options]",
    "stn project doctor <projectId>",
  ],
  examples: ["pnpm stn project list", "pnpm stn project add --man"],
  children: [
    {
      name: "list",
      description: "List configured projects.",
      usage: ["stn project list"],
      examples: ["pnpm stn project list"],
      notes: ["The command reads config when run normally but does not start the observer."],
    },
    {
      name: "add",
      description: "Dispatch a command to add a project.",
      usage: [
        "stn project add <path> [--id <id>] [--label <label>] [--allow-non-git] [--timeout-ms <ms>]",
      ],
      options: [
        { name: "--id <id>", description: "Set the project id instead of deriving one." },
        { name: "--label <label>", description: "Set the display label." },
        {
          name: "--allow-non-git",
          description: "Allow adding a path that is not a Git worktree root.",
        },
        {
          name: "--timeout-ms <ms>",
          description: "Override command dispatch and wait timeout.",
        },
      ],
      examples: [
        'pnpm stn project add "$PWD" --label "$(basename "$PWD")"',
        "pnpm stn project add --man",
      ],
      notes: [
        "The normal command dispatches through the observer and waits for completion.",
        "Use --man to inspect this guidance without loading config or contacting the observer.",
      ],
    },
    {
      name: "remove",
      description: "Dispatch a command to remove a project.",
      usage: ["stn project remove <projectId> [--timeout-ms <ms>]"],
      options: [
        {
          name: "--timeout-ms <ms>",
          description: "Override command dispatch and wait timeout.",
        },
      ],
      notes: ["Use a project id returned by `pnpm stn project list`."],
    },
    {
      name: "doctor",
      description: "Inspect one configured project root.",
      usage: ["stn project doctor <projectId>"],
      notes: ["Use a project id returned by `pnpm stn project list`."],
    },
  ],
};

async function runProjectCliCommand(context: CliCommandRunContext) {
  const projectOptions: ProjectCommandOptions = loadedCommandOptions(context);
  const result = await runProjectCommand(
    context.args,
    projectOptions,
    context.options.observerDeps,
  );
  return { code: projectCommandExitCode(result), output: result };
}
