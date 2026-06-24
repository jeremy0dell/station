import { fileURLToPath } from "node:url";
import type { BuildHarnessLaunchRequest, HarnessLaunchPlan } from "@station/contracts";

export type ScriptedLaunchOptions = {
  nodeCommand?: string;
  runnerPath?: string;
  stateDir: string;
  scenarioPath?: string;
  runId?: string;
  sessionId?: string;
};

export function buildScriptedAgentLaunchPlan(
  request: BuildHarnessLaunchRequest,
  options: ScriptedLaunchOptions,
): HarnessLaunchPlan {
  const runId = options.runId ?? `run_${request.project.id}_${request.worktree.id}`;
  const sessionId = request.sessionId ?? options.sessionId;
  const runnerPath = options.runnerPath ?? defaultRunnerPath();
  const args = [
    runnerPath,
    "--run-id",
    runId,
    "--state-dir",
    options.stateDir,
    ...(options.scenarioPath === undefined ? [] : ["--scenario", options.scenarioPath]),
  ];
  const env = {
    STATION_PROJECT_ID: request.project.id,
    STATION_WORKTREE_ID: request.worktree.id,
    STATION_WORKTREE_PATH: request.worktree.path,
    STATION_HARNESS_PROVIDER: "scripted",
    STATION_SCRIPTED_RUN_ID: runId,
    STATION_SCRIPTED_STATE_DIR: options.stateDir,
    ...(sessionId === undefined ? {} : { STATION_SESSION_ID: sessionId }),
  };

  return {
    provider: "scripted",
    command: options.nodeCommand ?? process.execPath,
    args,
    cwd: request.worktree.path,
    env,
    mode: request.mode ?? "interactive",
    displayTitle: `${request.project.label} scripted agent`,
    providerData: {
      runner: "scripted-agent",
      runnerPath,
      stateDir: options.stateDir,
      runId,
      ...(request.initialPrompt === undefined ? {} : { initialPromptProvided: true }),
      ...(options.scenarioPath === undefined ? {} : { scenarioPath: options.scenarioPath }),
    },
  };
}

export function defaultRunnerPath(): string {
  return fileURLToPath(new URL("../scripts/scripted-agent.mjs", import.meta.url));
}
