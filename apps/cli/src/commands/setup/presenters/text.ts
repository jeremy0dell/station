import type { SafeError } from "@station/contracts";
import {
  resolveSetupMessage,
  type SetupMessageRef,
  setupMessageRef,
} from "@station/setup-messages";
import type { SetupAction, SetupCheck } from "../model.js";
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
  readonly status: "ok" | "missing" | "warning" | "skipped";
  readonly label: SetupMessageRef;
  readonly detail?: string;
};

export type TextSetupSystemHint = {
  readonly message: SetupMessageRef;
  readonly commands?: readonly (readonly string[])[];
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
  readonly renderApplyResult: (
    view: ProjectSetupView,
    options?: { readonly selectionRequired?: boolean },
  ) => string;
  readonly renderProgressStart: (action: Pick<SetupAction, "label">) => string;
  readonly renderProgressComplete: (action: Pick<SetupAction, "label">) => string;
  readonly renderProgressFailure: (action: Pick<SetupAction, "label">, error?: SafeError) => string;
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
    renderApplyResult: (view, renderOptions) => renderApplyResult(view, theme, renderOptions),
    renderProgressStart: (action) =>
      theme.bold(text(setupMessageRef("progress.start", { label: action.label }))),
    renderProgressComplete: (action) =>
      theme.green(text(setupMessageRef("progress.complete", { label: action.label }))),
    renderProgressFailure: (action, error) => renderProgressFailure(action.label, error, theme),
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
    for (const instruction of view.recovery) {
      lines.push(...renderRecoveryInstruction(instruction, theme));
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderApplyResult(
  view: ProjectSetupView,
  theme: SetupTheme,
  options: { readonly selectionRequired?: boolean } = {},
): string {
  if (options.selectionRequired === true) {
    const harnessCheck = view.checks.find((check) => check.id === "harness");
    return renderRecoveryBlock(
      harnessCheck?.explanation ?? setupMessageRef("recovery.selection-required"),
      setupMessageRef("recovery.selection-command"),
      [["stn", "--config", view.configPath, "setup"]],
      theme,
    );
  }
  if (view.result.readiness.workflowReady) return renderSuccessfulApply(view, theme);

  const missing = view.checks.find(
    (check) => check.tier === "required" && check.status === "missing",
  );
  if (missing === undefined) {
    return renderRecoveryBlock(
      setupMessageRef("recovery.core-incomplete"),
      setupMessageRef("recovery.then-run"),
      [["stn", "setup", "check"]],
      theme,
    );
  }
  if (missing.id === "git-project") {
    return `${theme.bold(theme.red(resolveSetupMessage(missing.explanation)))}\n`;
  }
  if (missing.id.startsWith("harness-tracking:")) {
    const recoveryAction = view.actions.find(
      (action) => action.id === `${missing.id.slice("harness-tracking:".length)}-hooks`,
    );
    const commands =
      recoveryAction === undefined ? [["stn", "setup", "check"]] : actionCommands(recoveryAction);
    return renderRecoveryBlock(
      missing.explanation,
      setupMessageRef("recovery.tracking"),
      commands,
      theme,
    );
  }
  const title = missingRecoveryTitle(missing);
  const commands = view.recovery.flatMap(recoveryCommands);
  return renderRecoveryBlock(
    title,
    setupMessageRef("recovery.then-run"),
    commands.length === 0 ? [["stn", "setup", "check"]] : commands,
    theme,
  );
}

function renderSuccessfulApply(view: ProjectSetupView, theme: SetupTheme): string {
  const prepared = preparedHarnesses(view);
  const completion =
    prepared.length === 0
      ? resolveSetupMessage(setupMessageRef("completion.core"))
      : `${resolveSetupMessage(setupMessageRef("completion.core"))} ${resolveSetupMessage(
          setupMessageRef("completion.tracking", {
            harnesses: joinHumanList(prepared.map((harness) => harness.label)),
          }),
        )}`;
  const lines = [theme.bold(theme.green(completion))];
  if (prepared.some((harness) => harness.id === "codex")) {
    lines.push("", resolveSetupMessage(setupMessageRef("completion.codex-review")));
  }

  const launcherWarning = view.checks.find(
    (check) => check.id === "station-launchers" && check.status === "warning",
  );
  if (launcherWarning !== undefined) {
    lines.push(
      "",
      sectionHeading(resolveSetupMessage(setupMessageRef("section.remaining")), theme),
      "",
      ...renderCheck(launcherWarning, theme),
    );
    const launcherLink = view.actions.find((action) => action.id === "link-station-launchers");
    if (launcherLink !== undefined) {
      lines.push(...renderAction(launcherLink, theme));
      for (const command of actionCommands(launcherLink)) {
        lines.push(`           ${theme.cyan(`Run: ${formatCommand(command)}`)}`);
      }
    }
    const pathDirectory = detailValue(launcherWarning.details, "launcher-directory");
    if (pathDirectory !== undefined) {
      lines.push(
        "",
        theme.bold(resolveSetupMessage(setupMessageRef("completion.current-shell-path-title"))),
        `  ${theme.cyan(`PATH=${quoteShellPart(pathDirectory)}\${PATH:+":$PATH"}`)}`,
        `  ${theme.cyan("export PATH")}`,
        `  ${theme.cyan("hash -r")}`,
      );
    }
    lines.push(...bareLauncherConvenience(pathDirectory, launcherLink, theme));
  }

  lines.push("", sectionHeading(resolveSetupMessage(setupMessageRef("section.next")), theme), "");
  const stationExecutable =
    launcherWarning === undefined
      ? undefined
      : detailValue(launcherWarning.details, "station-launcher");
  const commands =
    stationExecutable === undefined
      ? [formatCommand(["stn", "doctor"]), formatCommand(["stn"])]
      : [
          formatSelectedLauncherCommand(stationExecutable, ["doctor"]),
          formatSelectedLauncherCommand(stationExecutable),
        ];
  lines.push(...commands.map((command) => `  ${theme.cyan(command)}`), "");
  return lines.join("\n");
}

function renderCheck(check: SetupViewCheck, theme: SetupTheme): string[] {
  const status = colorStatus(statusLabel(check.status), check.status, theme);
  const label = resolveSetupMessage(check.label);
  const lines = [
    `  ${pad(status, statusColumnWidth)} ${pad(label, labelColumnWidth)} ${resolveSetupMessage(check.explanation)}`,
  ];
  lines.push(...renderDetails(check.details, theme));
  return lines;
}

function renderDetails(details: readonly SetupDisplayDetail[], theme: SetupTheme): string[] {
  const lines: string[] = [];
  for (const detail of details) {
    const label = displayDetailLabel(detail.kind);
    if (label === undefined || detail.value.length === 0) continue;
    lines.push(`           ${theme.dim(`${label}: ${detail.value}`)}`);
  }
  return lines;
}

function displayDetailLabel(kind: SetupDisplayDetail["kind"]): string | undefined {
  switch (kind) {
    case "version":
      return "Version";
    case "path":
      return "Path";
    case "repository-root":
      return "Repository";
    case "default-branch":
      return "Default branch";
    case "station-launcher":
      return "Station";
    case "ingress-launcher":
      return "Ingress";
    case "tmux-popup-launcher":
      return "tmux popup";
    case "launcher-directory":
      return undefined;
    case "resolved-executable":
      return "Found at";
    case "worktrunk-policy":
      return "Worktrunk automation";
    case "worktrunk-flag":
      return "Worktrunk option";
    case "missing-subcommands":
      return "Unavailable Worktrunk operations";
    case "tmux-binding-key":
      return "Binding";
    case "shell":
      return "Shell";
    case "shell-config-path":
      return "Shell config";
    case "tracking-owner-status":
      return "Tracking ownership";
    case "current-launcher":
      return "Current tracking launcher";
    case "requested-launcher":
      return "Requested tracking launcher";
    case "executable":
    case "reason":
    case "selection-origin":
    case "available-harnesses":
    case "default-harness":
    case "enabled-harnesses":
    case "unavailable-harnesses":
    case "default-harness-status":
    case "tracking-state":
    case "harness-identity":
    case "tracking-capability":
    case "tracking-requested":
    case "tracking-installed":
    case "requested-runtime-kind":
    case "requested-runtime-version":
    case "requested-build-identity":
    case "current-runtime-kind":
    case "current-runtime-version":
    case "current-build-identity":
    case "tmux-binding-launcher":
    case "tmux-live-status":
    case "configured-harnesses":
    case "project":
    case "worktree-provider":
    case "terminal":
      return undefined;
  }
}

function renderAction(action: SetupViewAction, theme: SetupTheme): string[] {
  const status = action.selected
    ? theme.cyan(resolveSetupMessage(setupMessageRef("action.selected")))
    : theme.dim(resolveSetupMessage(setupMessageRef("action.skipped")));
  return [
    `  ${pad(status, statusColumnWidth)} ${pad(resolveSetupMessage(action.label), labelColumnWidth)} ${resolveSetupMessage(action.explanation)}`,
  ];
}

function renderRecoveryInstruction(
  instruction: SetupRecoveryInstruction,
  theme: SetupTheme,
): string[] {
  if (instruction.kind === "command") {
    return [`  ${theme.cyan(formatCommand(instruction.command))}`];
  }
  const lines = [`  ${resolveSetupMessage(instruction.message)}`];
  if (instruction.command !== undefined) {
    lines.push(`    ${theme.cyan(formatCommand(instruction.command))}`);
  }
  return lines;
}

function renderRecoveryBlock(
  title: SetupMessageRef,
  detail: SetupMessageRef,
  commands: readonly (readonly string[])[],
  theme: SetupTheme,
): string {
  const lines = [
    theme.bold(theme.red(resolveSetupMessage(title))),
    resolveSetupMessage(detail),
    ...commands.map((command) => `  ${theme.cyan(formatCommand(command))}`),
    "",
  ];
  return lines.join("\n");
}

function missingRecoveryTitle(check: SetupViewCheck): SetupMessageRef {
  switch (check.id) {
    case "command-line-tools":
      return setupMessageRef("recovery.command-line-tools");
    case "worktrunk":
      return setupMessageRef("recovery.worktrunk");
    case "tmux":
      return setupMessageRef("recovery.tmux");
    case "bun":
      return setupMessageRef("recovery.bun");
    case "harness":
      return check.explanation;
    case "diffnav":
      return setupMessageRef("recovery.diffnav");
    case "git-delta":
      return setupMessageRef("recovery.git-delta");
    default:
      return check.explanation;
  }
}

function actionCommands(action: SetupViewAction): readonly (readonly string[])[] {
  switch (action.execution.kind) {
    case "package-install":
    case "command":
      return [action.execution.command];
    case "directory":
    case "config-write":
    case "file-append":
    case "none":
      return [];
  }
}

function recoveryCommands(instruction: SetupRecoveryInstruction): readonly (readonly string[])[] {
  if (instruction.kind === "command") return [instruction.command];
  return instruction.command === undefined ? [] : [instruction.command];
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
        command: formatCommand(commands.restart),
      }),
    ),
    resolveSetupMessage(
      setupMessageRef("activation.setup-command", { command: formatCommand(commands.setup) }),
    ),
    "",
  );
  return lines.join("\n");
}

function renderSystemStatus(view: TextSetupSystemView, theme: SetupTheme): string {
  const lines = [theme.bold(resolveSetupMessage(view.title)), ""];
  for (const row of view.rows) {
    const status = colorStatus(statusLabel(row.status), row.status, theme);
    const detail = row.detail === undefined ? "" : ` ${row.detail}`;
    lines.push(`  ${status} ${resolveSetupMessage(row.label)}${detail}`);
  }
  if (view.hints.length > 0) {
    lines.push("", theme.bold(resolveSetupMessage(setupMessageRef("system.development-runtime"))));
    for (const hint of view.hints) {
      lines.push(`  ${resolveSetupMessage(hint.message)}`);
      if (hint.commands !== undefined) {
        lines.push(...hint.commands.map((command) => `    ${theme.cyan(formatCommand(command))}`));
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function bareLauncherConvenience(
  pathDirectory: string | undefined,
  launcherLink: SetupViewAction | undefined,
  theme: SetupTheme,
): string[] {
  if (pathDirectory === undefined && launcherLink === undefined) {
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
          directory: quoteShellPart(pathDirectory),
        }),
      )}`,
      `  ${resolveSetupMessage(setupMessageRef("completion.prefer-path"))}`,
    );
  }
  if (launcherLink !== undefined) {
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

function preparedHarnesses(view: ProjectSetupView): Array<{ id: string; label: string }> {
  const labels: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    opencode: "OpenCode",
    pi: "Pi",
  };
  return view.checks.flatMap((check) => {
    if (!check.id.startsWith("harness-tracking:")) return [];
    if (detailValue(check.details, "tracking-state") !== "prepared") return [];
    const id = check.id.slice("harness-tracking:".length);
    return [{ id, label: labels[id] ?? id }];
  });
}

function detailValue(
  details: readonly SetupDisplayDetail[],
  kind: SetupDisplayDetail["kind"],
): string | undefined {
  return details.find((detail) => detail.kind === kind)?.value;
}

function joinHumanList(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function statusLabel(status: SetupCheck["status"]): string {
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

export function formatSetupCommand(command: readonly string[]): string {
  return formatCommand(command);
}

function formatCommand(command: readonly string[]): string {
  return command.map(quoteCommandPart).join(" ");
}

function formatSelectedLauncherCommand(executable: string, args: readonly string[] = []): string {
  return [quoteShellPart(executable), ...args.map(quoteCommandPart)].join(" ");
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(part)) return part;
  return quoteShellPart(part);
}

function quoteShellPart(part: string): string {
  return `'${part.replaceAll("'", "'\\''")}'`;
}

function sectionHeading(label: string, theme: SetupTheme): string {
  return theme.bold(label);
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function visibleLength(value: string): number {
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
