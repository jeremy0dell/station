import { dirname } from "node:path";
import type {
  CliSetupAction,
  CliSetupCheck,
  CliSetupHarnessId,
  CliSetupPlan,
  SafeError,
} from "@station/contracts";
import { shellQuote } from "@station/runtime";
import type { SetupOperation, SetupPlan, SetupSessionOperationOutcome } from "@station/setup-core";
import {
  resolveSetupMessage,
  type SetupMessageRef,
  setupMessageRef,
} from "@station/setup-messages";
import type { SetupFacts } from "../adapters/inspectionTypes.js";
import { setupLauncherExecutable } from "../checks/launchers.js";
import { SETUP_HARNESS_DEFINITIONS } from "../harnessDefinitions.js";
import { resolveSetupHarnessInstallation } from "../harnessInstallation.js";
import { SETUP_TOOL_DEFINITIONS } from "../toolDefinitions.js";
import { type SetupLink, type SetupRenderOptions, type SetupTheme, setupTheme } from "./theme.js";

export type TextSetupPresenterOptions = SetupRenderOptions & {
  readonly write?: (chunk: string) => void | Promise<void>;
};

export type TextSetupProjection = {
  readonly plan: CliSetupPlan;
  readonly semanticPlan: SetupPlan;
  readonly facts: SetupFacts;
  readonly operationOutcomes: readonly SetupSessionOperationOutcome[];
};

export type TextSetupSystemRow = {
  readonly status: CliSetupCheck["status"];
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

type SetupProgressAction = { readonly label: string };

export type TextSetupPresenter = {
  readonly text: (ref: SetupMessageRef) => string;
  readonly prompt: (ref: SetupMessageRef) => string;
  readonly detail: (value: string) => string;
  readonly link: (input: SetupLink) => string;
  readonly write: (chunk: string) => Promise<void>;
  readonly writeMessage: (ref: SetupMessageRef) => Promise<void>;
  readonly renderPlan: (
    projection: TextSetupProjection,
    options?: { readonly skipSelectedActions?: boolean },
  ) => string;
  readonly renderApplyResult: (projection: TextSetupProjection) => string;
  readonly operationLabel: (projection: TextSetupProjection, operation: SetupOperation) => string;
  readonly operationReviewLabels: (
    projection: TextSetupProjection,
    operation: SetupOperation,
  ) => readonly string[];
  readonly operationHint: (projection: TextSetupProjection, operation: SetupOperation) => string;
  readonly renderProgressStart: (action: SetupProgressAction) => string;
  readonly renderProgressComplete: (action: SetupProgressAction) => string;
  readonly renderProgressFailure: (action: SetupProgressAction, error?: SafeError) => string;
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
 * Formats the canonical setup plan and semantic operation outcomes for terminal display.
 */
export function createTextSetupPresenter(
  options: TextSetupPresenterOptions = {},
): TextSetupPresenter {
  const theme = setupTheme(options);
  const writer = options.write ?? defaultWrite;
  const text = (ref: SetupMessageRef) => resolveSetupMessage(ref);
  return {
    text,
    prompt: (ref) => formatPrompt({ message: text(ref), theme }),
    detail: theme.dim,
    link: theme.link,
    async write(chunk) {
      await writer(chunk);
    },
    async writeMessage(ref) {
      await writer(`${text(ref)}\n`);
    },
    renderPlan: (projection, renderOptions) => renderPlan(projection, theme, renderOptions),
    renderApplyResult: (projection) => renderApplyResult(projection, theme),
    operationLabel: (projection, operation) => operationText(projection, operation).label,
    operationReviewLabels: (projection, operation) => operationReviewLabels(projection, operation),
    operationHint: (projection, operation) => operationText(projection, operation).explanation,
    renderProgressStart: (action) =>
      theme.bold(text(setupMessageRef("progress.start", { label: action.label }))),
    renderProgressComplete: (action) =>
      theme.green(text(setupMessageRef("progress.complete", { label: action.label }))),
    renderProgressFailure: (action, error) => renderProgressFailure(action.label, error, theme),
    renderInspectionFailure: (error) =>
      renderProgressFailure(text(setupMessageRef("label.setup-inspection")), error, theme),
    renderActivationStart: () => text(setupMessageRef("activation.start")),
    renderActivationComplete: () => theme.green(text(setupMessageRef("activation.complete"))),
    renderActivationFailure: (...args) => renderActivationFailure(args[0], args[1], theme),
    renderSystemStatus: (view) => renderSystemStatus(view, theme),
  };
}

/** Exact benchmark oracle for the single-plan terminal projection. */
export function projectSetupTextOutput(input: {
  readonly machinePlan: CliSetupPlan;
  readonly plan: SetupPlan;
  readonly facts: SetupFacts;
}): { plan: string; apply: string } {
  const projection: TextSetupProjection = {
    plan: input.machinePlan,
    semanticPlan: input.plan,
    facts: input.facts,
    operationOutcomes: [],
  };
  const presenter = createTextSetupPresenter();
  return {
    plan: presenter.renderPlan(projection),
    apply: presenter.renderApplyResult(projection),
  };
}

function formatPrompt(input: { readonly message: string; readonly theme: SetupTheme }): string {
  const [question = "", ...details] = input.message.split("\n");
  return [question, ...details.map(input.theme.dim)].join("\n");
}

function renderPlan(
  projection: TextSetupProjection,
  theme: SetupTheme,
  options: { readonly skipSelectedActions?: boolean } = {},
): string {
  const { plan } = projection;
  const lines = [
    theme.bold(
      theme.cyan(resolveSetupMessage(setupMessageRef("setup.heading", { mode: plan.mode }))),
    ),
    resolveSetupMessage(
      setupMessageRef("setup.selection-summary", { source: plan.summary.selectionSource }),
    ),
    "",
  ];
  const trackingChecks = plan.checks.filter((check) => check.id.startsWith("harness-tracking:"));
  for (const section of terminalSections) {
    if (!plan.checks.some((check) => check.tier === section.tier)) continue;
    lines.push(sectionHeading(resolveSetupMessage(section.heading), theme), "");
    let trackingRendered = section.tier !== "required";
    if (trackingRendered) {
      for (const tracking of trackingChecks) {
        if (tracking.tier === section.tier) appendCheck(lines, tracking, projection, theme);
      }
    }
    for (const check of plan.checks) {
      if (check.tier !== section.tier) continue;
      if (check.id === "config") {
        for (const tracking of trackingChecks) {
          if (tracking.tier === section.tier) {
            appendCheck(lines, tracking, projection, theme);
          }
        }
        trackingRendered = true;
      }
      if (!check.id.startsWith("harness-tracking:")) {
        appendCheck(lines, check, projection, theme);
      }
    }
    if (!trackingRendered && section.tier === "required") {
      for (const tracking of trackingChecks) {
        appendCheck(lines, tracking, projection, theme);
      }
    }
    lines.push("");
  }

  const hasSupplemental = projection.semanticPlan.operations.some(
    (operation) =>
      operation.kind === "install-harness" ||
      operation.kind === "install-homebrew" ||
      operation.kind === "install-xcode-command-line-tools",
  );
  if (plan.actions.length > 0 || hasSupplemental) {
    lines.push(sectionHeading(resolveSetupMessage(setupMessageRef("section.actions")), theme), "");
    const renderedActionIds = new Set<string>();
    for (const operation of projection.semanticPlan.operations) {
      if (
        operation.kind === "install-harness" ||
        operation.kind === "install-homebrew" ||
        operation.kind === "install-xcode-command-line-tools"
      ) {
        lines.push(
          ...renderOperation(operation, projection, theme, options.skipSelectedActions === true),
        );
        continue;
      }
      for (const id of actionIdsForOperation(operation)) {
        const action = plan.actions.find((candidate) => candidate.id === id);
        if (action === undefined) continue;
        renderedActionIds.add(id);
        lines.push(
          ...renderAction(action, projection, theme, options.skipSelectedActions === true),
        );
      }
    }
    for (const action of plan.actions) {
      if (!renderedActionIds.has(action.id)) {
        lines.push(
          ...renderAction(action, projection, theme, options.skipSelectedActions === true),
        );
      }
    }
    lines.push("");
  }

  const recovery = recoveryInstructions(projection);
  if (recovery.length > 0) {
    lines.push(sectionHeading(resolveSetupMessage(setupMessageRef("section.next")), theme), "");
    for (const instruction of recovery)
      lines.push(...renderRecoveryInstruction(instruction, theme));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function actionIdsForOperation(operation: SetupOperation): readonly string[] {
  switch (operation.kind) {
    case "install-tool":
      return [`install-${operation.tool}`];
    case "link-launchers":
      return ["link-station-launchers"];
    case "configure-worktrunk-shell":
      return ["worktrunk-shell-integration"];
    case "configure-tmux-popup":
      return [operation.scope === "persisted" ? "tmux-popup-binding" : "tmux-live-popup-binding"];
    case "prepare-worktrunk-tracking":
      return ["worktrunk-hooks"];
    case "prepare-harness-tracking":
      return [`${operation.harnessId}-hooks`];
    case "write-config":
      return ["mkdir-config-dir", operation.change === "create" ? "write-config" : "update-config"];
    case "install-harness":
    case "install-homebrew":
    case "install-xcode-command-line-tools":
    case "activate-observer-config":
      return [];
  }
}

function renderApplyResult(projection: TextSetupProjection, theme: SetupTheme): string {
  if (
    projection.operationOutcomes.some(
      (outcome) => outcome.operation.kind === "write-config" && outcome.status === "failed",
    )
  ) {
    return `${theme.bold(theme.red(resolveSetupMessage(setupMessageRef("guided.config-write-failed"))))}\n`;
  }
  if (projection.semanticPlan.result.readiness.workflowReady) {
    return renderSuccessfulApply(projection, theme);
  }
  if (projection.plan.summary.selectionSource === "unresolved") {
    const harness = requiredCheck(projection, "harness");
    return renderRecoveryBlock(
      humanCheckMessage(harness, projection),
      resolveSetupMessage(setupMessageRef("recovery.selection-command")),
      [["stn", "--config", projection.facts.configPath, "setup"]],
      theme,
    );
  }
  if (projection.facts.git.status === "missing") {
    return `${theme.bold(theme.red(humanCheckMessage(requiredCheck(projection, "git-project"), projection)))}\n`;
  }
  const missingTracking = projection.semanticPlan.evidence.harnessTracking.find(
    (tracking) =>
      projection.semanticPlan.selection.outcome === "selected" &&
      projection.semanticPlan.selection.requiredHarnessIds.includes(tracking.harnessId) &&
      tracking.assessment.state !== "prepared" &&
      tracking.assessment.state !== "not-applicable",
  );
  if (missingTracking !== undefined) {
    const check = requiredCheck(projection, `harness-tracking:${missingTracking.harnessId}`);
    return renderRecoveryBlock(
      humanCheckMessage(check, projection),
      resolveSetupMessage(setupMessageRef("recovery.tracking")),
      [harnessTrackingCommand(projection.facts, missingTracking.harnessId)],
      theme,
    );
  }
  const missing = projection.plan.checks.find(
    (check) => check.tier === "required" && check.status === "missing",
  );
  if (missing === undefined) {
    return renderRecoveryBlock(
      resolveSetupMessage(setupMessageRef("recovery.core-incomplete")),
      resolveSetupMessage(setupMessageRef("recovery.then-run")),
      [["stn", "setup", "check"]],
      theme,
    );
  }
  return renderRecoveryBlock(
    missingRecoveryTitle(missing, projection),
    resolveSetupMessage(setupMessageRef("recovery.then-run")),
    recoveryCommands(projection.facts),
    theme,
  );
}

function renderSuccessfulApply(projection: TextSetupProjection, theme: SetupTheme): string {
  const preparedHarnesses = projection.semanticPlan.evidence.harnessTracking.flatMap((tracking) => {
    if (tracking.assessment.state !== "prepared") return [];
    const harness = projection.facts.harnesses.find(
      (candidate) => candidate.id === tracking.harnessId,
    );
    return harness === undefined ? [] : [harness.label];
  });
  const tracking =
    preparedHarnesses.length === 0
      ? ""
      : ` ${resolveSetupMessage(
          setupMessageRef("completion.tracking", { harnesses: joinHumanList(preparedHarnesses) }),
        )}`;
  const lines = [
    theme.bold(
      theme.green(`${resolveSetupMessage(setupMessageRef("completion.core"))}${tracking}`),
    ),
  ];
  if (
    projection.semanticPlan.evidence.harnessTracking.some(
      (tracking) => tracking.harnessId === "codex" && tracking.assessment.state === "prepared",
    )
  ) {
    lines.push("", resolveSetupMessage(setupMessageRef("completion.codex-review")));
  }

  const launcher = projection.plan.checks.find(
    (check) => check.id === "station-launchers" && check.status === "warn",
  );
  const stationExecutable = setupLauncherExecutable(projection.facts.launchers.station);
  const linkAction = projection.plan.actions.find(
    (action) => action.id === "link-station-launchers",
  );
  const pathDirectory = launcherPathDirectory(projection.facts);
  const linkCommand =
    linkAction === undefined
      ? undefined
      : (["bun", "run", "--cwd", projection.facts.launchers.packageRoot, "station:link"] as const);
  if (launcher !== undefined) {
    lines.push(
      "",
      sectionHeading(resolveSetupMessage(setupMessageRef("section.remaining")), theme),
      "",
    );
    appendCheck(lines, launcher, projection, theme);
    if (linkAction !== undefined && linkCommand !== undefined) {
      lines.push(...renderAction(linkAction, projection, theme, false));
      lines.push(`           ${theme.cyan(`Run: ${formatSetupCommand(linkCommand)}`)}`);
    }
    if (pathDirectory !== undefined) {
      lines.push(
        "",
        theme.bold(resolveSetupMessage(setupMessageRef("completion.current-shell-path-title"))),
        `  ${theme.cyan(`PATH=${shellQuote(pathDirectory, true)}\${PATH:+":$PATH"}`)}`,
        `  ${theme.cyan("export PATH")}`,
        `  ${theme.cyan("hash -r")}`,
      );
    }
    lines.push(...bareLauncherConvenience(pathDirectory, linkCommand, theme));
  }
  const command =
    launcher === undefined ? projection.facts.launchers.station.command : stationExecutable;
  lines.push("", sectionHeading(resolveSetupMessage(setupMessageRef("section.next")), theme), "");
  lines.push(
    ...[[command, "doctor"], [command]].map(
      (next) =>
        `  ${theme.cyan(launcher === undefined ? formatSetupCommand(next) : formatSelectedLauncherCommand(next))}`,
    ),
    "",
  );
  return lines.join("\n");
}

function appendCheck(
  lines: string[],
  check: CliSetupCheck,
  projection: TextSetupProjection,
  theme: SetupTheme,
): void {
  const status = colorStatus(statusLabel(check.status), check.status, theme);
  lines.push(
    `  ${pad(status, statusColumnWidth)} ${pad(humanCheckLabel(check), labelColumnWidth)} ${humanCheckMessage(check, projection)}`,
  );
  if (check.details === undefined || check.id.startsWith("harness-tracking:")) return;
  if (check.id === "tmux-popup-binding") {
    appendDetail(lines, "Binding", check.details.bindingKey, theme);
    return;
  }
  if (check.id === "config") {
    appendDetail(lines, "Path", check.details.path, theme);
    appendDetail(lines, "Default agent", check.details.harness, theme);
    return;
  }
  for (const key in check.details) {
    const label = humanDetailLabels[key];
    if (label !== undefined) appendDetail(lines, label, check.details[key], theme);
  }
}

function appendDetail(
  lines: string[],
  label: string,
  value: string | undefined,
  theme: SetupTheme,
): void {
  if (value !== undefined && value.length > 0) {
    lines.push(`           ${theme.dim(`${label}: ${value}`)}`);
  }
}

function humanCheckLabel(check: CliSetupCheck): string {
  return check.id === "observer-socket-evidence" ? "Observer socket recovery" : check.label;
}

function humanCheckMessage(check: CliSetupCheck, projection: TextSetupProjection): string {
  if (check.id === "state-dir" && check.status === "ok") {
    return "Station’s state directory is writable.";
  }
  if (check.id === "git-project" && check.status === "ok") {
    return "Git is available; choose a project explicitly in STATION.";
  }
  if (check.id === "harness" && check.status === "ok") {
    const selected = projection.plan.summary.selectedHarness ?? "Agent";
    if (projection.plan.summary.selectionSource === "configured") {
      return `${selected} remains the configured default agent CLI.`;
    }
  }
  if (check.id === "tmux-popup-binding" && check.status === "ok") {
    return "The tmux popup binding is installed.";
  }
  if (check.id === "worktrunk-hooks" && check.status === "skipped") {
    return "Available after Worktrunk is installed.";
  }
  if (check.id === "doctor") {
    return "Run stn doctor after setup to validate the Observer runtime.";
  }
  return check.message.replaceAll("harness CLI", "agent CLI");
}

function renderAction(
  action: CliSetupAction,
  projection: TextSetupProjection,
  theme: SetupTheme,
  skipSelected: boolean,
): string[] {
  const status = actionStatus(action.selected, action.status, skipSelected, theme);
  const text = humanActionText(action, projection);
  return [
    `  ${pad(status, statusColumnWidth)} ${pad(text.label, labelColumnWidth)} ${text.explanation}`,
  ];
}

function renderOperation(
  operation: SetupOperation,
  projection: TextSetupProjection,
  theme: SetupTheme,
  skipSelected: boolean,
): string[] {
  const outcome = projection.operationOutcomes.find(
    (candidate) => candidate.operationId === operation.id,
  );
  const status = actionStatus(operation.selected, outcome?.status, skipSelected, theme);
  const text = operationText(projection, operation);
  return [
    `  ${pad(status, statusColumnWidth)} ${pad(text.label, labelColumnWidth)} ${text.explanation}`,
  ];
}

function actionStatus(
  selected: boolean,
  outcome: CliSetupAction["status"] | SetupSessionOperationOutcome["status"] | undefined,
  skipSelected: boolean,
  theme: SetupTheme,
): string {
  const skipped = skipSelected
    ? selected
    : outcome === "skipped" || (outcome === undefined && !selected);
  return skipped
    ? theme.dim(resolveSetupMessage(setupMessageRef("action.skipped")))
    : theme.cyan(resolveSetupMessage(setupMessageRef("action.selected")));
}

function humanActionText(
  action: CliSetupAction,
  _projection: TextSetupProjection,
): { label: string; explanation: string } {
  if (action.id === "link-station-launchers") {
    return {
      label: resolveSetupMessage(setupMessageRef("action.link-launchers-label")),
      explanation: resolveSetupMessage(setupMessageRef("action.link-launchers-message")),
    };
  }
  if (action.id === "worktrunk-hooks") {
    return {
      label: "Prepare Worktrunk tracking",
      explanation: "Prepare Worktrunk lifecycle hooks that report worktree changes to Station.",
    };
  }
  return { label: action.label, explanation: action.message };
}

function operationReviewLabels(
  projection: TextSetupProjection,
  operation: SetupOperation,
): readonly string[] {
  const labels = actionIdsForOperation(operation).flatMap((id) => {
    const action = projection.plan.actions.find((candidate) => candidate.id === id);
    return action === undefined ? [] : [humanActionText(action, projection).label];
  });
  return labels.length === 0 ? [operationText(projection, operation).label] : labels;
}

function operationText(
  projection: TextSetupProjection,
  operation: SetupOperation,
): { label: string; explanation: string } {
  switch (operation.kind) {
    case "install-tool": {
      const definition = SETUP_TOOL_DEFINITIONS[operation.tool];
      return {
        label: `Install ${resolveSetupMessage(definition.label)}`,
        explanation:
          projection.facts.brew.status === "ok"
            ? `${definition.displayName} will be installed with Homebrew.`
            : `Install ${definition.displayName} manually with the ${definition.formula} formula.`,
      };
    }
    case "install-harness": {
      const harness = projection.facts.harnesses.find(
        (candidate) => candidate.id === operation.harnessId,
      );
      const label = harness?.label ?? operation.harnessId;
      const installation = resolveSetupHarnessInstallation({
        harnessId: operation.harnessId,
        brewAvailable: projection.facts.brew.status === "ok",
        homeDir: projection.facts.homeDir,
        macos: projection.facts.xcode.applicable,
      });
      return { label: `Install ${label}`, explanation: resolveSetupMessage(installation.message) };
    }
    case "install-homebrew":
      return {
        label: "Install Homebrew",
        explanation: resolveSetupMessage(setupMessageRef("installer.homebrew")),
      };
    case "install-xcode-command-line-tools":
      return {
        label: "Install Command Line Tools",
        explanation: resolveSetupMessage(setupMessageRef("installer.command-line-tools")),
      };
    case "link-launchers":
      return {
        label: resolveSetupMessage(setupMessageRef("action.link-launchers-label")),
        explanation: resolveSetupMessage(setupMessageRef("action.link-launchers-message")),
      };
    case "configure-worktrunk-shell":
      return {
        label: resolveSetupMessage(setupMessageRef("action.worktrunk-shell-label")),
        explanation: resolveSetupMessage(setupMessageRef("action.worktrunk-shell-message")),
      };
    case "configure-tmux-popup": {
      const persisted = operation.scope === "persisted";
      const binding = projection.facts.tmuxBinding;
      const key = binding.status === "conflict" ? "Space" : binding.bindingKey;
      return {
        label: resolveSetupMessage(
          setupMessageRef(persisted ? "action.tmux-persist-label" : "action.tmux-live-label"),
        ),
        explanation: resolveSetupMessage(
          setupMessageRef(persisted ? "action.tmux-persist-message" : "action.tmux-live-message", {
            key,
          }),
        ),
      };
    }
    case "prepare-worktrunk-tracking":
      return {
        label: resolveSetupMessage(setupMessageRef("action.worktrunk-hooks-label")),
        explanation: resolveSetupMessage(setupMessageRef("action.worktrunk-hooks-message")),
      };
    case "prepare-harness-tracking": {
      const harness = projection.facts.harnesses.find(
        (candidate) => candidate.id === operation.harnessId,
      );
      const label = harness?.label ?? operation.harnessId;
      return {
        label: resolveSetupMessage(
          setupMessageRef("action.harness-tracking-label", { harness: label }),
        ),
        explanation: resolveSetupMessage(
          setupMessageRef("action.harness-tracking-message", { harness: label }),
        ),
      };
    }
    case "write-config": {
      const creating = operation.change === "create";
      return {
        label: resolveSetupMessage(
          setupMessageRef(creating ? "action.config-create-label" : "action.config-update-label"),
        ),
        explanation: resolveSetupMessage(
          setupMessageRef(
            creating ? "action.config-create-message" : "action.config-update-message",
          ),
        ),
      };
    }
    case "activate-observer-config":
      return {
        label: resolveSetupMessage(setupMessageRef("label.observer-activation")),
        explanation: "Activate the Observer with the prepared config.",
      };
  }
}

type RecoveryInstruction =
  | { readonly kind: "command"; readonly command: readonly string[] }
  | {
      readonly kind: "instruction";
      readonly message: string;
      readonly command?: readonly string[];
    };

function recoveryInstructions(projection: TextSetupProjection): readonly RecoveryInstruction[] {
  const { facts, plan } = projection;
  if (plan.summary.requiredMissing === 0) {
    return [
      { kind: "command", command: [facts.launchers.station.command, "doctor"] },
      { kind: "command", command: [facts.launchers.station.command] },
    ];
  }
  if (facts.stateDir.status === "missing") {
    return [{ kind: "instruction", message: facts.stateDir.message }];
  }
  if (facts.xcode.status === "missing") {
    return [{ kind: "instruction", message: facts.xcode.message }];
  }
  if (facts.worktrunk.status === "missing") {
    return [
      { kind: "instruction", message: "Install Worktrunk.", command: ["stn", "setup", "check"] },
    ];
  }
  if (facts.tmux.status === "missing") {
    return [{ kind: "instruction", message: "Install tmux.", command: ["stn", "setup", "check"] }];
  }
  if (facts.bun.status === "missing") {
    return [
      {
        kind: "instruction",
        message: "Install Bun (brew install bun).",
        command: ["stn", "setup", "check"],
      },
    ];
  }
  if (facts.git.status === "missing") {
    return [{ kind: "instruction", message: facts.git.message }];
  }
  if (facts.diffViewer.status === "missing") {
    return [
      {
        kind: "instruction",
        message: "Install Hunk (brew install hunk).",
        command: ["stn", "setup", "check"],
      },
    ];
  }
  return [
    {
      kind: "instruction",
      message: "Resolve the missing required setup items.",
      command: ["stn", "setup", "check"],
    },
  ];
}

function renderRecoveryInstruction(instruction: RecoveryInstruction, theme: SetupTheme): string[] {
  if (instruction.kind === "command") {
    return [`  ${theme.cyan(formatSetupCommand(instruction.command))}`];
  }
  const lines = [`  ${instruction.message}`];
  if (instruction.command !== undefined) {
    lines.push(`    ${theme.cyan(formatSetupCommand(instruction.command))}`);
  }
  return lines;
}

function renderRecoveryBlock(
  title: string,
  detail: string,
  commands: readonly (readonly string[])[],
  theme: SetupTheme,
): string {
  return [
    theme.bold(theme.red(title)),
    detail,
    ...commands.map((command) => `  ${theme.cyan(formatSetupCommand(command))}`),
    "",
  ].join("\n");
}

function requiredCheck(projection: TextSetupProjection, id: string): CliSetupCheck {
  const check = projection.plan.checks.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`Setup plan is missing ${id}.`);
  return check;
}

function missingRecoveryTitle(check: CliSetupCheck, projection: TextSetupProjection): string {
  if (check.id === "command-line-tools") return "Command Line Tools are still missing.";
  if (check.id === "worktrunk") return "Worktrunk is still missing.";
  if (check.id === "tmux") return "tmux is still missing.";
  if (check.id === "bun") return "Bun is still missing; bare stn needs it to render the TUI.";
  if (check.id === "diff-viewer") return "Hunk is still missing.";
  return humanCheckMessage(check, projection);
}

function recoveryCommands(facts: SetupFacts): readonly (readonly string[])[] {
  if (facts.stateDir.status === "missing" || facts.xcode.status === "missing") return [];
  return [["stn", "setup", "check"]];
}

function harnessTrackingCommand(facts: SetupFacts, harnessId: CliSetupHarnessId): string[] {
  const command = [
    setupLauncherExecutable(facts.launchers.station),
    "--config",
    facts.configPath,
    "hooks",
    "install",
    harnessId,
    "--yes",
  ];
  if (SETUP_HARNESS_DEFINITIONS[harnessId].providerHook?.supportsHookBin === true) {
    command.push("--hook-bin", setupLauncherExecutable(facts.launchers.ingress));
  }
  return command;
}

function launcherPathDirectory(facts: SetupFacts): string | undefined {
  const station = setupLauncherExecutable(facts.launchers.station);
  const directory = dirname(station);
  const siblings = [
    setupLauncherExecutable(facts.launchers.ingress),
    setupLauncherExecutable(facts.launchers.tmuxPopup),
  ];
  return facts.launchers.station.source === "installed" &&
    facts.launchers.ingress.source === "installed" &&
    facts.launchers.tmuxPopup.source === "installed" &&
    siblings.every((sibling) => dirname(sibling) === directory)
    ? directory
    : undefined;
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
        setupMessageRef("progress.failed-evidence", { message: error.message, code: error.code }),
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

function statusLabel(status: CliSetupCheck["status"]): string {
  switch (status) {
    case "ok":
      return resolveSetupMessage(setupMessageRef("status.ok"));
    case "missing":
      return resolveSetupMessage(setupMessageRef("status.missing"));
    case "warn":
      return resolveSetupMessage(setupMessageRef("status.warning"));
    case "skipped":
      return resolveSetupMessage(setupMessageRef("status.skipped"));
  }
}

function colorStatus(label: string, status: CliSetupCheck["status"], theme: SetupTheme): string {
  switch (status) {
    case "ok":
      return theme.green(label);
    case "missing":
      return theme.red(label);
    case "warn":
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
  return [shellQuote(executable, true), ...args.map((arg) => shellQuote(arg))].join(" ");
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
const terminalSections = [
  { tier: "required" as const, heading: setupMessageRef("section.core") },
  { tier: "recommended" as const, heading: setupMessageRef("section.recommended") },
  { tier: "optional" as const, heading: setupMessageRef("section.later") },
];
const humanDetailLabels: Readonly<Record<string, string>> = {
  path: "Path",
  version: "Version",
  resolvedPath: "Found at",
  root: "Repository",
  defaultBranch: "Default branch",
  default: "Default agent",
  enabled: "Enabled agents",
  station: "Station",
  ingress: "Ingress",
  tmuxPopup: "tmux popup",
  shell: "Shell",
  rcPath: "Shell config",
  bindingKey: "Binding",
  automationMode: "Worktrunk automation",
  flag: "Worktrunk option",
};
