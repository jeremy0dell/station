import { describe, expect, it } from "bun:test";
import type { StationClientConnectionState } from "@station/client";
import { presentConnection } from "./connectionLabel.js";
import { STATION_COLORS } from "./view/theme.js";

describe("presentConnection", () => {
  it("maps connection states to shared Station theme colors", () => {
    expect(presentConnection({ state: "idle" }).color).toBe(STATION_COLORS.gray);
    expect(presentConnection({ state: "loading", since: 0 }).color).toBe(
      STATION_COLORS.state.warning,
    );
    expect(presentConnection({ state: "connected", since: 0 }).color).toBe(
      STATION_COLORS.state.success,
    );
    expect(presentConnection(connection("reconnecting")).color).toBe(
      STATION_COLORS.state.warning,
    );
    expect(presentConnection(connection("displayOnly")).color).toBe(STATION_COLORS.state.warning);
    expect(
      presentConnection({
        state: "halted",
        since: 0,
        lastError: {
          tag: "ProtocolError",
          code: "PROTOCOL_CONNECT_FAILED",
          message: "socket failed",
        },
      }).color,
    ).toBe(STATION_COLORS.state.danger);
  });
});

function connection(
  state: "reconnecting" | "displayOnly",
): Extract<StationClientConnectionState, { state: typeof state }> {
  return {
    state,
    since: 0,
    lastError: {
      tag: "ProtocolError",
      code: "PROTOCOL_CONNECT_FAILED",
      message: "socket failed",
    },
  } as Extract<StationClientConnectionState, { state: typeof state }>;
}
