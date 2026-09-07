import type { TmuxConfig, TmuxPopupScope } from "@station/config";

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
