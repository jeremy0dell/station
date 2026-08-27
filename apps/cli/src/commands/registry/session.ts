import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { commandExecutionCorrelation } from "../command.js";
import { parseSessionArgs } from "../session/args.js";
import { runSessionCommand } from "../session/command.js";
import { sessionCommandExitCode } from "../session/result.js";
import { renderSessionCommandText } from "../session/text.js";

const currentExamples = ["stn session current"] as const;
const currentNotes = [
  "Current validates the invoking terminal's live topology and returns a placement source as strict JSON.",
  "Normal execution loads configuration and may start or contact the Observer.",
  "tmux is currently the only placement-capable terminal provider.",
  "The returned source is short-lived, one-shot bearer input for raw sibling session.create or session.fork dispatch through stn command dispatch --stdin --wait; do not persist or log it.",
  "Detached placement is source-free and does not use stn session current.",
] as const;

const exactSelectionNote =
  "Selection uses exact current session-ID equality only. Prefixes, titles, branches, fuzzy text, and display indexes are never accepted as mutation targets.";
const outputNote =
  "Output defaults to terminal-safe text. Use --json for the complete structured result.";
const startupNote =
  "Normal execution may start or contact the Observer; --require-running on read-only discovery refuses instead of starting a missing Observer.";
const mutationTimeoutNote =
  "Mutation timeout covers dispatch and durable completion. A post-dispatch timeout reports its accepted command and trace IDs for inspection.";

export const sessionCliCommand: CliCommandNode = {
  name: "session",
  description: "Discover or operate on one exact current session.",
  requiresConfig: true,
  run: runSessionCliCommand,
  usage: [
    "stn session current",
    "stn session list [filters]",
    "stn session get <sessionId> [--json] [--require-running]",
    "stn session rename <sessionId> <title> [--json] [--timeout-ms <ms>]",
    "stn session close <sessionId> --mode <harness|terminal|all> [--force] [--json] [--timeout-ms <ms>]",
  ],
  examples: ["stn session current", "stn session list", "stn session get --man"],
  notes: [
    exactSelectionNote,
    outputNote,
    startupNote,
    "Rename changes the worktree-scoped session name; it does not rename the branch or change path, harness, or terminal identity.",
    "Close requires an explicit harness, terminal, or all mode. It never deletes the worktree, branch, checkout, or panes and never dispatches worktree.remove.",
  ],
  children: [
    {
      name: "current",
      description: "Print the verified invoking terminal context as JSON.",
      usage: ["stn session current"],
      examples: currentExamples,
      notes: currentNotes,
    },
    {
      name: "list",
      description: "List current sessions with optional AND-combined filters.",
      usage: [
        "stn session list [--project <projectId>] [--provider <providerId>] [--status <status>] [--origin <station|external>] [--query <text>] [--require-running] [--json]",
      ],
      options: [
        { name: "--project <projectId>", description: "Match the exact project id." },
        { name: "--provider <providerId>", description: "Match the exact harness provider." },
        { name: "--status <status>", description: "Match the exact observed session status." },
        {
          name: "--origin <station|external>",
          description: "Match Observer-owned or externally observed sessions.",
        },
        {
          name: "--query <text>",
          description: "Case-insensitive search over documented identity and label fields.",
        },
        {
          name: "--require-running",
          description: "Refuse instead of starting a missing Observer.",
        },
        { name: "--json", description: "Print the structured list result." },
      ],
      examples: ["stn session list", "stn session list --status working --origin station --json"],
      notes: [
        outputNote,
        startupNote,
        "Every supplied filter combines with AND and preserves the snapshot's canonical session order.",
        "Query searches session ID/name, project ID/label, worktree ID/branch, and harness provider only. It does not search path, tags, origin, status, run IDs, attachments, or timestamps.",
      ],
    },
    {
      name: "get",
      description: "Inspect one exact current session ID.",
      usage: ["stn session get <sessionId> [--require-running] [--json]"],
      options: [
        {
          name: "--require-running",
          description: "Refuse instead of starting a missing Observer.",
        },
        { name: "--json", description: "Print the structured session result." },
      ],
      examples: ["stn session get --man"],
      notes: [exactSelectionNote, outputNote, startupNote],
    },
    {
      name: "rename",
      description: "Rename the worktree-scoped name for one exact session.",
      usage: ["stn session rename <sessionId> <title> [--timeout-ms <ms>] [--json]"],
      options: [
        {
          name: "--timeout-ms <ms>",
          description: "Override snapshot, command dispatch, completion, and refresh timeout.",
        },
        { name: "--json", description: "Print the structured command and convergence result." },
      ],
      examples: ["stn session rename --man"],
      notes: [
        exactSelectionNote,
        outputNote,
        mutationTimeoutNote,
        "The title is durable worktree-scoped display authority. Rename does not rename the branch or change the checkout path, harness run, or terminal attachment.",
        "A succeeded command followed by a stale or unavailable refresh exits successfully with a visible convergence warning.",
      ],
    },
    {
      name: "close",
      description: "Deliberately stop harness, terminal, or both without deleting the checkout.",
      usage: [
        "stn session close <sessionId> --mode <harness|terminal|all> [--force] [--timeout-ms <ms>] [--json]",
      ],
      options: [
        {
          name: "--mode <harness|terminal|all>",
          description: "Choose exactly which non-destructive lifecycle resources to close.",
        },
        { name: "--force", description: "Explicitly request force for the selected close mode." },
        {
          name: "--timeout-ms <ms>",
          description: "Override snapshot, command dispatch, completion, and refresh timeout.",
        },
        { name: "--json", description: "Print the structured command and convergence result." },
      ],
      examples: ["stn session close --man"],
      notes: [
        exactSelectionNote,
        outputNote,
        mutationTimeoutNote,
        "Mode harness stops only the harness lifecycle; terminal closes the terminal target and associated session; all closes both.",
        "Mode and force are never inferred. There is no bulk close form.",
        "Close never deletes the worktree, checkout, branch, or panes and never dispatches worktree.remove. The destructive TUI Delete Session action is a different worktree-removal operation.",
        "A succeeded command followed by a stale or unavailable refresh exits successfully with a visible convergence warning.",
      ],
    },
  ],
};

async function runSessionCliCommand(context: CliCommandRunContext) {
  const parsed = parseSessionArgs(context.args);
  const result = await runSessionCommand(
    parsed,
    { ...loadedCommandOptions(context), ...context.options.sessionDeps },
    context.options.observerDeps,
  );
  if (result.action === "current") {
    return { code: 0, output: result.context };
  }
  const code = sessionCommandExitCode(result);
  const correlation =
    result.action === "rename" || result.action === "close"
      ? commandExecutionCorrelation(result.outcome)
      : undefined;
  if (parsed.outputFormat === "json") {
    return correlation === undefined
      ? { code, output: result }
      : { code, output: result, correlation };
  }
  const cliResult = {
    code,
    output: renderSessionCommandText(result),
    outputFormat: "text" as const,
  };
  return correlation === undefined ? cliResult : { ...cliResult, correlation };
}
