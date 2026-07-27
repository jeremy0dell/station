import { defineRealStartupSignalsLane } from "../../../support/real-station/startupSignals.js";

defineRealStartupSignalsLane({
  provider: "codex",
  captureEnv: "STATION_REAL_CODEX_STARTUP_CAPTURE",
});
