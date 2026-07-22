import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { applySetupPlan } from "../apply.js";
import { checkSetupTmuxBinding } from "../checks/tmuxBinding.js";
import { planSetupConfigWrite } from "../configWriter.js";
import {
  activateCompletedConfigWrite,
  applyOptions,
  collectForCommand,
  coreReadyForConfigWrite,
  isConfigAction,
  isHookSetupAction,
  isInstallAction,
  isTmuxPopupBindingAction,
  markRequiredIncomplete,
} from "../flowUtils.js";
import {
  harnessInstallPlan,
  isHarnessInstallAction,
  missingHarnessInstallActions,
} from "../harnessInstall.js";
import { isSupportedHarnessId, selectSetupHarnesses } from "../harnessSelection.js";
import { defaultPrompt, renderOptions, write } from "../io.js";
import type { SetupAction, SetupFacts, SetupPlan, SupportedHarnessId } from "../model.js";
import { buildSetupPlan } from "../planner.js";
import { formatCommand, renderSetupApplyResult, renderSetupPlan } from "../render.js";
import type {
  SetupCommandDeps,
  SetupCommandOptions,
  SetupCommandResult,
  SetupPromptAdapter,
} from "../types.js";

export async function runGuidedSetup(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<SetupCommandResult> {
  const prompt = deps.prompt ?? defaultPrompt();
  try {
    return await runGuidedSetupWithPrompt(options, deps, prompt);
  } finally {
    await prompt.close?.();
  }
}

async function runGuidedSetupWithPrompt(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
): Promise<SetupCommandResult> {
  await write(
    deps,
    "Core setup: required tools and one or more agents. Add your first project in STATION.\n\n",
  );
  let facts = await collectForCommand("apply", options, deps, {});

  // Bootstrap layer (macOS): Command Line Tools, then Homebrew — the prerequisites
  // for git and every brew-installed tool below. Resolving these can change what is
  // installable, so it runs before the plan is built.
  const bootstrap = await ensureBootstrapTools(facts, options, deps, prompt);
  if (bootstrap.halt) return { code: 1 };
  if (bootstrap.facts !== undefined) facts = bootstrap.facts;

  let plan = buildSetupPlan(facts, { configWrite: await planSetupConfigWrite(facts) });
  await write(deps, renderSetupPlan(plan, renderOptions(deps)));

  const installActions = plan.actions.filter(isInstallAction).filter((action) => action.selected);
  if (installActions.length > 0) {
    const accepted = await prompt.confirm("Install missing required tools?");
    if (!accepted) {
      await write(deps, "No changes made.\n");
      return { code: 1 };
    }
    const installResult = await applySetupPlan(
      plan,
      // brew lives in the brew prefix, which the current PATH usually lacks right
      // after a fresh install; run the installs with it prepended.
      applyOptions(depsWithBrewBinPath(deps), {
        actionFilter: isInstallAction,
        announceActions: true,
        showCommandOutput: true,
      }),
    );
    if (installResult.failedAction !== undefined) {
      await write(
        deps,
        renderSetupApplyResult(markRequiredIncomplete(installResult.plan), renderOptions(deps)),
      );
      return { code: 1 };
    }
    // Brew installs land in the brew prefix, which is typically not on the current
    // PATH; re-probe with it prepended so the freshly installed tools are detected.
    facts = await collectForCommand("apply", options, depsWithBrewBinPath(deps), {});
  }

  const harnessFacts = await ensureHarnessAvailable(options, deps, prompt, facts);
  if (harnessFacts === undefined) {
    return { code: 1 };
  }
  facts = harnessFacts;

  const availableHarnesses = facts.harnesses.filter((harness) => harness.status === "ok");
  if (availableHarnesses.length === 0) {
    const noHarnessPlan = buildSetupPlan(facts);
    await write(deps, renderSetupApplyResult(noHarnessPlan, renderOptions(deps)));
    return { code: 1 };
  }
  let selectedHarnesses: SupportedHarnessId[];
  if (availableHarnesses.length > 1) {
    const choices = availableHarnesses.map((harness) => ({
      value: harness.id,
      label: harness.label,
    }));
    const selected =
      prompt.selectMany === undefined
        ? [await prompt.select("Select the agent CLI to enable.", choices)]
        : await prompt.selectMany(
            "Select agent CLIs to enable (comma-separated; first is the default for new configs).",
            choices,
          );
    selectedHarnesses = selected.filter(isSupportedHarnessId);
  } else {
    selectedHarnesses = availableHarnesses.map((harness) => harness.id);
  }
  const configuredDefault =
    facts.config.status === "valid" && isSupportedHarnessId(facts.config.defaults.harness)
      ? facts.config.defaults.harness
      : undefined;
  const defaultHarness = configuredDefault ?? selectedHarnesses[0];
  if (defaultHarness !== undefined) {
    facts = {
      ...facts,
      selectedHarness: defaultHarness,
      selectedHarnesses,
    };
  }

  facts = await maybeLinkStationLaunchers(facts, options, deps, prompt);

  const hookPreferences = await promptHookPreferences(facts, prompt);
  const configWrite = await planSetupConfigWrite(facts, hookPreferences);
  plan = buildSetupPlan(facts, { configWrite, ...hookPreferences });
  if (!coreReadyForConfigWrite(plan)) {
    await write(deps, renderSetupApplyResult(plan, renderOptions(deps)));
    return { code: 1 };
  }

  const configActions = plan.actions.filter(isConfigAction).filter((action) => action.selected);
  let writtenPlan: SetupPlan | undefined;
  if (configActions.length > 0) {
    const accepted = await prompt.confirm("Write core STATION config?");
    if (!accepted) {
      await write(deps, "Config was not written.\n");
      return { code: 1 };
    }
    const writeResult = await applySetupPlan(
      plan,
      applyOptions(deps, { actionFilter: isConfigAction, announceActions: true }),
    );
    if (writeResult.failedAction !== undefined) {
      await write(deps, "Config write failed. Run: stn setup plan\n");
      return { code: 1 };
    }
    writtenPlan = writeResult.plan;
  }

  const hookActions = plan.actions.filter(isHookSetupAction).filter((action) => action.selected);
  let hookInstallFailed = false;
  // Hook providers are independent; one failed installer must not suppress the rest.
  for (const action of hookActions) {
    const hookResult = await applySetupPlan(
      { ...plan, actions: [action] },
      applyOptions(deps, {
        announceActions: true,
        showCommandOutput: true,
      }),
    );
    if (hookResult.failedAction !== undefined) {
      hookInstallFailed = true;
    }
  }
  if (hookInstallFailed) {
    await write(deps, "Hook install failed. Fix the install error, then run: stn setup\n");
  }

  const activationError =
    writtenPlan === undefined
      ? undefined
      : await activateCompletedConfigWrite(writtenPlan, facts.homeDir, deps);
  if (hookInstallFailed || activationError !== undefined) {
    return { code: 1 };
  }

  let tmuxPopupFacts = facts;
  let tmuxPopupPlan = plan;
  if (writtenPlan !== undefined) {
    tmuxPopupFacts = await collectForCommand("apply", options, depsWithBrewBinPath(deps), {});
    tmuxPopupPlan = buildSetupPlan(tmuxPopupFacts);
  }

  const shellIntegration = plan.actions.find(
    (action) => action.id === "worktrunk-shell-integration",
  );
  if (shellIntegration !== undefined) {
    const accepted = await prompt.confirm("Install Worktrunk shell integration?");
    if (accepted) {
      await installWorktrunkShellIntegration(shellIntegration, plan, facts, options, deps);
    }
  }

  const tmuxPopupBindingActions = tmuxPopupPlan.actions.filter(isTmuxPopupBindingAction);
  const popupCommand = formatCommand([tmuxPopupFacts.launchers.station.command, "popup"]);
  const bindingKey =
    tmuxPopupFacts.tmuxBinding.status === "conflict"
      ? undefined
      : tmuxPopupFacts.tmuxBinding.bindingKey;
  let tmuxPopupFeedback =
    tmuxPopupFacts.tmuxBinding.status === "ok"
      ? renderTmuxPopupFeedback(
          true,
          tmuxPopupFacts.tmuxBinding.liveStatus === "loaded",
          tmuxPopupFacts.tmuxBinding.bindingKey,
          popupCommand,
        )
      : undefined;
  if (tmuxPopupBindingActions.length > 0 && bindingKey !== undefined) {
    const accepted = await prompt.confirm("Install or load tmux popup binding?");
    if (accepted) {
      const bindingResult = await applySetupPlan(
        {
          ...tmuxPopupPlan,
          actions: tmuxPopupBindingActions.map((action) => ({ ...action, selected: true })),
        },
        applyOptions(deps, { announceActions: true, showCommandOutput: true }),
      );
      const completed = new Set(
        bindingResult.plan.actions
          .filter((action) => action.status === "completed")
          .map((action) => action.id),
      );
      let liveLoaded = tmuxPopupFacts.tmuxBinding.liveStatus === "loaded";
      if (completed.has("tmux-live-popup-binding")) {
        const recheckOptions: Parameters<typeof checkSetupTmuxBinding>[0] = {
          homeDir: tmuxPopupFacts.homeDir,
          launcherCommand: tmuxPopupFacts.tmuxBinding.launcherCommand,
          runShellCommand: tmuxPopupFacts.tmuxBinding.runShellCommand,
          tmuxCommand: tmuxPopupFacts.tmux.resolvedPath ?? tmuxPopupFacts.tmux.command,
        };
        const env = deps.env ?? options.env;
        if (env !== undefined) recheckOptions.env = env;
        if (deps.fs !== undefined) recheckOptions.fs = deps.fs;
        if (deps.runner !== undefined) recheckOptions.runner = deps.runner;
        liveLoaded = (await checkSetupTmuxBinding(recheckOptions)).liveStatus === "loaded";
      }
      tmuxPopupFeedback = renderTmuxPopupFeedback(
        tmuxPopupFacts.tmuxBinding.status === "ok" || completed.has("tmux-popup-binding"),
        liveLoaded,
        bindingKey,
        popupCommand,
        bindingResult.failedAction !== undefined,
      );
    } else {
      tmuxPopupFeedback =
        tmuxPopupFacts.tmuxBinding.status === "ok"
          ? renderTmuxPopupFeedback(
              true,
              tmuxPopupFacts.tmuxBinding.liveStatus === "loaded",
              tmuxPopupFacts.tmuxBinding.bindingKey,
              popupCommand,
            )
          : `Tmux popup binding was not changed. Direct fallback: ${popupCommand}\n`;
    }
  }

  if (tmuxPopupFeedback !== undefined) {
    await write(deps, tmuxPopupFeedback);
  }

  await write(
    deps,
    renderSetupApplyResult(
      { ...plan, summary: { ...plan.summary, workflowReady: true, requiredOk: true } },
      renderOptions(deps),
    ),
  );
  return { code: 0 };
}

async function installWorktrunkShellIntegration(
  action: SetupAction,
  plan: SetupPlan,
  facts: SetupFacts,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
): Promise<void> {
  const baseCommand = action.command;
  if (baseCommand === undefined) return;

  const shellRc = activeShellRc(facts.homeDir, (deps.env ?? options.env ?? process.env).SHELL);
  const command = shellRc === undefined ? baseCommand : [...baseCommand, shellRc.shell];
  if (shellRc !== undefined && !(await pathExists(shellRc.path, deps))) {
    await write(
      deps,
      [
        "Optional Worktrunk shell integration was not installed; core setup is complete.",
        `Active ${shellRc.shell} rc file not found: ${shellRc.path}`,
        `Run: ${formatCommand(["touch", shellRc.path])} && ${formatCommand(command)}`,
        "",
      ].join("\n"),
    );
    return;
  }

  const shellApplyOptions =
    applyOptions(deps, { announceActions: true, showCommandOutput: true }) ?? {};
  shellApplyOptions.onActionFailed = () => undefined;
  const result = await applySetupPlan(
    { ...plan, actions: [{ ...action, command, selected: true }] },
    shellApplyOptions,
  );
  if (result.failedAction !== undefined) {
    await write(
      deps,
      `Optional Worktrunk shell integration was not installed; core setup is complete.\nRun: ${formatCommand(command)}\n`,
    );
  }
}

function activeShellRc(
  homeDir: string,
  shellCommand: string | undefined,
): { shell: "bash" | "zsh"; path: string } | undefined {
  const shell = basename(shellCommand ?? "");
  if (shell !== "bash" && shell !== "zsh") return undefined;
  return { shell, path: join(homeDir, shell === "bash" ? ".bashrc" : ".zshrc") };
}

async function pathExists(path: string, deps: SetupCommandDeps): Promise<boolean> {
  try {
    await (deps.fs?.access ?? access)(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    // Let Worktrunk surface other rc errors through the optional action-failure path.
    return true;
  }
}

function renderTmuxPopupFeedback(
  persisted: boolean,
  liveLoaded: boolean,
  bindingKey: string,
  popupCommand: string,
  repairIncomplete = false,
): string {
  const lines = persisted
    ? [
        `Tmux popup binding: tmux prefix + ${bindingKey} is ${
          liveLoaded
            ? "persisted and loaded in the current tmux server"
            : "persisted for future tmux servers; no current server was live-loaded"
        }.`,
      ]
    : ["Tmux popup binding was not persisted. Run stn setup to retry."];
  if (repairIncomplete) {
    lines.push("Tmux popup binding repair was incomplete; run stn setup to retry.");
  }
  lines.push(`Direct fallback: ${popupCommand}`);
  return `${lines.join("\n")}\n`;
}

type HookPreferences = {
  installWorktrunkHooks?: boolean;
  installHarnessHooks?: readonly SupportedHarnessId[];
};

// Kicks the macOS bootstrap installers (Command Line Tools, then Homebrew) behind
// explicit prompts. Both need a TTY (a GUI dialog / a sudo password), so this path
// is guided-only — `setup apply --yes` stays guidance-only for these.
async function ensureBootstrapTools(
  facts: SetupFacts,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
): Promise<{ halt?: boolean; facts?: SetupFacts }> {
  if (facts.xcode.status === "missing") {
    const accepted = await prompt.confirm(
      "Install Xcode Command Line Tools now? (runs xcode-select --install)",
    );
    if (accepted) {
      await applySetupPlan(
        harnessInstallPlan(facts, [commandLineToolsInstallAction()]),
        applyOptions(deps, { announceActions: true, showCommandOutput: true }),
      );
      // The CLT installer runs asynchronously in its own window; we cannot continue
      // until it finishes, so stop here and have the user re-run.
      await write(
        deps,
        "Command Line Tools installation started in a separate window. Finish it, then run: stn setup\n",
      );
    } else {
      await write(
        deps,
        "Install the Command Line Tools (xcode-select --install), then run: stn setup\n",
      );
    }
    return { halt: true };
  }

  if (facts.brew.status === "missing" && coreToolsNeedBrew(facts)) {
    const accepted = await prompt.confirm(
      "Install Homebrew now? (runs the official Homebrew installer)",
    );
    if (!accepted) {
      await write(deps, brewMissingCallout(facts));
      return {};
    }
    const result = await applySetupPlan(
      harnessInstallPlan(facts, [homebrewInstallAction()]),
      applyOptions(deps, { announceActions: true, showCommandOutput: true }),
    );
    if (result.failedAction !== undefined) {
      await write(
        deps,
        "Homebrew install failed. Install it from https://brew.sh, then run: stn setup\n",
      );
      return { halt: true };
    }
    // Re-probe with the brew prefix on PATH so the just-installed brew (and the
    // core tools it can now install) are detected in the main plan.
    return { facts: await collectForCommand("apply", options, depsWithBrewBinPath(deps), {}) };
  }

  return {};
}

function commandLineToolsInstallAction(): SetupAction {
  return {
    id: "install-command-line-tools",
    kind: "run-command",
    tier: "required",
    selected: true,
    label: "Install Command Line Tools",
    message: "Trigger the macOS Command Line Tools installer.",
    command: ["xcode-select", "--install"],
  };
}

function homebrewInstallAction(): SetupAction {
  return {
    id: "install-homebrew",
    kind: "run-command",
    tier: "required",
    selected: true,
    label: "Install Homebrew",
    message: "Run the official Homebrew installer.",
    command: [
      "/bin/bash",
      "-c",
      "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)",
    ],
  };
}

function coreToolsNeedBrew(facts: SetupFacts): boolean {
  return (
    facts.worktrunk.status !== "ok" ||
    facts.tmux.status !== "ok" ||
    facts.bun.status !== "ok" ||
    facts.diffnav.status !== "ok" ||
    facts.gitDelta.status !== "ok"
  );
}

function brewMissingCallout(facts: SetupFacts): string {
  const lines = [
    "Homebrew is required to install the missing core tools.",
    "  Install Homebrew first: https://brew.sh",
  ];
  // facts.xcode.applicable is true only on macOS, where brew itself needs the CLT.
  if (facts.xcode.applicable) {
    lines.push("  Command Line Tools: xcode-select --install");
  }
  return `${lines.join("\n")}\n\n`;
}

async function maybeLinkStationLaunchers(
  facts: SetupFacts,
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
): Promise<SetupFacts> {
  const plan = buildSetupPlan(facts, { configWrite: await planSetupConfigWrite(facts) });
  const action = plan.actions.find((candidate) => candidate.id === "link-station-launchers");
  if (action === undefined || !shouldPromptLauncherLink(facts)) return facts;

  const accepted = await prompt.confirm("Link STATION launchers globally?");
  if (!accepted) return facts;

  const result = await applySetupPlan(
    { ...plan, actions: [{ ...action, selected: true }] },
    applyOptions(deps, { announceActions: true, showCommandOutput: true }),
  );
  if (result.failedAction !== undefined) {
    await write(deps, "STATION launcher link failed. Continuing with checkout launcher paths.\n");
    return facts;
  }

  // Brew prefix here too: this result overwrites facts, so a brew-less re-probe would
  // drop the core tools installed earlier this session on a fresh Mac.
  return collectForCommand("apply", options, depsWithBrewBinPath(deps), {});
}

async function promptHookPreferences(
  facts: SetupFacts,
  prompt: SetupPromptAdapter,
): Promise<HookPreferences> {
  const preferences: HookPreferences = {};
  const selectedHarnesses = selectSetupHarnesses(
    facts.harnesses,
    facts.selectedHarnesses,
    facts.selectedHarness,
  );
  if (
    facts.worktrunk.status === "ok" &&
    (facts.config.status === "missing" ||
      (facts.config.status === "valid" && facts.config.worktrunkUseLifecycleHooks === true))
  ) {
    preferences.installWorktrunkHooks = await prompt.confirm("Install Worktrunk lifecycle hooks?");
  }
  const installHarnessHooks: SupportedHarnessId[] = [];
  for (const harness of selectedHarnesses) {
    if (!harnessSupportsHooks(harness.id) || !canInstallHarnessHooks(facts)) {
      continue;
    }
    if (await prompt.confirm(`Install ${harness.label} agent hooks?`)) {
      installHarnessHooks.push(harness.id);
    }
  }
  if (installHarnessHooks.length > 0) {
    preferences.installHarnessHooks = installHarnessHooks;
  }
  return preferences;
}

function canInstallHarnessHooks(facts: SetupFacts): boolean {
  return facts.config.status === "missing" || facts.config.status === "valid";
}

function harnessSupportsHooks(harness: string): boolean {
  return (
    harness === "claude" || harness === "codex" || harness === "cursor" || harness === "opencode"
  );
}

function shouldPromptLauncherLink(facts: SetupFacts): boolean {
  return [facts.launchers.station, facts.launchers.ingress, facts.launchers.tmuxPopup].some(
    (launcher) => launcher.source === "checkout",
  );
}

async function ensureHarnessAvailable(
  options: SetupCommandOptions,
  deps: SetupCommandDeps,
  prompt: SetupPromptAdapter,
  facts: SetupFacts,
): Promise<SetupFacts | undefined> {
  if (facts.harnesses.some((harness) => harness.status === "ok")) {
    return facts;
  }

  await write(
    deps,
    [
      "",
      "No supported agent CLI is available.",
      "STATION needs one agent CLI. You can install one or more now.",
      "",
    ].join("\n"),
  );

  const selectedActions: SetupAction[] = [];
  for (const action of missingHarnessInstallActions(facts.harnesses)) {
    const command = action.command === undefined ? action.label : formatCommand(action.command);
    const accepted = await prompt.confirm(`${action.label}? (${command})`);
    if (accepted) {
      selectedActions.push({ ...action, selected: true });
    }
  }

  if (selectedActions.length === 0) {
    await write(
      deps,
      [
        "No agent CLI was installed.",
        "Install one supported agent CLI, then run:",
        "  stn setup",
        "",
      ].join("\n"),
    );
    return undefined;
  }

  const result = await applySetupPlan(
    harnessInstallPlan(facts, selectedActions),
    applyOptions(deps, {
      actionFilter: isHarnessInstallAction,
      announceActions: true,
      showCommandOutput: true,
    }),
  );
  if (result.failedAction !== undefined) {
    await write(deps, "Agent CLI install failed. Fix the install error, then run: stn setup\n");
    return undefined;
  }

  // Compose both prefixes: the agent CLI lands in ~/.local/bin, but the core tools
  // installed earlier this session live in the brew prefix — without it they re-read
  // as missing and overwrite the good facts, dead-ending config write on a fresh Mac.
  const refreshedFacts = await collectForCommand(
    "apply",
    options,
    depsWithBrewBinPath(depsWithUserBinPath(deps, facts)),
    {},
  );
  if (refreshedFacts.harnesses.some((harness) => harness.status === "ok")) {
    return refreshedFacts;
  }

  await write(
    deps,
    [
      "No supported agent CLI was detected after install.",
      "Make sure the installed CLI is on PATH, then run:",
      "  stn setup",
      "",
    ].join("\n"),
  );
  return undefined;
}

function depsWithUserBinPath(deps: SetupCommandDeps, facts: SetupFacts): SetupCommandDeps {
  const env = { ...(deps.env ?? process.env) };
  env.PATH = prependPath(`${facts.homeDir}/.local/bin`, env.PATH);
  return { ...deps, env };
}

// Standard Homebrew prefix bin dirs: Apple Silicon, Intel, and Linuxbrew. A fresh
// shell or GUI-launched process usually has none of these on PATH right after the
// installer runs, so a re-probe would not see brew or the tools it just installed.
const brewBinDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];

// Make the brew prefixes resolvable for re-probes that follow `brew install`. Without
// this, a fresh Apple-Silicon Mac reports brew (and every brew-installed core tool)
// still missing right after a successful install, and the guided run exits 1.
// APPEND (not prepend): the caller's existing PATH keeps precedence, so we only add a
// fallback for tools that were just installed and aren't already resolvable elsewhere
// — this avoids shadowing the caller's chosen tools with brew's copies.
function depsWithBrewBinPath(deps: SetupCommandDeps): SetupCommandDeps {
  const env = { ...(deps.env ?? process.env) };
  env.PATH = brewBinDirs.reduce((path, dir) => appendPath(path, dir), env.PATH);
  return { ...deps, env };
}

function prependPath(path: string, existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return path;
  }
  return existing.split(":").includes(path) ? existing : `${path}:${existing}`;
}

function appendPath(existing: string | undefined, path: string): string {
  if (existing === undefined || existing.length === 0) {
    return path;
  }
  return existing.split(":").includes(path) ? existing : `${existing}:${path}`;
}
