import type { SafeError } from "@station/contracts";
import { shellQuote } from "@station/runtime";
import {
  resolveSetupMessage,
  type SetupMessageRef,
  setupMessageRef,
} from "@station/setup-messages";
import type { SetupAction } from "../model.js";
import type {
  ProjectSetupView,
  SetupDisplayDetail,
  SetupRecoveryInstruction,
  SetupViewAction,
  SetupViewCheck,
} from "../presentation/projectSetupView.js";
import { type SetupRenderOptions, type SetupTheme, setupTheme } from "./theme.js";

export type TextSetupPresenterOptions = SetupRenderOptions & {
  readonly write?: (chunk: string) => void | Promise<void>;
};

export type TextSetupSystemRow = {
  readonly status: SetupViewCheck["status"];
  readonly label: SetupMessageRef;
  readonly detail?: string;
};

export type TextSetupSystemHint = {
  readonly message: SetupMessageRef;
  readonly commands?: readonly (readonly string[])[];
  readonly commandSequences?: readonly (readonly (readonly string[])[])[];
};

export type TextSetupSystemView = {
  readonly title: SetupMessageRef;
  readonly rows: readonly TextSetupSystemRow[];
  readonly hints: readonly TextSetupSystemHint[];
};

export type TextSetupPresenter = {
  readonly text: (ref: SetupMessageRef) => string;
  readonly prompt: (ref: SetupMessageRef) => string;
  readonly write: (chunk: string) => Promise<void>;
  readonly writeMessage: (ref: SetupMessageRef) => Promise<void>;
  readonly renderPlan: (view: ProjectSetupView) => string;
  readonly renderApplyResult: (view: ProjectSetupView) => string;
  readonly renderProgressStart: (action: Pick<SetupAction, "label">) => string;
  readonly renderProgressComplete: (action: Pick<SetupAction, "label">) => string;
  readonly renderProgressFailure: (action: Pick<SetupAction, "label">, error?: SafeError) => string;
  readonly renderInspectionFailure: (error: SafeError) => string;
  readonly renderActivationStart: () => string;
  readonly renderActivationComplete: () => string;
  readonly renderActivationFailure: (
    error: SafeError,
    commands: { readonly restart: readonly string[]; readonly setup: readonly string[] },
  ) => string;
  readonly renderSystemStatus: (view: TextSetupSystemView) => string;
};

/**
 * ADAPTER
 *
 * Resolves typed setup views and message references into terminal prompts and output.
 */
export function createTextSetupPresenter(
  options: TextSetupPresenterOptions = {},
): TextSetupPresenter {
  const theme = setupTheme(options);
  const writer = options.write ?? defaultWrite;
  const text = (ref: SetupMessageRef) => resolveSetupMessage(ref);
  return {
    text,
    prompt: text,
    async write(chunk) {
      await writer(chunk);
    },
    async writeMessage(ref) {
      await writer(`${text(ref)}\n`);
    },
    renderPlan: (view) => renderPlan(view, theme),
    renderApplyResult: (view) => renderApplyResult(view, theme),
    renderProgressStart: (action) =>
      theme.bold(text(setupMessageRef("progress.start", { label: action.label }))),
    renderProgressComplete: (action) =>
      theme.green(text(setupMessageRef("progress.complete", { label: action.label }))),
    renderProgressFailure: (action, error) => renderProgressFailure(action.label, error, theme),
    renderInspectionFailure: (error) =>
      renderProgressFailure(text(setupMessageRef("label.setup-inspection")), error, theme),
    renderActivationStart: () => text(setupMessageRef("activation.start")),
    renderActivationComplete: () => theme.green(text(setupMessageRef("activation.complete"))),
    renderActivationFailure: (error, commands) => renderActivationFailure(error, commands, theme),
    renderSystemStatus: (view) => renderSystemStatus(view, theme),
  };
}

function renderPlan(view: ProjectSetupView, theme: SetupTheme): string {
  const lines = [
    theme.bold(theme.cyan(resolveSetupMessage(view.title))),
    resolveSetupMessage(view.selection.summary),
    "",
  ];
  const sections = [
    { tier: "required" as const, heading: setupMessageRef("section.core") },
    { tier: "recommended" as const, heading: setupMessageRef("section.recommended") },
    { tier: "optional" as const, heading: setupMessageRef("section.later") },
  ];
  for (const section of sections) {
    const checks = view.checks.filter((check) => check.tier === section.tier);
    if (checks.length === 0) continue;
    lines.push(sectionHeading(resolveSetupMessage(section.heading), theme), "");
    for (const check of checks) lines.push(...renderCheck(check, theme));
    lines.push("");
  }
  if (view.actions.length > 0) {
    lines.push(sectionHeading(resolveSetupMessage(setupMessageRef("section.actions")), theme), "");
    for (const action of view.actions) lines.push(...renderAction(action, theme));
    lines.push("");
  }
  if (view.recovery.length > 0) {
    lines.push(sectionHeading(resolveSetupMessage(setupMessageRef("section.next")), theme), "");
    for (const instruction of view.recovery)
      lines.push(...renderRecoveryInstruction(instruction, theme));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderApplyResult(view: ProjectSetupView, theme: SetupTheme): string {
  const presentation = view.result.apply;
  switch (presentation.kind) {
    case "complete":
      return renderSuccessfulApply(presentation, theme);
    case "blocked":
      return renderRecoveryBlock(
        presentation.title,
        presentation.detail,
        presentation.commands,
        theme,
      );
    case "message":
      return `${theme.bold(theme.red(resolveSetupMessage(presentation.message)))}\n`;
    case "config-write-failed":
      return `${theme.bold(theme.red(resolveSetupMessage(presentation.message)))}\n`;
  }
}

function renderSuccessfulApply(
  presentation: Extract<ProjectSetupView["result"]["apply"], { kind: "complete" }>,
  theme: SetupTheme,
): string {
  const tracking =
    presentation.preparedHarnesses.length === 0
      ? ""
      : ` ${resolveSetupMessage(
          setupMessageRef("completion.tracking", {
            harnesses: joinHumanList(
              presentation.preparedHarnesses.map((harness) => harness.label),
            ),
          }),
        )}`;
  const lines = [
    theme.bold(
      theme.green(`${resolveSetupMessage(setupMessageRef("completion.core"))}${tracking}`),
    ),
  ];
  if (presentation.showCodexReview) {
    lines.push("", resolveSetupMessage(setupMessageRef("completion.codex-review")));
  }
  const warning = presentation.launcherWarning;
  if (warning !== undefined) {
    lines.push(
      "",
      sectionHeading(resolveSetupMessage(setupMessageRef("section.remaining")), theme),
      "",
      ...renderCheck(warning.check, theme),
    );
    if (warning.linkAction !== undefined && warning.linkCommand !== undefined) {
      lines.push(...renderAction(warning.linkAction, theme));
      lines.push(`           ${theme.cyan(`Run: ${formatSetupCommand(warning.linkCommand)}`)}`);
    }
    if (warning.pathDirectory !== undefined) {
      lines.push(
        "",
        theme.bold(resolveSetupMessage(setupMessageRef("completion.current-shell-path-title"))),
        `  ${theme.cyan(`PATH=${shellQuote(warning.pathDirectory, true)}\${PATH:+":$PATH"}`)}`,
        `  ${theme.cyan("export PATH")}`,
        `  ${theme.cyan("hash -r")}`,
      );
    }
    lines.push(...bareLauncherConvenience(warning.pathDirectory, warning.linkCommand, theme));
  }
  lines.push("", sectionHeading(resolveSetupMessage(setupMessageRef("section.next")), theme), "");
  lines.push(
    ...presentation.nextCommands.map((command) => {
      const formatted =
        warning === undefined
          ? formatSetupCommand(command)
          : formatSelectedLauncherCommand(command);
      return `  ${theme.cyan(formatted)}`;
    }),
    "",
  );
  return lines.join("\n");
}

function renderCheck(check: SetupViewCheck, theme: SetupTheme): string[] {
  const status = colorStatus(statusLabel(check.status), check.status, theme);
  return [
    `  ${pad(status, statusColumnWidth)} ${pad(resolveSetupMessage(check.label), labelColumnWidth)} ${resolveSetupMessage(check.explanation)}`,
    ...renderDetails(check.details, theme),
  ];
}

function renderDetails(details: readonly SetupDisplayDetail[], theme: SetupTheme): string[] {
  return details.flatMap((detail) =>
    detail.value.length === 0
      ? []
      : [`           ${theme.dim(`${resolveSetupMessage(detail.label)}: ${detail.value}`)}`],
  );
}

function renderAction(action: SetupViewAction, theme: SetupTheme): string[] {
  const skipped = action.status === "skipped" || (action.status === undefined && !action.selected);
  const status = skipped
    ? theme.dim(resolveSetupMessage(setupMessageRef("action.skipped")))
    : theme.cyan(resolveSetupMessage(setupMessageRef("action.selected")));
  return [
    `  ${pad(status, statusColumnWidth)} ${pad(resolveSetupMessage(action.label), labelColumnWidth)} ${resolveSetupMessage(action.explanation)}`,
  ];
}

function renderRecoveryInstruction(
  instruction: SetupRecoveryInstruction,
  theme: SetupTheme,
): string[] {
  if (instruction.kind === "command") {
    return [`  ${theme.cyan(formatSetupCommand(instruction.command))}`];
  }
  const lines = [`  ${resolveSetupMessage(instruction.message)}`];
  if (instruction.command !== undefined) {
    lines.push(`    ${theme.cyan(formatSetupCommand(instruction.command))}`);
  }
  return lines;
}

function renderRecoveryBlock(
  title: SetupMessageRef,
  detail: SetupMessageRef,
  commands: readonly (readonly string[])[],
  theme: SetupTheme,
): string {
  return [
    theme.bold(theme.red(resolveSetupMessage(title))),
    resolveSetupMessage(detail),
    ...commands.map((command) => `  ${theme.cyan(formatSetupCommand(command))}`),
    "",
  ].join("\n");
}

function renderProgressFailure(
  label: string,
  error: SafeError | undefined,
  theme: SetupTheme,
): string {
  const lines = [theme.red(resolveSetupMessage(setupMessageRef("progress.failed", { label })))];
  if (error !== undefined) {
    lines.push(
      resolveSetupMessage(
        setupMessageRef("progress.failed-evidence", {
          message: error.message,
          code: error.code,
        }),
      ),
    );
    if (error.hint !== undefined) {
      lines.push(resolveSetupMessage(setupMessageRef("progress.hint", { hint: error.hint })));
    }
  }
  return lines.join("\n");
}

function renderActivationFailure(
  error: SafeError,
  commands: { readonly restart: readonly string[]; readonly setup: readonly string[] },
  theme: SetupTheme,
): string {
  const lines = [
    theme.bold(theme.red(resolveSetupMessage(setupMessageRef("activation.failed")))),
    error.message,
    resolveSetupMessage(setupMessageRef("error.code", { code: error.code })),
  ];
  if (error.hint !== undefined) {
    lines.push(resolveSetupMessage(setupMessageRef("error.hint", { hint: error.hint })));
  }
  lines.push(
    resolveSetupMessage(setupMessageRef("activation.config-saved")),
    resolveSetupMessage(setupMessageRef("activation.recovery-introduction")),
    resolveSetupMessage(
      setupMessageRef("activation.restart-command", {
        command: formatSetupCommand(commands.restart),
      }),
    ),
    resolveSetupMessage(
      setupMessageRef("activation.setup-command", { command: formatSetupCommand(commands.setup) }),
    ),
    "",
  );
  return lines.join("\n");
}

function renderSystemStatus(view: TextSetupSystemView, theme: SetupTheme): string {
  const lines = [theme.bold(resolveSetupMessage(view.title)), ""];
  for (const row of view.rows) {
    const status = colorStatus(statusLabel(row.status), row.status, theme);
    lines.push(
      `  ${status} ${resolveSetupMessage(row.label)}${row.detail === undefined ? "" : ` ${row.detail}`}`,
    );
  }
  if (view.hints.length > 0) {
    lines.push("", theme.bold(resolveSetupMessage(setupMessageRef("system.development-runtime"))));
    for (const hint of view.hints) {
      lines.push(`  ${resolveSetupMessage(hint.message)}`);
      if (hint.commands !== undefined) {
        lines.push(
          ...hint.commands.map((command) => `    ${theme.cyan(formatSetupCommand(command))}`),
        );
      }
      if (hint.commandSequences !== undefined) {
        lines.push(
          ...hint.commandSequences.map(
            (sequence) => `    ${theme.cyan(sequence.map(formatSetupCommand).join(" && "))}`,
          ),
        );
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function bareLauncherConvenience(
  pathDirectory: string | undefined,
  linkCommand: readonly string[] | undefined,
  theme: SetupTheme,
): string[] {
  if (pathDirectory === undefined && linkCommand === undefined) {
    return [
      "",
      `  ${theme.dim(resolveSetupMessage(setupMessageRef("completion.future-shell-unverified")))}`,
    ];
  }
  const lines = [
    "",
    theme.bold(resolveSetupMessage(setupMessageRef("completion.short-launchers-title"))),
    `  ${resolveSetupMessage(setupMessageRef("completion.short-launchers-explanation"))}`,
  ];
  if (pathDirectory !== undefined) {
    lines.push(
      `  ${resolveSetupMessage(setupMessageRef("completion.current-shell-path-step"))}`,
      `  ${resolveSetupMessage(
        setupMessageRef("completion.future-shell-path-step", {
          directory: shellQuote(pathDirectory, true),
        }),
      )}`,
      `  ${resolveSetupMessage(setupMessageRef("completion.prefer-path"))}`,
    );
  }
  if (linkCommand !== undefined) {
    lines.push(`  ${resolveSetupMessage(setupMessageRef("completion.checkout-link-step"))}`);
  }
  lines.push(
    `  ${resolveSetupMessage(setupMessageRef("completion.verify"))}`,
    `    ${theme.cyan("command -v stn")}`,
    `    ${theme.cyan("command -v stn-ingress")}`,
    `    ${theme.cyan("command -v stn-tmux-popup")}`,
    `  ${theme.dim(resolveSetupMessage(setupMessageRef("completion.future-shell-unverified")))}`,
  );
  return lines;
}

function joinHumanList(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function statusLabel(status: SetupViewCheck["status"]): string {
  switch (status) {
    case "ok":
      return resolveSetupMessage(setupMessageRef("status.ok"));
    case "missing":
      return resolveSetupMessage(setupMessageRef("status.missing"));
    case "warning":
      return resolveSetupMessage(setupMessageRef("status.warning"));
    case "skipped":
      return resolveSetupMessage(setupMessageRef("status.skipped"));
  }
}

function colorStatus(label: string, status: SetupViewCheck["status"], theme: SetupTheme): string {
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

export function formatSetupCommand(command: readonly string[]): string {
  return command.map((part) => shellQuote(part)).join(" ");
}

function formatSelectedLauncherCommand(command: readonly string[]): string {
  const [executable, ...args] = command;
  if (executable === undefined) return "";
  // Keep selected absolute launchers visibly delimited even when their path happens to be shell-safe.
  return [shellQuote(executable, true), ...args.map((arg) => shellQuote(arg))].join(" ");
}

function sectionHeading(label: string, theme: SetupTheme): string {
  return theme.bold(label);
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function visibleLength(value: string): number {
  // The setup theme emits only SGR styling, so skipping through "m" is sufficient for column alignment.
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x1b && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") index += 1;
      continue;
    }
    length += 1;
  }
  return length;
}

function defaultWrite(chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const statusColumnWidth = 9;
const labelColumnWidth = 36;
