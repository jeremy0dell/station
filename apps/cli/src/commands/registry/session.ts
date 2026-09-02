import { CliInputError } from "../../args.js";
import { defaultStdinMaxBytes, readStdinIfAvailable } from "../../stdin.js";
import { loadedCommandOptions } from "../cliCommand/helpers.js";
import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { commandExecutionCorrelation } from "../command.js";
import { parseSessionArgs } from "../session/args.js";
import { runSessionCommand } from "../session/command.js";
import type { SessionCommandOptions } from "../session/options.js";
import { sessionCommandExitCode, sessionCreationCorrelation } from "../session/result.js";
import { renderSessionCommandText } from "../session/text.js";

const currentExamples = ["stn session current"] as const;
const currentNotes = [
  "Current validates the invoking terminal's live topology and returns a placement source as strict JSON.",
  "Normal execution loads configuration and may start or contact the Observer.",
  "tmux and native Station panes can provide placement authority for session create/fork --from-current.",
  "The returned source is short-lived, one-shot bearer input; do not persist or log it.",
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
  description: "Discover, create, fork, or operate on exact sessions.",
  requiresConfig: true,
  run: runSessionCliCommand,
  usage: [
    "stn session current",
    "stn session list [filters]",
    "stn session get <sessionId> [--json] [--require-running]",
    "stn session create <projectId> --branch <branch> (--from-current | --terminal tmux) [options]",
    "stn session fork <sourceSessionId> --branch <branch> (--from-current | --terminal tmux) [options]",
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
      name: "create",
      description: "Create one complete Observer-managed tmux session.",
      usage: [
        "stn session create <projectId> --branch <branch> (--from-current | --terminal tmux) [--title <title>] [--base <ref>] [--harness <providerId>] [--layout <default|agent-only|agent-build-shell>] [--group <groupId> | --new-group <name> | --ungrouped] [--prompt-stdin] [--timeout-ms <ms>] [--json]",
      ],
      options: [
        { name: "--branch <branch>", description: "Set the exact new worktree branch." },
        {
          name: "--from-current",
          description: "Create as a sibling of the invoking tmux pane using fresh authority.",
        },
        {
          name: "--terminal tmux",
          description: "Create a source-free detached tmux workbench target.",
        },
        { name: "--title <title>", description: "Set a display title independent from branch." },
        { name: "--base <ref>", description: "Override the worktree creation base." },
        { name: "--harness <providerId>", description: "Override the project harness default." },
        {
          name: "--layout <layout>",
          description: "Override layout with default, agent-only, or agent-build-shell.",
        },
        { name: "--group <groupId>", description: "Place the session in one exact root Group." },
        { name: "--new-group <name>", description: "Create a new root Group atomically." },
        { name: "--ungrouped", description: "Explicitly create without Group membership." },
        { name: "--prompt-stdin", description: "Read the initial prompt from bounded stdin." },
        {
          name: "--timeout-ms <ms>",
          description: "Override snapshot, dispatch, completion, current, and refresh timeout.",
        },
        { name: "--json", description: "Print the prompt-safe structured result." },
      ],
      examples: [
        "stn session create web --branch feature/review --from-current",
        "printf 'Review the change.\\n' | stn session create web --branch feature/review --terminal tmux --prompt-stdin --json",
        "stn session create --man",
      ],
      notes: [
        outputNote,
        mutationTimeoutNote,
        "Exactly one placement option is required. Detached placement never consults current or focused state.",
        "Create defaults to Ungrouped. Existing placement accepts only an exact same-project root Group; inline creation is atomic.",
        "Omitted harness and layout use the exact project defaults. No terminal provider is inferred, and no target is focused implicitly.",
        "Prompt content never enters argv, create output, or CLI process diagnostics; it remains part of the durable Observer command used for launch.",
        "A succeeded command followed by a stale or unavailable refresh exits successfully with a visible convergence warning.",
      ],
    },
    {
      name: "fork",
      description: "Fork one exact session into a complete Observer-managed tmux session.",
      usage: [
        "stn session fork <sourceSessionId> --branch <branch> (--from-current | --terminal tmux) [--title <title>] [--base <ref>] [--harness <providerId>] [--layout <default|agent-only|agent-build-shell>] [--inherit-group | --ungrouped] [--copy-dirty | --no-copy-dirty] [--prompt-stdin] [--timeout-ms <ms>] [--json]",
      ],
      options: [
        { name: "--branch <branch>", description: "Set the exact forked worktree branch." },
        {
          name: "--from-current",
          description: "Place beside the invoking tmux pane, independently of the code source.",
        },
        {
          name: "--terminal tmux",
          description: "Create a source-free detached tmux workbench target.",
        },
        { name: "--title <title>", description: "Set a display title independent from branch." },
        { name: "--base <ref>", description: "Override the source branch base." },
        { name: "--harness <providerId>", description: "Override the source harness provider." },
        {
          name: "--layout <layout>",
          description: "Override layout with default, agent-only, or agent-build-shell.",
        },
        {
          name: "--inherit-group",
          description: "Explicitly inherit the source session's current Group.",
        },
        { name: "--ungrouped", description: "Opt out of source Group inheritance." },
        { name: "--copy-dirty", description: "Explicitly copy source working-tree changes." },
        {
          name: "--no-copy-dirty",
          description: "Explicitly leave source working-tree changes behind.",
        },
        { name: "--prompt-stdin", description: "Read the initial prompt from bounded stdin." },
        {
          name: "--timeout-ms <ms>",
          description: "Override snapshot, dispatch, completion, current, and refresh timeout.",
        },
        { name: "--json", description: "Print the prompt-safe structured result." },
      ],
      examples: ["stn session fork --man"],
      notes: [
        exactSelectionNote,
        outputNote,
        mutationTimeoutNote,
        "A grouped source inherits its transaction-current Group by default; --ungrouped opts out, and deletion before seed commit succeeds Ungrouped.",
        "Omitting both copy flags preserves Observer's copy-dirty default as a distinct third state.",
        "The exact source session supplies project, worktree, and default harness. Placement may independently come from another invoking tmux pane.",
        "No project override, provider fallback, implicit focus, native placement, or new-container mode is available.",
        "Prompt content never enters argv, fork output, or CLI process diagnostics; it remains part of the durable Observer command used for launch.",
        "A succeeded command followed by a stale or unavailable refresh exits successfully with a visible convergence warning.",
      ],
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
  const prompt = await readSessionPrompt(parsed, context);
  const options: SessionCommandOptions = {
    ...loadedCommandOptions(context),
    ...context.options.sessionDeps,
  };
  if (prompt !== undefined) options.initialPrompt = prompt;
  const result = await runSessionCommand(parsed, options, context.options.observerDeps);
  if (result.action === "current") {
    return { code: 0, output: result.context };
  }
  const code = sessionCommandExitCode(result);
  const correlation =
    result.action === "create" || result.action === "fork"
      ? sessionCreationCorrelation(result.outcome)
      : result.action === "rename" || result.action === "close"
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

async function readSessionPrompt(
  parsed: ReturnType<typeof parseSessionArgs>,
  context: CliCommandRunContext,
): Promise<string | undefined> {
  if ((parsed.action !== "create" && parsed.action !== "fork") || !parsed.promptStdin) {
    return undefined;
  }
  let stdin: string | undefined;
  try {
    stdin = context.options.stdin ?? (await readStdinIfAvailable());
  } catch (cause) {
    throw new CliInputError(
      "CLI_SESSION_PROMPT_STDIN_TOO_LARGE",
      "The prompt on stdin exceeded the supported size limit.",
      { cause },
    );
  }
  if (stdin === undefined || stdin.trim().length === 0) {
    throw new CliInputError(
      "CLI_SESSION_PROMPT_STDIN_REQUIRED",
      "--prompt-stdin requires a non-empty prompt on stdin.",
    );
  }
  if (Buffer.byteLength(stdin) > defaultStdinMaxBytes) {
    throw new CliInputError(
      "CLI_SESSION_PROMPT_STDIN_TOO_LARGE",
      "The prompt on stdin exceeded the supported size limit.",
    );
  }
  return stdin;
}
