import type { TmuxCommandInput } from "../command.js";
import { clearTmuxGlobalOption, resolveTmuxGlobalOption, setTmuxGlobalOption } from "./command.js";
import { activePopupClientOption, focusPopupClientOption } from "./constants.js";

export async function resolveActivePopupClient(
  input: TmuxCommandInput,
): Promise<string | undefined> {
  return resolveTmuxGlobalOption(input, activePopupClientOption, {
    operation: "provider.tmux.popup.activeClient",
    message: "tmux failed to resolve the active station popup.",
    timeoutMessage: "tmux active popup lookup timed out.",
  });
}

export async function resolveFocusPopupClient(
  input: TmuxCommandInput,
): Promise<string | undefined> {
  return resolveTmuxGlobalOption(input, focusPopupClientOption, {
    operation: "provider.tmux.popup.focusClient",
    message: "tmux failed to resolve the station popup focus client.",
    timeoutMessage: "tmux popup focus client lookup timed out.",
  });
}

export async function setActivePopupClient(
  input: TmuxCommandInput & { clientId: string },
): Promise<void> {
  await setTmuxGlobalOption(input, activePopupClientOption, input.clientId, {
    operation: "provider.tmux.popup.setActiveClient",
    message: "tmux failed to record the active station popup.",
    timeoutMessage: "tmux active popup update timed out.",
  });
}

export async function setFocusPopupClient(
  input: TmuxCommandInput & { clientId: string },
): Promise<void> {
  await setTmuxGlobalOption(input, focusPopupClientOption, input.clientId, {
    operation: "provider.tmux.popup.setFocusClient",
    message: "tmux failed to record the station popup focus client.",
    timeoutMessage: "tmux popup focus client update timed out.",
  });
}

export async function clearActivePopupClient(input: TmuxCommandInput): Promise<void> {
  await clearTmuxGlobalOption(input, activePopupClientOption, {
    operation: "provider.tmux.popup.clearActiveClient",
    message: "tmux failed to clear the active station popup.",
    timeoutMessage: "tmux active popup clear timed out.",
  });
}

export async function clearFocusPopupClient(input: TmuxCommandInput): Promise<void> {
  await clearTmuxGlobalOption(input, focusPopupClientOption, {
    operation: "provider.tmux.popup.clearFocusClient",
    message: "tmux failed to clear the station popup focus client.",
    timeoutMessage: "tmux popup focus client clear timed out.",
  });
}
