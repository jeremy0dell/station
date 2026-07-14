import type { SetupAction, SetupCheck, SetupPlan, SetupTier } from "./model.js";
import { type SetupRenderOptions, type SetupTheme, setupTheme } from "./theme.js";

const tierHeadings: Record<SetupTier, string> = {
  required: "Core",
  recommended: "Recommended",
  optional: "Later",
};

const statusLabels: Record<SetupCheck["status"], string> = {
  ok: "OK",
  missing: "MISSING",
  warning: "WARN",
  skipped: "SKIP",
};

const actionLabels = {
  selected: "WILL",
  skipped: "SKIP",
} as const;

const statusColumnWidth = 9;
const labelColumnWidth = 36;

export function renderSetupPlan(plan: SetupPlan, options: SetupRenderOptions = {}): string {
  const theme = setupTheme(options);
  const lines: string[] = [];
  lines.push(theme.bold(theme.cyan(`stn setup ${plan.mode}`)));
  lines.push("");
  for (const tier of ["required", "recommended", "optional"] as const) {
    const checks = plan.checks.filter((check) => check.tier === tier);
    if (checks.length === 0) continue;
    lines.push(sectionHeading(tierHeadings[tier], theme));
    lines.push("");
    for (const check of checks) {
      lines.push(...renderCheck(check, theme));
    }
    lines.push("");
  }

  if (plan.actions.length > 0) {
    lines.push(sectionHeading("Actions", theme));
    lines.push("");
    for (const action of plan.actions) {
      lines.push(...renderAction(action, theme));
    }
    lines.push("");
  }

  if (plan.nextSteps.length > 0) {
    lines.push(sectionHeading("Next", theme));
    lines.push("");
    for (const step of plan.nextSteps) {
      lines.push(`  ${theme.cyan(step)}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSetupApplyResult(plan: SetupPlan, options: SetupRenderOptions = {}): string {
  const theme = setupTheme(options);
  if (plan.summary.requiredOk) {
    // plan.nextSteps is computed before apply, so on a freshly-completed setup it
    // can still read "resolve the missing items". Show the completion steps here.
    const nextSteps = ["stn doctor", "stn"];
    return [
      theme.bold(theme.green("Core setup complete.")),
      "",
      sectionHeading("Next", theme),
      "",
      ...nextSteps.map((step) => `  ${theme.cyan(step)}`),
      "",
    ].join("\n");
  }
  const missing = plan.checks.find(
    (check) => check.tier === "required" && check.status === "missing",
  );
  if (missing?.id === "command-line-tools") {
    return missingResult(missing.message, "Then run:", theme);
  }
  if (missing?.id === "worktrunk") {
    return missingResult("Worktrunk is still missing.", "Install it, then run:", theme);
  }
  if (missing?.id === "tmux") {
    return missingResult("tmux is still missing.", "Install it, then run:", theme);
  }
  if (missing?.id === "bun") {
    return missingResult(
      "Bun is still missing (bare stn renders the TUI through it).",
      "Install it (brew install bun), then run:",
      theme,
    );
  }
  if (missing?.id === "harness") {
    return missingResult(
      "No supported agent CLI is available.",
      "Install claude, codex, cursor agent, opencode, or pi, then run:",
      theme,
    );
  }
  if (missing?.id === "diffnav") {
    return missingResult(
      "diffnav is still missing.",
      "Install it (brew install diffnav), then run:",
      theme,
    );
  }
  if (missing?.id === "git-delta") {
    return missingResult(
      "git-delta is still missing (diffnav renders through it).",
      "Install it (brew install git-delta), then run:",
      theme,
    );
  }
  return missingResult("Core setup is incomplete.", "Resolve the missing item, then run:", theme);
}

export function formatCommand(command: readonly string[]): string {
  return command.map((part) => quoteCommandPart(part)).join(" ");
}

export function renderActionStart(action: SetupAction, options: SetupRenderOptions = {}): string {
  const theme = setupTheme(options);
  if (action.command !== undefined) {
    return `${theme.bold("Running:")} ${theme.cyan(formatCommand(action.command))}`;
  }
  if (action.path !== undefined) {
    return `${theme.bold("Applying:")} ${action.label} ${theme.dim(`(${action.path})`)}`;
  }
  return `${theme.bold("Applying:")} ${action.label}`;
}

export function renderActionComplete(
  action: SetupAction,
  options: SetupRenderOptions = {},
): string {
  const theme = setupTheme(options);
  return `${theme.green("Completed:")} ${action.label}`;
}

export function renderActionFailed(action: SetupAction, options: SetupRenderOptions = {}): string {
  const theme = setupTheme(options);
  return `${theme.red("Failed:")} ${action.label}`;
}

function renderCheck(check: SetupCheck, theme: SetupTheme): string[] {
  const status = colorStatus(statusLabels[check.status], check.status, theme);
  const lines = [
    `  ${pad(status, statusColumnWidth)} ${pad(check.label, labelColumnWidth)} ${check.message}`,
  ];
  lines.push(...detailLines(check.details, theme));
  return lines;
}

function renderAction(action: SetupAction, theme: SetupTheme): string[] {
  const status = action.selected
    ? theme.cyan(actionLabels.selected)
    : theme.dim(actionLabels.skipped);
  const lines = [
    `  ${pad(status, statusColumnWidth)} ${pad(action.label, labelColumnWidth)} ${action.message}`,
  ];
  if (action.command !== undefined) {
    lines.push(
      `  ${"".padEnd(statusColumnWidth)} ${theme.dim(`command ${formatCommand(action.command)}`)}`,
    );
  }
  if (action.path !== undefined) {
    lines.push(`  ${"".padEnd(statusColumnWidth)} ${theme.dim(`path ${action.path}`)}`);
  }
  return lines;
}

function detailLines(details: SetupCheck["details"], theme: SetupTheme): string[] {
  if (details === undefined) return [];
  const orderedKeys = [
    "command",
    "version",
    "path",
    "root",
    "defaultBranch",
    "selected",
    "available",
    "automationMode",
    "flag",
    "missingSubcommands",
    "station",
    "ingress",
    "tmuxPopup",
    "resolvedPath",
    "launcherCommand",
    "liveStatus",
  ];
  const lines: string[] = [];
  for (const key of orderedKeys) {
    const value = details[key];
    if (value === undefined || value.length === 0) continue;
    lines.push(`  ${"".padEnd(statusColumnWidth)} ${theme.dim(`${key} ${value}`)}`);
  }
  return lines;
}

function colorStatus(label: string, status: SetupCheck["status"], theme: SetupTheme): string {
  switch (status) {
    case "ok":
      return theme.green(label);
    case "missing":
      return theme.red(label);
    case "warning":
      return theme.yellow(label);
    case "skipped":
      return theme.dim(label);
  }
}

function sectionHeading(label: string, theme: SetupTheme): string {
  return theme.bold(label);
}

function missingResult(title: string, detail: string, theme: SetupTheme): string {
  return [theme.bold(theme.red(title)), detail, `  ${theme.cyan("stn setup check")}`, ""].join(
    "\n",
  );
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function visibleLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x1b && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") {
        index += 1;
      }
      continue;
    }
    length += 1;
  }
  return length;
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(part)) {
    return part;
  }
  return `'${part.replaceAll("'", "'\\''")}'`;
}
