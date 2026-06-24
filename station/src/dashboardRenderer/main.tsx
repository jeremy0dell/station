// Standalone OpenTUI dashboard renderer — the sole STATION dashboard UI after the
// Ink TUI (apps/tui) was retired. The Node CLI (`stn tui` / the tmux popup)
// starts the observer and spawns this entry under Bun for both fullscreen and
// popup; it renders Station's dashboard view over the observer socket and
// dispatches the same observer commands the Ink TUI did (no Station panes).
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ProviderId, TerminalFocusOrigin } from "@station/contracts";
import { createTuiStore } from "@station/dashboard-core";
import { STATION_KEYBOARD_PROTOCOL } from "../input/keyboardProtocol.js";
import { createStationClient } from "../sources/createStationClient.js";
import { sanitizePastedText } from "../station/input/sequenceToTuiKey.js";
import { FullscreenDashboard } from "./FullscreenDashboard.js";
import { createDashboardSequenceHandler } from "./inputBridge.js";

declare const Bun: {
  env: Record<string, string | undefined>;
};

const env = Bun.env;
// In a tmux popup the launcher exports STATION_TUI_POPUP=1 plus the focus origin;
// the dashboard then exits as soon as a focus lands (closing the popup) and
// asks the observer to focus the originating tmux client.
const isPopup = env.STATION_TUI_POPUP === "1";

function focusOriginFromEnv(): TerminalFocusOrigin | undefined {
  const provider = env.STATION_FOCUS_PROVIDER;
  if (provider === undefined || provider.length === 0) {
    return undefined;
  }
  const origin: TerminalFocusOrigin = { provider: provider as ProviderId };
  const clientId = env.STATION_FOCUS_CLIENT_ID;
  if (clientId !== undefined && clientId.length > 0) {
    origin.clientId = clientId;
  }
  return origin;
}

let rendererForExit: { destroy(): void } | undefined;
function exit(code: number): void {
  rendererForExit?.destroy();
  process.exit(code);
}

const client = createStationClient(env);
const focusOrigin = isPopup ? focusOriginFromEnv() : undefined;
const store = createTuiStore({
  source: client.state,
  service: client.service,
  clientLabel: "station",
  exitOnFocusSuccess: isPopup,
  onExit: exit,
  ...(focusOrigin === undefined ? {} : { focusOrigin }),
});

// Attach the snapshot source first, then start the client runtime feeding it
// (the order Station's lifecycle uses), so the first frame already sees the
// connection state instead of a stale "disconnected".
const detachSource = store.getState().start();
client.start();

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  prependInputHandlers: [createDashboardSequenceHandler(store)],
  useKittyKeyboard: STATION_KEYBOARD_PROTOCOL,
});
rendererForExit = renderer;
// OpenTUI routes paste around the sequence handlers; forward it as sanitized
// text so a paste into search / the new-session name lands as input.
renderer.keyInput.on("paste", (event) => {
  const text = sanitizePastedText(new TextDecoder().decode(event.bytes));
  if (text.length > 0) {
    store.getState().handleKey({ input: text });
  }
});

const root = createRoot(renderer);
root.render(<FullscreenDashboard store={store} />);

process.on("exit", () => {
  detachSource();
  void client.stop();
});
