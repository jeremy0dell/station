import type { TmuxConfig } from "@station/config";
import type { ExternalCommandRunner } from "@station/runtime";
import type { TmuxCommandInput } from "../command.js";

export type TmuxPopupOptions = {
  checkoutRoot?: string;
  command?: string;
  config?: TmuxConfig;
  enterWorkbench?: boolean;
  env?: NodeJS.ProcessEnv;
  focusClientId?: string;
  preferRegisteredDevPopup?: boolean;
  registeredDevPopupRoot?: string;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
  tuiCommand?: string;
  persistent?: boolean;
  uiSessionName?: string;
};

export type TmuxPopupResult = { opened: true } | { opened: false; closed: true };
export type TmuxPopupDismissResult = { dismissed: true } | { dismissed: false };
export type TmuxPopupShellResult = { opened: true } | { opened: false };
export type TmuxPersistentPopupSessionResult = { sessionName: string; created: boolean };
export type TmuxRegisteredDevPopupUi = {
  command: string;
  owner?: string;
  root?: string;
  sessionName: string;
};

export type BuildTmuxPopupArgsOptions = {
  command?: string;
  config?: TmuxConfig;
  focusClientId?: string;
  persistent?: boolean;
  popupState?: TmuxPopupState;
  tuiCommand?: string;
  uiSessionName?: string;
};

export type TmuxCurrentClientInput = {
  command: string;
  env: NodeJS.ProcessEnv;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
};

export type TmuxClientIdentity = {
  name: string;
  pid: number;
  sessionName: string;
};

export type TmuxPersistentPopupSessionOptions = {
  command?: string;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
  tuiCommand?: string;
  uiSessionName?: string;
};

export type TmuxPopupCommandInputOptions = {
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
};

export type TmuxPopupDismissOptions = {
  command?: string;
  env?: NodeJS.ProcessEnv;
  focusClientId?: string;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
};

export type TmuxPopupFocusTarget = {
  origin: {
    provider: "tmux";
    clientId: string;
  };
  openShell: (cwd: string) => Promise<TmuxPopupShellResult>;
  dismissExact: () => Promise<TmuxPopupDismissResult>;
};

export type TmuxPopupFocusOriginOptions = {
  command?: string;
  env?: NodeJS.ProcessEnv;
  focusClientId?: string;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
};

export type TmuxRegisteredDevPopupOptions = {
  command?: string;
  runner?: ExternalCommandRunner;
  timeoutMs?: number;
};

export type TmuxPersistentPopupUi = {
  command: string;
  registerFastPopup: boolean;
  root?: string;
  sessionName: string;
};

export type ResolvePersistentPopupUiOptions = {
  checkoutRoot?: string;
  preferRegisteredDevPopup?: boolean;
  registeredDevPopupRoot?: string;
  tuiCommand?: string;
  uiSessionName?: string;
};

export type TmuxPopupState = {
  claim?: string;
  claimOptionName?: string;
  clientId: string;
  focusOptionName?: string;
  optionName: string;
  tmuxCommand: string;
};

export type PopupWorkbenchFocusInput = TmuxCommandInput & {
  clientId: string;
  config?: TmuxConfig;
};

export type WorkbenchTarget = {
  sessionId: string;
  windowId?: string;
  paneId?: string;
};
