import { describe, expect, it } from "bun:test";
import { resolveStationHostSocketPath } from "./stationHostSocketPath.js";

describe("resolveStationHostSocketPath", () => {
  it("prefers the explicit override", () => {
    expect(
      resolveStationHostSocketPath({
        STATION_HOST_SOCKET_PATH: "/tmp/custom-host.sock",
        HOME: "/home/dev",
      }),
    ).toBe("/tmp/custom-host.sock");
  });

  it("sits beside the resolved observer socket (override)", () => {
    expect(
      resolveStationHostSocketPath({ STATION_OBSERVER_SOCKET_PATH: "/run/station/observer.sock" }),
    ).toBe("/run/station/station-host.sock");
  });

  it("sits beside the default state-dir observer socket under HOME", () => {
    expect(resolveStationHostSocketPath({ HOME: "/home/dev" })).toBe(
      "/home/dev/.local/state/station/run/station-host.sock",
    );
  });
});
