import { applySetupPlan } from "../apply.js";
import { planSetupConfigWrite } from "../configWriter.js";
import {
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
import { isSupportedHarnessId, selectSetupHarness } from "../harnessSelection.js";
import { defaultPrompt, renderOptions, write } from "../io.js";
import type { SetupAction, SetupFacts } from "../model.js";
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
  await write(deps, "Core setup: Worktrunk + tmux + one agent + first project.\n\n");
  let facts = await collectForCommand("apply", options, deps, {});
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
      applyOptions(deps, {
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
    facts = await collectForCommand("apply", options, deps, {});
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
  if (availableHarnesses.length > 1) {
    const selected = await prompt.select(
      "Select the agent CLI to enable.",
      availableHarnesses.map((harness) => ({ value: harness.id, label: harness.label })),
    );
    if (isSupportedHarnessId(selected)) {
      facts = { ...facts, selectedHarness: selected };
    }
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
  if (configActions.length > 0) {
    const accepted = await prompt.confirm("Write STATION project config?");
    if (!accepted) {
      await write(deps, "Config was not written.\n");
      return { code: 1 };
    }
    const writeResult = await applySetupPlan(
      plan,
      applyOptions(deps, { actionFilter: isConfigAction, announceActions: true }),
    );
    if (writeResult.failedAction !== undefined) {
      await write(deps, "Config write failed. Run: station setup plan\n");
      return { code: 1 };
    }
  }

  const hookActions = plan.actions.filter(isHookSetupAction).filter((action) => action.selected);
  if (hookActions.length > 0) {
    const hookResult = await applySetupPlan(
      plan,
      applyOptions(deps, {
        actionFilter: isHookSetupAction,
        announceActions: true,
        showCommandOutput: true,
      }),
    );
    if (hookResult.failedAction !== undefined) {
      await write(deps, "Hook install failed. Fix the install error, then run: station setup\n");
      return { code: 1 };
    }
  }

  const shellIntegration = plan.actions.find(
    (action) => action.id === "worktrunk-shell-integration",
  );
  if (shellIntegration !== undefined) {
    const accepted = await prompt.confirm("Install Worktrunk shell integration?");
    if (accepted) {
      await applySetupPlan(
        { ...plan, actions: [{ ...shellIntegration, selected: true }] },
        applyOptions(deps, { announceActions: true, showCommandOutput: true }),
      );
    }
  }

  const tmuxPopupBindingActions = plan.actions.filter(isTmuxPopupBindingAction);
  if (tmuxPopupBindingActions.length > 0) {
    const accepted = await prompt.confirm("Install or load tmux popup binding?");
    if (accepted) {
      await applySetupPlan(
        {
          ...plan,
          actions: tmuxPopupBindingActions.map((action) => ({ ...action, selected: true })),
        },
        applyOptions(deps, { announceActions: true, showCommandOutput: true }),
      );
    }
  }

  await write(
    deps,
    renderSetupApplyResult(
      { ...plan, summary: { ...plan.summary, requiredOk: true } },
      renderOptions(deps),
    ),
  );
  return { code: 0 };
}

type HookPreferences = {
  installWorktrunkHooks?: boolean;
  installHarnessHooks?: boolean;
};

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

  return collectForCommand("apply", options, deps, {});
}

async function promptHookPreferences(
  facts: SetupFacts,
  prompt: SetupPromptAdapter,
): Promise<HookPreferences> {
  const preferences: HookPreferences = {};
  const selectedHarness = selectSetupHarness(facts.harnesses, facts.selectedHarness);
  if (facts.config.status === "missing" && facts.worktrunk.status === "ok") {
    preferences.installWorktrunkHooks = await prompt.confirm("Install Worktrunk lifecycle hooks?");
  }
  if (
    selectedHarness !== undefined &&
    harnessSupportsHooks(selectedHarness.id) &&
    canWriteHarnessHookFlag(facts, selectedHarness.id)
  ) {
    preferences.installHarnessHooks = await prompt.confirm(
      `Install ${selectedHarness.label} agent hooks?`,
    );
  }
  return preferences;
}

function canWriteHarnessHookFlag(facts: SetupFacts, harnessId: string): boolean {
  return (
    facts.config.status === "missing" ||
    (facts.config.status === "valid" && !facts.config.configuredHarnesses.includes(harnessId))
  );
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
        "  station setup",
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
    await write(deps, "Agent CLI install failed. Fix the install error, then run: station setup\n");
    return undefined;
  }

  const refreshedFacts = await collectForCommand(
    "apply",
    options,
    depsWithUserBinPath(deps, facts),
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
      "  station setup",
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

function prependPath(path: string, existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return path;
  }
  return existing.split(":").includes(path) ? existing : `${path}:${existing}`;
}
