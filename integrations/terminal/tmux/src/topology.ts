import { normalizeObservedPath, type TerminalTargetId } from "@station/contracts";
import { stableName } from "@station/runtime";

export {
  defaultTmuxWorkbenchConfig,
  resolveTmuxWorkbenchConfig,
  type TmuxWorkbenchConfig,
} from "./workbenchConfig.js";

export type TmuxSessionOption = {
  name: string;
  value: string;
};

export const defaultTmuxWorkbenchSessionOptions: readonly TmuxSessionOption[] = [
  { name: "mouse", value: "on" },
  { name: "history-limit", value: "100000" },
  { name: "set-clipboard", value: "on" },
];

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
