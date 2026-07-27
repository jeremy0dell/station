import { defineRealStartupSignalsLane } from "../../../support/real-station/startupSignals.js";

defineRealStartupSignalsLane({
  provider: "cursor",
  captureEnv: "STATION_REAL_CURSOR_STARTUP_CAPTURE",
});
