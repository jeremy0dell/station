import { defineRealStartupSignalsLane } from "../../../support/real-station/startupSignals.js";

defineRealStartupSignalsLane({
  provider: "claude",
  captureEnv: "STATION_REAL_CLAUDE_STARTUP_CAPTURE",
});
