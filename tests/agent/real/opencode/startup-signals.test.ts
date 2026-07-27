import { defineRealStartupSignalsLane } from "../../../support/real-station/startupSignals.js";

defineRealStartupSignalsLane({
  provider: "opencode",
  captureEnv: "STATION_REAL_OPENCODE_STARTUP_CAPTURE",
});
