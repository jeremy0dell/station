import type { TmuxConfig, TmuxPopupScope } from "@station/config";
import { normalizeObservedPath, type TerminalTargetId } from "@station/contracts";
import { stableName } from "@station/runtime";

export type TmuxWorkbenchConfig = {
  topology: "workbench";
  workbenchSession: string;
  workbenchSocketPath?: string;
  windowNaming: "project-branch";
  primaryAgentPane: boolean;
  popupWidth: string;
  popupHeight: string;
  popupPosition: string;
  popupScope: TmuxPopupScope;
  popupStatusBar: boolean;
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
  popupScope: "server",
  popupStatusBar: false,
};

export const defaultTmuxWorkbenchSessionOptions: readonly TmuxSessionOption[] = [
  { name: "mouse", value: "on" },
  { name: "history-limit", value: "100000" },
  { name: "set-clipboard", value: "on" },
];

export function resolveTmuxWorkbenchConfig(config: TmuxConfig = {}): TmuxWorkbenchConfig {
  const resolved: TmuxWorkbenchConfig = {
    topology: config.topology ?? defaultTmuxWorkbenchConfig.topology,
    workbenchSession: config.workbenchSession ?? defaultTmuxWorkbenchConfig.workbenchSession,
    windowNaming: config.windowNaming ?? defaultTmuxWorkbenchConfig.windowNaming,
    primaryAgentPane: config.primaryAgentPane ?? defaultTmuxWorkbenchConfig.primaryAgentPane,
    popupWidth: config.popupWidth ?? defaultTmuxWorkbenchConfig.popupWidth,
    popupHeight: config.popupHeight ?? defaultTmuxWorkbenchConfig.popupHeight,
    popupPosition: config.popupPosition ?? defaultTmuxWorkbenchConfig.popupPosition,
    popupScope: config.popupScope ?? defaultTmuxWorkbenchConfig.popupScope,
    popupStatusBar: config.popupStatusBar ?? defaultTmuxWorkbenchConfig.popupStatusBar,
  };
  if (config.workbenchSocketPath !== undefined) {
    resolved.workbenchSocketPath = config.workbenchSocketPath;
  }
  return resolved;
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
}): TerminalTargetId {
  const identityPath = input.path === undefined ? "" : normalizeObservedPath(input.path);
  return stableName({
    profile: "tmux-window",
    display: [input.projectId, input.branch],
    unique: ["tmux-window", input.projectId, input.worktreeId ?? "", identityPath, input.branch],
    hash: input.forceHash === true ? "always" : "auto",
  });
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
