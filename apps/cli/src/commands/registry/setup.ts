import type { CliCommandNode, CliCommandRunContext } from "../cliCommand/types.js";
import { runSetupCommand } from "../setup/index.js";

export const setupCliCommand: CliCommandNode = {
  name: "setup",
  description: "Check, plan, or apply local STATION setup.",
  run: runSetupCliCommand,
  usage: [
    "stn setup",
    "stn setup check [--json] [--no-brew]",
    "stn setup plan [--json] [--no-brew]",
    "stn setup apply --yes",
    "stn setup apply --dry-run",
    "stn setup system --check",
    "stn setup system --yes",
  ],
  options: [
    { name: "--json", description: "Use JSON output for check and plan." },
    { name: "--yes, -y", description: "Confirm apply or system install actions." },
    { name: "--dry-run", description: "Preview apply output without writing." },
    { name: "--no-brew", description: "Skip Homebrew-dependent checks and actions." },
    { name: "--check", description: "Run setup system in read-only check mode." },
  ],
  examples: ["pnpm stn setup check --json", "pnpm stn setup apply --dry-run"],
  notes: [
    "Core STATION setup is separate from optional provider CLIs and shell integrations.",
    "Setup help and manual output is read-only and does not inspect the local machine.",
  ],
  children: [
    {
      name: "check",
      description: "Read current setup facts and recommended actions.",
      usage: ["stn setup check [--json] [--no-brew]"],
      options: [
        { name: "--json", description: "Print machine-readable setup status." },
        { name: "--no-brew", description: "Skip Homebrew-dependent checks." },
      ],
      examples: ["pnpm stn setup check --json"],
    },
    {
      name: "plan",
      description: "Render the setup action plan.",
      usage: ["stn setup plan [--json] [--no-brew]"],
      options: [
        { name: "--json", description: "Print machine-readable setup plan output." },
        { name: "--no-brew", description: "Skip Homebrew-dependent actions in the plan." },
      ],
      examples: ["pnpm stn setup plan"],
    },
    {
      name: "apply",
      description: "Apply the non-interactive setup plan.",
      usage: ["stn setup apply --yes", "stn setup apply --dry-run"],
      options: [
        { name: "--yes, -y", description: "Confirm applying setup changes." },
        { name: "--dry-run", description: "Preview apply output without writing." },
        { name: "--no-brew", description: "Skip Homebrew-dependent actions." },
      ],
      examples: ["pnpm stn setup apply --dry-run", "pnpm stn setup apply --yes"],
    },
    {
      name: "system",
      description: "Check or install system-level dependencies.",
      usage: ["stn setup system --check", "stn setup system --yes"],
      options: [
        { name: "--check", description: "Inspect system dependency readiness." },
        { name: "--yes, -y", description: "Confirm system dependency installation." },
      ],
      examples: ["pnpm stn setup system --check"],
    },
  ],
};

async function runSetupCliCommand(context: CliCommandRunContext) {
  const setupOptions: Parameters<typeof runSetupCommand>[1] = {
    renderHelp: (path) => context.renderHelpTopic(path, "help"),
  };
  if (context.configPath !== undefined) setupOptions.configPath = context.configPath;
  if (context.options.env !== undefined) setupOptions.env = context.options.env;
  return runSetupCommand(context.args, setupOptions, context.options.setupDeps);
}
