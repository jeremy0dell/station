import { defineRealStartupSignalsLane } from "../../../support/real-station/startupSignals.js";

defineRealStartupSignalsLane({
  provider: "pi",
  captureEnv: "STATION_REAL_PI_STARTUP_CAPTURE",
});
