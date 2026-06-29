import { tmuxPopupBindingBlock, tmuxPopupBindingEndMarker } from "./checks/tmuxBinding.js";
import { selectSetupHarness } from "./harnessSelection.js";
import type {
  ConfigWritePlan,
  SetupAction,
  SetupCheck,
  SetupFacts,
  SetupHarnessFact,
  SetupPlan,
  SupportedHarnessId,
} from "./model.js";
import { SetupPlanSchema } from "./model.js";

export type BuildSetupPlanOptions = {
  configWrite?: ConfigWritePlan;
  installWorktrunkHooks?: boolean;
  installHarnessHooks?: boolean;
};

export function buildSetupPlan(facts: SetupFacts, options: BuildSetupPlanOptions = {}): SetupPlan {
  const selectedHarness = selectSetupHarness(facts.harnesses, facts.selectedHarness);
  const checks = setupChecks(facts, selectedHarness?.id);
  const actions = setupActions(facts, selectedHarness, options.configWrite, options);
  const requiredMissing = checks.filter(
    (check) => check.tier === "required" && check.status !== "ok",
  ).length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  const summary = {
    requiredOk: checks.every((check) => check.tier !== "required" || check.status === "ok"),
    requiredMissing,
    warnings,
    selectedActions: actions.filter((action) => action.selected).length,
    configPath: facts.configPath,
    ...(selectedHarness === undefined ? {} : { selectedHarness: selectedHarness.id }),
  };
  const plan = {
    generatedAt: facts.generatedAt,
    mode: facts.mode,
    checks,
    actions,
    summary,
    nextSteps: nextSteps(requiredMissing, facts),
  };
  return SetupPlanSchema.parse(plan);
}

function setupChecks(
  facts: SetupFacts,
  selectedHarness: SupportedHarnessId | undefined,
): SetupCheck[] {
  return [
    dependencyCheck({
      id: "worktrunk",
      label: "Worktrunk / wt",
      missingMessage: facts.worktrunk.message ?? "Worktrunk is required for core worktree setup.",
      dependency: facts.worktrunk,
    }),
    dependencyCheck({
      id: "tmux",
      label: "tmux",
      missingMessage: facts.tmux.message ?? "tmux is required for the reference terminal workflow.",
      dependency: facts.tmux,
    }),
    gitCheck(facts),
    harnessCheck(facts, selectedHarness),
    configCheck(facts),
    ...configDiagnosticsChecks(facts),
    launcherCheck(facts),
    {
      id: "worktrunk-shell-integration",
      tier: "recommended",
      status: facts.worktrunk.status === "ok" ? "warning" : "skipped",
      label: "Worktrunk shell integration",
      message:
        facts.worktrunk.status === "ok"
          ? "Recommended after core setup: wt config shell install."
          : "Skipped until Worktrunk is available.",
    },
    {
      id: "tmux-popup-binding",
      tier: "recommended",
      status:
        facts.tmux.status === "ok"
          ? facts.tmuxBinding.status === "ok"
            ? "ok"
            : "warning"
          : "skipped",
      label: "tmux popup binding",
      message:
        facts.tmux.status === "ok"
          ? facts.tmuxBinding.status === "ok"
            ? "tmux popup binding is installed."
            : "Recommended: add Ctrl-b Space binding for the STATION popup dashboard."
          : "Skipped until tmux is available.",
      details: { path: facts.tmuxBinding.path },
    },
    worktrunkHooksCheck(facts),
    harnessHooksCheck(facts, selectedHarness),
    diffnavCheck(facts),
    gitDeltaCheck(facts),
    {
      id: "doctor",
      tier: "recommended",
      status: "warning",
      label: "stn doctor",
      message: "Run station doctor after setup to validate the observer runtime.",
    },
  ];
}

function launcherCheck(facts: SetupFacts): SetupCheck {
  const launchers = [facts.launchers.station, facts.launchers.ingress, facts.launchers.tmuxPopup];
  const missing = launchers.filter((launcher) => launcher.status === "missing");
  const checkout = launchers.filter((launcher) => launcher.source === "checkout");
  const details = {
    station: facts.launchers.station.command,
    ingress: facts.launchers.ingress.command,
    tmuxPopup: facts.launchers.tmuxPopup.command,
  };
  if (missing.length > 0) {
    return {
      id: "station-launchers",
      tier: "recommended",
      status: "warning",
      label: "STATION launchers",
      message: `Some STATION launchers are missing: ${missing.map((launcher) => launcher.command).join(", ")}.`,
      details,
    };
  }
  if (checkout.length > 0) {
    return {
      id: "station-launchers",
      tier: "recommended",
      status: "warning",
      label: "STATION launchers",
      message:
        "Bare station launchers are not on PATH; setup will use current-checkout launcher paths.",
      details,
    };
  }
  return {
    id: "station-launchers",
    tier: "recommended",
    status: "ok",
    label: "STATION launchers",
    message: "station, stn-ingress, and stn-tmux-popup are available on PATH.",
    details,
  };
}

function worktrunkHooksCheck(facts: SetupFacts): SetupCheck {
  if (facts.worktrunk.status !== "ok") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: "skipped",
      label: "Worktrunk hooks",
      message: "Skipped until Worktrunk is available.",
    };
  }
  if (facts.config.status !== "valid") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: "warning",
      label: "Worktrunk hooks",
      message: "Recommended: install Worktrunk lifecycle hooks during setup.",
    };
  }
  if (facts.worktrunkAutomation.status !== "skipped") {
    return {
      id: "worktrunk-hooks",
      tier: "recommended",
      status: facts.worktrunkAutomation.status,
      label: "Worktrunk hooks",
      message: facts.worktrunkAutomation.message,
      details: worktrunkAutomationDetails(facts.worktrunkAutomation),
    };
  }
  return {
    id: "worktrunk-hooks",
    tier: "recommended",
    status: "ok",
    label: "Worktrunk hooks",
    message: "Lifecycle hook automation uses Worktrunk defaults; no prompt flags are configured.",
    details: { automationMode: "worktrunk-default" },
  };
}

function worktrunkAutomationDetails(
  automation: SetupFacts["worktrunkAutomation"],
): Record<string, string> {
  const details: Record<string, string> = {
    automationMode: automation.automationMode,
  };
  if (automation.flag !== undefined) details.flag = automation.flag;
  if (automation.missingSubcommands !== undefined && automation.missingSubcommands.length > 0) {
    details.missingSubcommands = automation.missingSubcommands.join(", ");
  }
  return details;
}

function harnessHooksCheck(
  facts: SetupFacts,
  selectedHarness: SupportedHarnessId | undefined,
): SetupCheck {
  if (selectedHarness === undefined || !harnessSupportsHooks(selectedHarness)) {
    return {
      id: "harness-hooks",
      tier: "recommended",
      status: "skipped",
      label: "Agent hooks",
      message: "Selected agent does not have guided hook setup.",
    };
  }
  if (facts.config.status !== "valid") {
    return {
      id: "harness-hooks",
      tier: "recommended",
      status: "warning",
      label: "Agent hooks",
      message: `Recommended: install ${selectedHarness} hooks during setup.`,
    };
  }
  if (facts.config.configuredHookHarnesses.includes(selectedHarness)) {
    return {
      id: "harness-hooks",
      tier: "recommended",
      status: "ok",
      label: "Agent hooks",
      message: `${selectedHarness} hooks are requested; station doctor verifies installed files.`,
    };
  }
  return {
    id: "harness-hooks",
    tier: "recommended",
    status: "warning",
    label: "Agent hooks",
    message: `${selectedHarness} hooks are not enabled in STATION config.`,
  };
}

function dependencyCheck(input: {
  id: string;
  label: string;
  missingMessage: string;
  dependency: SetupFacts["worktrunk"];
}): SetupCheck {
  const details: Record<string, string> = { command: input.dependency.command };
  if (input.dependency.version !== undefined) details.version = input.dependency.version;
  if (input.dependency.resolvedPath !== undefined) {
    details.resolvedPath = input.dependency.resolvedPath;
  }
  return {
    id: input.id,
    tier: "required",
    status: input.dependency.status === "ok" ? "ok" : "missing",
    label: input.label,
    message:
      input.dependency.status === "ok" ? `${input.label} is available.` : input.missingMessage,
    details,
  };
}

function diffnavCheck(facts: SetupFacts): SetupCheck {
  const details: Record<string, string> = { command: facts.diffnav.command };
  if (facts.diffnav.resolvedPath !== undefined) details.resolvedPath = facts.diffnav.resolvedPath;
  if (facts.diffnav.status === "ok") {
    return {
      id: "diffnav",
      tier: "optional",
      status: "ok",
      label: "diffnav",
      message: "diffnav is available for the station 'See diff (split right)' automation.",
      details,
    };
  }
  return {
    id: "diffnav",
    tier: "optional",
    status: "warning",
    label: "diffnav",
    message:
      facts.diffnav.message ??
      "Optional: install diffnav for the station 'See diff (split right)' automation.",
    details,
  };
}

function gitDeltaCheck(facts: SetupFacts): SetupCheck {
  const details: Record<string, string> = { command: facts.gitDelta.command };
  if (facts.gitDelta.resolvedPath !== undefined) details.resolvedPath = facts.gitDelta.resolvedPath;
  if (facts.gitDelta.status === "ok") {
    return {
      id: "git-delta",
      tier: "optional",
      status: "ok",
      label: "git-delta",
      message:
        "git-delta is available; diffnav renders the station 'See diff' automation through it.",
      details,
    };
  }
  return {
    id: "git-delta",
    tier: "optional",
    status: "warning",
    label: "git-delta",
    message:
      facts.gitDelta.message ??
      "Optional: install git-delta; diffnav renders the station 'See diff' automation through it.",
    details,
  };
}

function gitCheck(facts: SetupFacts): SetupCheck {
  if (facts.git.status === "ok") {
    return {
      id: "git-project",
      tier: "required",
      status: "ok",
      label: "Git project",
      message: "Current directory is inside a git repository.",
      details: {
        root: facts.git.root,
        defaultBranch: facts.git.defaultBranch,
      },
    };
  }
  return {
    id: "git-project",
    tier: "required",
    status: "missing",
    label: "Git project",
    message: facts.git.message,
    details: {
      defaultBranch: facts.git.defaultBranch,
    },
  };
}

function harnessCheck(
  facts: SetupFacts,
  selectedHarness: SupportedHarnessId | undefined,
): SetupCheck {
  const available = facts.harnesses.filter((harness) => harness.status === "ok");
  if (available.length === 0) {
    return {
      id: "harness",
      tier: "required",
      status: "missing",
      label: "Agent CLI",
      message: "Install one supported harness CLI: claude, codex, cursor agent, opencode, or pi.",
    };
  }
  const selected = available.find((harness) => harness.id === selectedHarness) ?? available[0];
  const details: Record<string, string> = {
    available: available.map((harness) => harness.id).join(","),
  };
  if (selected !== undefined) {
    details.selected = selected.id;
    details.command = selected.command;
  }
  return {
    id: "harness",
    tier: "required",
    status: "ok",
    label: "Agent CLI",
    message:
      selected === undefined
        ? "A supported harness CLI is available."
        : `${selected.label} is selected for first-run config.`,
    details,
  };
}

function configCheck(facts: SetupFacts): SetupCheck {
  if (facts.config.status === "missing") {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: "STATION project config",
      message: facts.config.message,
      details: { path: facts.config.path },
    };
  }
  if (facts.config.status === "invalid") {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: "STATION project config",
      message: facts.config.message,
      details: { path: facts.config.path },
    };
  }
  const supportedHarnesses = new Set(
    facts.harnesses.filter((harness) => harness.status === "ok").map((harness) => harness.id),
  );
  if (!facts.config.hasProjectForRoot) {
    const defaultCoreProblem = defaultConfigCoreProblem(facts.config, supportedHarnesses);
    if (defaultCoreProblem !== undefined) {
      return {
        id: "config",
        tier: "required",
        status: "missing",
        label: "STATION project config",
        message: defaultCoreProblem,
        details: {
          path: facts.config.path,
          worktreeProvider: facts.config.defaults.worktreeProvider,
          terminal: facts.config.defaults.terminal,
          harness: facts.config.defaults.harness,
        },
      };
    }
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: "STATION project config",
      message: "Config exists but does not include the current git repository.",
      details: { path: facts.config.path },
    };
  }
  const project = facts.config.matchedProject;
  if (project === undefined) {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: "STATION project config",
      message: "Config includes the current git repository, but setup could not inspect it.",
      details: { path: facts.config.path },
    };
  }
  const projectCoreProblem = projectConfigCoreProblem(project, supportedHarnesses);
  if (projectCoreProblem !== undefined) {
    return {
      id: "config",
      tier: "required",
      status: "missing",
      label: "STATION project config",
      message: projectCoreProblem,
      details: {
        path: facts.config.path,
        project: project.id,
        worktreeProvider: project.worktreeProvider,
        terminal: project.terminal,
        harness: project.harness,
      },
    };
  }
  return {
    id: "config",
    tier: "required",
    status: "ok",
    label: "STATION project config",
    message: "Config includes the current git repository.",
    details: { path: facts.config.path },
  };
}

function configDiagnosticsChecks(facts: SetupFacts): SetupCheck[] {
  if (facts.config.status !== "valid") {
    return [];
  }
  const diagnostics = facts.config.diagnostics ?? [];
  if (diagnostics.length === 0) {
    return [];
  }
  const details: Record<string, string> = { path: facts.config.path };
  if (facts.config.matchedProject !== undefined) {
    details.project = facts.config.matchedProject.id;
  }
  return [
    {
      id: "config-diagnostics",
      tier: "recommended",
      status: "warning",
      label: "STATION config diagnostics",
      message: `Config loaded with ${diagnostics.length} diagnostic(s): ${diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
      details,
    },
  ];
}

function defaultConfigCoreProblem(
  config: Extract<SetupFacts["config"], { status: "valid" }>,
  supportedHarnesses: ReadonlySet<string>,
): string | undefined {
  if (config.defaults.worktreeProvider !== "worktrunk") {
    return `Config defaults use worktree provider ${config.defaults.worktreeProvider}; set defaults.worktree_provider to "worktrunk" before setup can append this project safely.`;
  }
  if (config.defaults.terminal !== "tmux") {
    return `Config defaults use terminal ${config.defaults.terminal}; set defaults.terminal to "tmux" before setup can append this project safely.`;
  }
  if (!supportedHarnesses.has(config.defaults.harness)) {
    return `Config defaults use harness ${config.defaults.harness}, but setup did not detect that supported harness CLI.`;
  }
  return undefined;
}

function projectConfigCoreProblem(
  project: NonNullable<Extract<SetupFacts["config"], { status: "valid" }>["matchedProject"]>,
  supportedHarnesses: ReadonlySet<string>,
): string | undefined {
  if (project.worktreeProvider !== "worktrunk") {
    return `Project ${project.id} uses worktree provider ${project.worktreeProvider}; set the effective provider to "worktrunk" for the setup core path.`;
  }
  if (!project.worktrunkEnabled) {
    return `Project ${project.id} disables Worktrunk; enable project Worktrunk config for the setup core path.`;
  }
  if (project.terminal !== "tmux") {
    return `Project ${project.id} uses terminal ${project.terminal}; set the effective terminal to "tmux" for the setup core path.`;
  }
  if (!supportedHarnesses.has(project.harness)) {
    return `Project ${project.id} uses harness ${project.harness}, but setup did not detect that supported harness CLI.`;
  }
  return undefined;
}

function setupActions(
  facts: SetupFacts,
  selectedHarness: SetupHarnessFact | undefined,
  configWrite: ConfigWritePlan | undefined,
  options: BuildSetupPlanOptions,
): SetupAction[] {
  const actions: SetupAction[] = [];
  if (facts.worktrunk.status === "missing") {
    actions.push(installAction("install-worktrunk", "Worktrunk", "worktrunk", facts.brew));
  }
  if (facts.tmux.status === "missing") {
    actions.push(installAction("install-tmux", "tmux", "tmux", facts.brew));
  }
  if (facts.diffnav.status === "missing") {
    actions.push(
      optionalInstallAction("install-diffnav", "diffnav", "dlvhdr/formulae/diffnav", facts.brew),
    );
  }
  // delta is diffnav's renderer, not standalone-useful here; install it alongside
  // so opting into diffnav never yields a diffnav that errors for a missing delta.
  if (facts.gitDelta.status === "missing") {
    actions.push(optionalInstallAction("install-git-delta", "git-delta", "git-delta", facts.brew));
  }
  if (stationLaunchersNeedLink(facts)) {
    actions.push({
      id: "link-station-launchers",
      kind: "run-command",
      tier: "recommended",
      selected: false,
      label: "Link STATION launchers",
      message: "Link station, stn-ingress, and stn-tmux-popup globally for bare terminal commands.",
      command: ["pnpm", "--dir", facts.launchers.packageRoot, "link", "--global"],
    });
  }
  actions.push({
    id: "worktrunk-shell-integration",
    kind: "run-command",
    tier: "recommended",
    selected: false,
    label: "Install Worktrunk shell integration",
    message: "Run wt config shell install after core setup if you want Worktrunk shell helpers.",
    command: [facts.worktrunk.command, "-y", "config", "shell", "install"],
  });
  if (facts.tmux.status === "ok" && facts.tmuxBinding.status === "missing") {
    actions.push({
      id: "tmux-popup-binding",
      kind: "append-file",
      tier: "recommended",
      selected: false,
      label: "Install tmux popup binding",
      message: "Append a Ctrl-b Space binding for the STATION popup dashboard to ~/.tmux.conf.",
      path: facts.tmuxBinding.path,
      data: {
        marker: facts.tmuxBinding.marker,
        endMarker: tmuxPopupBindingEndMarker,
        appendedText: tmuxPopupBindingBlock(facts.tmuxBinding.launcherCommand),
      },
    });
  }
  if (
    facts.tmux.status === "ok" &&
    facts.tmuxBinding.insideTmux &&
    facts.tmuxBinding.liveStatus !== "loaded"
  ) {
    actions.push({
      id: "tmux-live-popup-binding",
      kind: "run-command",
      tier: "recommended",
      selected: false,
      label: "Load tmux popup binding",
      message: "Install the Ctrl-b Space STATION popup binding in the current tmux server.",
      command: [
        facts.tmux.command,
        "bind-key",
        "Space",
        "run-shell",
        "-b",
        facts.tmuxBinding.runShellCommand,
      ],
    });
  }

  actions.push(...hookSetupActions(facts, selectedHarness, options));

  const configActions = configWriteActions(facts, selectedHarness, configWrite);
  actions.push(...configActions);
  return actions;
}

function stationLaunchersNeedLink(facts: SetupFacts): boolean {
  return [facts.launchers.station, facts.launchers.ingress, facts.launchers.tmuxPopup].some(
    (launcher) => launcher.source !== "path",
  );
}

function hookSetupActions(
  facts: SetupFacts,
  selectedHarness: SetupHarnessFact | undefined,
  options: BuildSetupPlanOptions,
): SetupAction[] {
  if (facts.launchers.station.status !== "ok" || facts.launchers.ingress.status !== "ok") {
    return [];
  }
  const actions: SetupAction[] = [];
  if (facts.worktrunk.status === "ok") {
    actions.push({
      id: "worktrunk-hooks",
      kind: "run-command",
      tier: "recommended",
      selected: options.installWorktrunkHooks === true,
      label: "Install Worktrunk hooks",
      message: "Install Worktrunk lifecycle hooks that report worktree changes to STATION.",
      command: [
        facts.launchers.station.command,
        "--config",
        facts.configPath,
        "hooks",
        "install",
        "worktrunk",
        "--yes",
        "--hook-bin",
        facts.launchers.ingress.command,
      ],
      data: { setupRole: "hook" },
    });
  }
  if (selectedHarness !== undefined && harnessSupportsHooks(selectedHarness.id)) {
    actions.push({
      id: `${selectedHarness.id}-hooks`,
      kind: "run-command",
      tier: "recommended",
      selected: options.installHarnessHooks === true,
      label: `Install ${selectedHarness.label} hooks`,
      message: `Install ${selectedHarness.label} hooks that report agent activity to STATION.`,
      command: harnessHookInstallCommand(facts, selectedHarness.id),
      data: { setupRole: "hook", harness: selectedHarness.id },
    });
  }
  return actions;
}

function harnessHookInstallCommand(facts: SetupFacts, harness: SupportedHarnessId): string[] {
  const command = [
    facts.launchers.station.command,
    "--config",
    facts.configPath,
    "hooks",
    "install",
    harness,
    "--yes",
  ];
  if (harness === "claude" || harness === "codex" || harness === "cursor") {
    command.push("--hook-bin", facts.launchers.ingress.command);
  }
  return command;
}

function harnessSupportsHooks(
  harness: string,
): harness is "claude" | "codex" | "cursor" | "opencode" {
  return (
    harness === "claude" || harness === "codex" || harness === "cursor" || harness === "opencode"
  );
}

function installAction(
  id: string,
  label: string,
  formula: string,
  brew: SetupFacts["brew"],
): SetupAction {
  const action: SetupAction = {
    id,
    kind: brew.status === "ok" ? "brew-install" : "noop",
    tier: "required",
    selected: brew.status === "ok",
    label: `Install ${label}`,
    message:
      brew.status === "ok"
        ? `Install ${label} with Homebrew.`
        : `Homebrew is unavailable; install ${label} manually with: brew install ${formula}`,
    command: ["brew", "install", formula],
    data: { formula },
  };
  return action;
}

function optionalInstallAction(
  id: string,
  label: string,
  formula: string,
  brew: SetupFacts["brew"],
): SetupAction {
  return {
    id,
    kind: brew.status === "ok" ? "brew-install" : "noop",
    tier: "optional",
    selected: false,
    label: `Install ${label}`,
    message:
      brew.status === "ok"
        ? `Optional: install ${label} with Homebrew for the station 'See diff' automation.`
        : `Homebrew is unavailable; install ${label} manually with: brew install ${formula}`,
    command: ["brew", "install", formula],
    data: { formula },
  };
}

function configWriteActions(
  facts: SetupFacts,
  selectedHarness: SetupHarnessFact | undefined,
  configWrite: ConfigWritePlan | undefined,
): SetupAction[] {
  if (selectedHarness === undefined || facts.git.status !== "ok") {
    return [];
  }
  if (configWrite === undefined || configWrite.operation === "none") {
    return [];
  }
  if (configWrite.operation === "blocked") {
    return [
      {
        id: "config-blocked",
        kind: "noop",
        tier: "required",
        selected: false,
        label: "Update STATION config",
        message: configWrite.reason,
        path: configWrite.path,
      },
    ];
  }
  const mkdirAction: SetupAction = {
    id: "mkdir-config-dir",
    kind: "mkdir",
    tier: "required",
    selected: true,
    label: "Create config directory",
    message: "Create the parent directory for the STATION config file.",
    path: configWrite.path,
  };
  const writeAction: SetupAction = {
    id: configWrite.operation === "create" ? "write-config" : "append-config",
    kind: "write-config",
    tier: "required",
    selected: true,
    label: configWrite.operation === "create" ? "Write STATION config" : "Append STATION config",
    message:
      configWrite.operation === "create"
        ? "Create the core STATION config for this repository."
        : "Append safe missing setup blocks to the existing STATION config.",
    path: configWrite.path,
    data: {
      operation: configWrite.operation,
      content: configWrite.content,
      ...(configWrite.operation === "append" ? { appendedText: configWrite.appendedText } : {}),
      ...(configWrite.backupPath === undefined ? {} : { backupPath: configWrite.backupPath }),
    },
  };
  return [mkdirAction, writeAction];
}

function nextSteps(requiredMissing: number, facts: SetupFacts): string[] {
  if (requiredMissing === 0) {
    const stationCommand = quoteCommandPart(facts.launchers.station.command);
    return [`${stationCommand} doctor`, stationCommand];
  }
  if (facts.worktrunk.status === "missing") {
    return ["Install Worktrunk, then run: station setup check"];
  }
  if (facts.tmux.status === "missing") {
    return ["Install tmux, then run: station setup check"];
  }
  if (facts.git.status === "missing") {
    return ["Run station setup from inside the git repository you want to manage."];
  }
  return ["Resolve the missing required setup items, then run: station setup check"];
}

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(part)) {
    return part;
  }
  return `'${part.replaceAll("'", "'\\''")}'`;
}
