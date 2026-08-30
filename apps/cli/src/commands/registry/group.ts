import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type {
  CliCommandNode,
  CliCommandOption,
  CliCommandRunContext,
} from "../cliCommand/types.js";
import { commandExecutionCorrelation } from "../command.js";
import { parseGroupArgs } from "../group/args.js";
import { runGroupCommand } from "../group/command.js";
import type { GroupCommandOptions } from "../group/options.js";
import { groupCommandExitCode } from "../group/result.js";
import { renderGroupCommandText } from "../group/text.js";

const jsonOption = {
  name: "--json",
  description: "Print the structured command and convergence result.",
} satisfies CliCommandOption;
const timeoutOption = {
  name: "--timeout-ms <ms>",
  description: "Override snapshot, command, completion, and refresh timeout.",
} satisfies CliCommandOption;
const mutationOptions = [timeoutOption, jsonOption] as const;

export const groupCliCommand: CliCommandNode = {
  name: "group",
  description: "Discover and mutate durable project-local Session Groups.",
  requiresConfig: true,
  run: runGroupCliCommand,
  usage: [
    "stn group list [--project <projectId>] [--json]",
    "stn group get <groupId> [--json]",
    "stn group create <projectId> <name> [--session <sessionId>]... [--timeout-ms <ms>] [--json]",
    "stn group rename <groupId> <name> [--timeout-ms <ms>] [--json]",
    "stn group members add <groupId> <sessionId>... [--timeout-ms <ms>] [--json]",
    "stn group members remove <groupId> <sessionId>... [--timeout-ms <ms>] [--json]",
    "stn group reparent <groupId> (--parent <groupId> | --root) [--timeout-ms <ms>] [--json]",
    "stn group delete <groupId> [--timeout-ms <ms>] [--json]",
  ],
  examples: ["stn group list", 'stn group list --project "$PROJECT_ID" --json', "stn group --man"],
  notes: [
    "A Session Group is durable, project-local organization with direct session membership and optional nesting. Snapshot order, direct membership, versions, and timestamps are preserved.",
    "Selection uses exact current Group, project, and session IDs. Mutation commands use the observed Group version and membership as optimistic preconditions.",
    "Successful mutations include one refreshed project projection. A refresh failure or projection mismatch is a warning with exit code 0; rejected and failed Observer commands exit 1 without refresh.",
    "Group deletion removes only Group organization: it does not close or remove sessions, terminals, worktrees, agents, Hosts, or providers.",
    "Session creation remains available through `stn session create --group`, `--new-group`, or `--ungrouped`; fork inherits its source Group unless `--ungrouped` is selected or `--inherit-group` makes that requirement explicit.",
    "Cross-project Stacks are a separate future workflow lens and are not exposed by `stn group`.",
  ],
  children: [
    {
      name: "list",
      description: "List all current Groups or only one exact project projection.",
      usage: ["stn group list [--project <projectId>] [--json]"],
      options: [
        { name: "--project <projectId>", description: "Match the exact project id." },
        { name: "--json", description: "Print the structured list result." },
      ],
      examples: ["stn group list", 'stn group list --project "$PROJECT_ID" --json'],
      notes: [
        "An unknown but valid project filter returns an empty list. The command never infers a project from a Group name or session.",
      ],
    },
    {
      name: "get",
      description: "Inspect one exact current Group id.",
      usage: ["stn group get <groupId> [--json]"],
      options: [{ name: "--json", description: "Print the structured Group result." }],
      examples: ['stn group get "$GROUP_ID" --json'],
      notes: [
        "The id must match one complete current Group id. Names, prefixes, display indexes, and project-local guesses are not selectors.",
      ],
    },
    {
      name: "create",
      description: "Create one empty or initially ungrouped-member Group.",
      usage: [
        "stn group create <projectId> <name> [--session <sessionId>]... [--timeout-ms <ms>] [--json]",
      ],
      options: [
        {
          name: "--session <sessionId>",
          description: "Add one currently ungrouped same-project session.",
        },
        ...mutationOptions,
      ],
      examples: ['stn group create "$PROJECT_ID" "Review" --json'],
      notes: [
        "The Observer mints the durable Group id and version. The CLI accepts them only from the schema-parsed command result and never recovers an id by name or refresh timing.",
        "Initial sessions must be current, same-project, distinct, and ungrouped in the initial snapshot. Concurrent assignment remains an Observer precondition.",
      ],
    },
    {
      name: "rename",
      description: "Rename one exact Group using its current version.",
      usage: ["stn group rename <groupId> <name> [--timeout-ms <ms>] [--json]"],
      options: mutationOptions,
      examples: ['stn group rename "$GROUP_ID" "Ready for review" --json'],
    },
    {
      name: "members",
      description: "Add or remove direct session membership atomically.",
      usage: [
        "stn group members add <groupId> <sessionId>... [--timeout-ms <ms>] [--json]",
        "stn group members remove <groupId> <sessionId>... [--timeout-ms <ms>] [--json]",
      ],
      notes: [
        "Add may atomically move same-project sessions from another Group. Remove requires every selected session to be directly in the target Group.",
        "Descendant Groups are never flattened into direct membership.",
      ],
      children: [
        {
          name: "add",
          description: "Add or atomically move one or more direct session members.",
          usage: ["stn group members add <groupId> <sessionId>... [--timeout-ms <ms>] [--json]"],
          options: mutationOptions,
          examples: ['stn group members add "$GROUP_ID" "$SESSION_ID" --json'],
        },
        {
          name: "remove",
          description: "Remove one or more direct session members without stopping them.",
          usage: ["stn group members remove <groupId> <sessionId>... [--timeout-ms <ms>] [--json]"],
          options: mutationOptions,
          examples: ['stn group members remove "$GROUP_ID" "$SESSION_ID" --json'],
        },
      ],
    },
    {
      name: "reparent",
      description: "Move one exact Group to a same-project parent or project root.",
      usage: [
        "stn group reparent <groupId> (--parent <groupId> | --root) [--timeout-ms <ms>] [--json]",
      ],
      options: [
        { name: "--parent <groupId>", description: "Set one current same-project parent Group." },
        {
          name: "--root",
          description: "Remove the current parent and place the Group at project root.",
        },
        ...mutationOptions,
      ],
      examples: ['stn group reparent "$GROUP_ID" --root --json'],
      notes: [
        "Exactly one of --parent and --root is required. Self-parenting, cycles, and concurrent conflicts remain Observer-owned validation.",
      ],
    },
    {
      name: "delete",
      description:
        "Delete one Group definition while preserving sessions and descendants' organization.",
      usage: ["stn group delete <groupId> [--timeout-ms <ms>] [--json]"],
      options: mutationOptions,
      examples: ['stn group delete "$GROUP_ID" --json'],
      notes: [
        "Deletion only dispatches sessionGroup.delete. Direct members become ungrouped and direct children move to the deleted Group's parent or project root; sessions, terminals, worktrees, agents, Hosts, and providers remain untouched.",
      ],
    },
  ],
};

async function runGroupCliCommand(context: CliCommandRunContext) {
  const parsed = parseGroupArgs(context.args);
  const options: GroupCommandOptions = loadedCommandOptions(context);
  const result = await runGroupCommand(parsed, options, context.options.observerDeps);
  const correlation = "outcome" in result ? commandExecutionCorrelation(result.outcome) : undefined;
  const base = {
    code: groupCommandExitCode(result),
    output: parsed.outputFormat === "json" ? result : renderGroupCommandText(result),
    ...(parsed.outputFormat === "text" ? { outputFormat: "text" as const } : {}),
  };
  return correlation === undefined ? base : { ...base, correlation };
}
