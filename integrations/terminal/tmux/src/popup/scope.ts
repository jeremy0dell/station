import { createHash } from "node:crypto";
import type { TmuxConfig, TmuxPopupScope } from "@station/config";
import {
  activePopupClaimOption,
  activePopupClientOption,
  defaultPersistentPopupSessionName,
  focusPopupClientOption,
} from "./constants.js";

export type TmuxPopupStateKeys = {
  activeClaimOption: string;
  activeClientOption: string;
  focusClientOption: string;
};

export type TmuxPopupScopeDescriptor = {
  kind: TmuxPopupScope;
  allowLegacyState: boolean;
  registerFastPopup: boolean;
  state: TmuxPopupStateKeys;
  uiSessionName: string;
};

export const serverPopupStateKeys: TmuxPopupStateKeys = {
  activeClaimOption: activePopupClaimOption,
  activeClientOption: activePopupClientOption,
  focusClientOption: focusPopupClientOption,
};

export function resolveTmuxPopupScope(config: TmuxConfig | undefined): TmuxPopupScope {
  return config?.popupScope ?? "server";
}

export function resolveTmuxPopupScopeDescriptor(input: {
  config?: TmuxConfig;
  focusClientId?: string;
  uiSessionName?: string;
}): TmuxPopupScopeDescriptor | undefined {
  const kind = resolveTmuxPopupScope(input.config);
  const baseSessionName = input.uiSessionName ?? defaultPersistentPopupSessionName;
  if (kind === "server") {
    return {
      kind,
      allowLegacyState: true,
      registerFastPopup: true,
      state: serverPopupStateKeys,
      uiSessionName: baseSessionName,
    };
  }
  if (input.focusClientId === undefined || input.focusClientId.length === 0) {
    return undefined;
  }
  // The deterministic hash keeps arbitrary tmux client names out of option and session identifiers.
  const namespace = createHash("sha256").update(input.focusClientId).digest("hex").slice(0, 16);
  return {
    kind,
    allowLegacyState: false,
    registerFastPopup: false,
    state: {
      activeClaimOption: `${activePopupClaimOption}_c_${namespace}`,
      activeClientOption: `${activePopupClientOption}_c_${namespace}`,
      focusClientOption: `${focusPopupClientOption}_c_${namespace}`,
    },
    uiSessionName: `${baseSessionName}-c-${namespace}`,
  };
}
