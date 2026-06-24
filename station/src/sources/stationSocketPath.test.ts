import { describe, expect, it } from "bun:test";
import { resolveStationObserverSocketPath } from "./stationSocketPath.js";

describe("resolveStationObserverSocketPath", () => {
  it("prefers the explicit override", () => {
    const path = resolveStationObserverSocketPath({
      STATION_OBSERVER_SOCKET_PATH: "/tmp/custom.sock",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HOME: "/home/dev",
    });

    expect(path).toBe("/tmp/custom.sock");
  });

  it("falls back to the XDG runtime dir", () => {
    const path = resolveStationObserverSocketPath({
      XDG_RUNTIME_DIR: "/run/user/1000",
      HOME: "/home/dev",
    });

    expect(path).toBe("/run/user/1000/station/observer.sock");
  });

  it("defaults to the station state dir under HOME", () => {
    const path = resolveStationObserverSocketPath({ HOME: "/home/dev" });

    expect(path).toBe("/home/dev/.local/state/station/run/observer.sock");
  });

  it("ignores empty overrides", () => {
    const path = resolveStationObserverSocketPath({
      STATION_OBSERVER_SOCKET_PATH: "",
      XDG_RUNTIME_DIR: "",
      HOME: "/home/dev",
    });

    expect(path).toBe("/home/dev/.local/state/station/run/observer.sock");
  });

  it("fails clearly when nothing can be resolved", () => {
    expect(() => resolveStationObserverSocketPath({})).toThrow(
      /STATION_OBSERVER_SOCKET_PATH or HOME/,
    );
  });
});
