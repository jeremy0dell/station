import type { TmuxCommandInput } from "../command.js";
import {
  defaultTmuxWorkbenchSessionOptions,
  resolveTmuxWorkbenchConfig,
  tmuxSessionOptionArgs,
} from "../topology.js";
import { hasTmuxSession, runTmuxPopupCommand, runTmuxPopupQuery } from "./command.js";
import type { PopupWorkbenchFocusInput, WorkbenchTarget } from "./types.js";

async function configureWorkbenchSession(
  input: TmuxCommandInput,
  sessionId: string,
): Promise<void> {
  for (const option of defaultTmuxWorkbenchSessionOptions) {
    await runTmuxPopupCommand(input, {
      args: tmuxSessionOptionArgs(sessionId, option),
      operation: "provider.tmux.popup.configureWorkbench",
      message: "tmux failed to configure the station workbench.",
      timeoutMessage: "tmux workbench configuration timed out.",
    });
  }
}

async function firstLiveAgentPane(
  input: TmuxCommandInput,
  sessionId: string,
): Promise<WorkbenchTarget | undefined> {
  const output = await runTmuxPopupQuery(input, {
    args: [
      "list-panes",
      "-s",
      "-t",
      sessionId,
      "-F",
      "#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@station.role}",
    ],
    operation: "provider.tmux.popup.listWorkbenchPanes",
    message: "tmux failed to inspect station workbench panes.",
    timeoutMessage: "tmux workbench pane inspection timed out.",
  });
  for (const line of output.stdout.split(/\r?\n/)) {
    const [windowId = "", paneId = "", paneDead = "", role = ""] = line.split("\t");
    if (windowId.length > 0 && paneId.length > 0 && paneDead !== "1" && role === "main-agent") {
      return { sessionId, windowId, paneId };
    }
  }
  return undefined;
}

async function firstWorkbenchWindow(
  input: TmuxCommandInput,
  sessionId: string,
): Promise<WorkbenchTarget | undefined> {
  const output = await runTmuxPopupQuery(input, {
    args: ["list-windows", "-t", sessionId, "-F", "#{window_id}"],
    operation: "provider.tmux.popup.listWorkbenchWindows",
    message: "tmux failed to inspect station workbench windows.",
    timeoutMessage: "tmux workbench window inspection timed out.",
  });
  const windowId = output.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return windowId === undefined ? undefined : { sessionId, windowId };
}

async function switchClientToWorkbench(
  input: TmuxCommandInput & { clientId: string; target: WorkbenchTarget },
): Promise<void> {
  await runTmuxPopupCommand(input, {
    args: ["switch-client", "-c", input.clientId, "-t", input.target.sessionId],
    operation: "provider.tmux.popup.enterWorkbench",
    message: "tmux failed to enter the station workbench.",
    timeoutMessage: "tmux workbench focus timed out.",
  });
  if (input.target.windowId !== undefined) {
    await runTmuxPopupCommand(input, {
      args: ["select-window", "-t", `${input.target.sessionId}:${input.target.windowId}`],
      operation: "provider.tmux.popup.enterWorkbench",
      message: "tmux failed to select the station workbench window.",
      timeoutMessage: "tmux workbench window focus timed out.",
    });
  }
  if (input.target.paneId !== undefined) {
    await runTmuxPopupCommand(input, {
      args: ["select-pane", "-t", input.target.paneId],
      operation: "provider.tmux.popup.enterWorkbench",
      message: "tmux failed to select the station workbench pane.",
      timeoutMessage: "tmux workbench pane focus timed out.",
    });
  }
}

async function resolveWorkbenchTarget(
  input: TmuxCommandInput,
  sessionId: string,
): Promise<WorkbenchTarget> {
  const sessionExists = await hasTmuxSession(input, sessionId);
  if (!sessionExists) {
    await runTmuxPopupCommand(input, {
      args: ["new-session", "-d", "-s", sessionId, "-n", "station"],
      operation: "provider.tmux.popup.createWorkbench",
      message: "tmux failed to create the station workbench.",
      timeoutMessage: "tmux workbench creation timed out.",
    });
    await configureWorkbenchSession(input, sessionId);
    return { sessionId };
  }

  await configureWorkbenchSession(input, sessionId);

  const agentTarget = await firstLiveAgentPane(input, sessionId);
  if (agentTarget !== undefined) {
    return agentTarget;
  }

  const firstWindow = await firstWorkbenchWindow(input, sessionId);
  return firstWindow ?? { sessionId };
}

export async function enterWorkbenchForPopup(input: PopupWorkbenchFocusInput): Promise<void> {
  const config = resolveTmuxWorkbenchConfig(input.config);
  const target = await resolveWorkbenchTarget(input, config.workbenchSession);
  await switchClientToWorkbench({ ...input, target });
}
