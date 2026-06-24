import type { TmuxConfig } from "@station/config";
import { normalizeObservedPath } from "@station/contracts";
import { stableName } from "@station/runtime";

export type TmuxWorkbenchConfig = {
  topology: "workbench";
  workbenchSession: string;
  windowNaming: "project-branch";
  primaryAgentPane: boolean;
  popupWidth: string;
  popupHeight: string;
  popupPosition: string;
};

export type TmuxSessionOption = {
  name: string;
  value: string;
};

export const defaultTmuxWorkbenchConfig: TmuxWorkbenchConfig = {
  topology: "workbench",
  workbenchSession: "station",
  windowNaming: "project-branch",
  primaryAgentPane: true,
  popupWidth: "50%",
  popupHeight: "50%",
  popupPosition: "C",
};

export const defaultTmuxWorkbenchSessionOptions: readonly TmuxSessionOption[] = [
  { name: "mouse", value: "on" },
  { name: "history-limit", value: "100000" },
  { name: "set-clipboard", value: "on" },
];

export function resolveTmuxWorkbenchConfig(config: TmuxConfig = {}): TmuxWorkbenchConfig {
  return {
    topology: config.topology ?? defaultTmuxWorkbenchConfig.topology,
    workbenchSession: config.workbenchSession ?? defaultTmuxWorkbenchConfig.workbenchSession,
    windowNaming: config.windowNaming ?? defaultTmuxWorkbenchConfig.windowNaming,
    primaryAgentPane: config.primaryAgentPane ?? defaultTmuxWorkbenchConfig.primaryAgentPane,
    popupWidth: config.popupWidth ?? defaultTmuxWorkbenchConfig.popupWidth,
    popupHeight: config.popupHeight ?? defaultTmuxWorkbenchConfig.popupHeight,
    popupPosition: config.popupPosition ?? defaultTmuxWorkbenchConfig.popupPosition,
  };
}

export function tmuxSessionOptionArgs(sessionId: string, option: TmuxSessionOption): string[] {
  return ["set-option", "-t", sessionId, option.name, option.value];
}

export function tmuxNewWindowTarget(sessionId: string): string {
  return `${sessionId}:`;
}

export function buildWorkbenchWindowName(input: {
  projectId: string;
  branch: string;
  worktreeId?: string;
  path?: string;
  forceHash?: boolean;
}): string {
  const identityPath = input.path === undefined ? "" : normalizeObservedPath(input.path);
  return stableName({
    profile: "tmux-window",
    display: [input.projectId, input.branch],
    unique: ["tmux-window", input.projectId, input.worktreeId ?? "", identityPath, input.branch],
    hash: input.forceHash === true ? "always" : "auto",
  });
}

export function buildTmuxTargetId(input: {
  sessionId: string;
  windowId: string;
  paneId: string;
}): string {
  return `tmux:${input.sessionId}:${input.windowId}:${input.paneId}`;
}

export function parseTmuxTargetId(targetId: string): {
  sessionId: string;
  windowId: string;
  paneId: string;
} {
  const [provider, sessionId, windowId, paneId, ...extra] = targetId.split(":");
  if (
    provider !== "tmux" ||
    sessionId === undefined ||
    windowId === undefined ||
    paneId === undefined
  ) {
    throw new Error(`Invalid tmux target id: ${targetId}`);
  }
  if (extra.length > 0) {
    throw new Error(`Invalid tmux target id: ${targetId}`);
  }
  return { sessionId, windowId, paneId };
}

export function tmuxWindowTarget(input: { sessionId: string; windowNameOrId: string }): string {
  return `${input.sessionId}:${input.windowNameOrId}`;
}

export function tmuxPrimaryPaneTarget(input: {
  sessionId: string;
  windowNameOrId: string;
}): string {
  return `${input.sessionId}:${input.windowNameOrId}.0`;
}
