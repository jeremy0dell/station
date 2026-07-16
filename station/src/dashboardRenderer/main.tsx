// Standalone OpenTUI dashboard renderer — the sole STATION dashboard UI after the
// Ink TUI (apps/tui) was retired. The Node CLI (`stn tui` / persistent popup)
// starts the observer and spawns this entry under Bun for both fullscreen and
// popup; it renders Station's dashboard view over the observer socket and
// dispatches the same observer commands the Ink TUI did (no Station panes).
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createTuiStore } from "@station/dashboard-core";
import { STATION_KEYBOARD_PROTOCOL } from "../input/keyboardProtocol.js";
import { createStationClient } from "../sources/createStationClient.js";
import { sanitizePastedText } from "../station/input/sequenceToTuiKey.js";
import { FullscreenDashboard } from "./FullscreenDashboard.js";
import { createDashboardSequenceHandler } from "./inputBridge.js";
import {
  createPopupRuntime,
  createProcessRendererControlChannel,
} from "./popupRuntime.js";

/** Callable entry for the read-only OpenTUI dashboard renderer. */
export async function runDashboardMain(): Promise<void> {
  const env = process.env;

  let rendererForExit: { destroy(): void } | undefined;
  function exit(code: number): void {
    rendererForExit?.destroy();
    process.exit(code);
  }
  const popupRuntime = createPopupRuntime(
    env,
    createProcessRendererControlChannel(),
    () => exit(1),
  );

  const client = createStationClient(env);
  const store = createTuiStore({
    source: client.state,
    service: client.service,
    clientLabel: "station",
    onExit: exit,
    ...popupRuntime.storeOptions,
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
    popupRuntime.dispose();
    detachSource();
    void client.stop();
  });
}

if (import.meta.main) {
  await runDashboardMain();
}
