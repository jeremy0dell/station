import { describe, expect, it } from "bun:test";
import { resolveStationLayoutPath } from "./stationLayoutPath.js";

describe("resolveStationLayoutPath", () => {
  it("prefers the explicit override", () => {
    const path = resolveStationLayoutPath({
      STATION_LAYOUT_PATH: "/tmp/custom-layout.json",
      XDG_STATE_HOME: "/home/dev/.state",
      HOME: "/home/dev",
    });

    expect(path).toBe("/tmp/custom-layout.json");
  });

  it("falls back to the XDG state home", () => {
    const path = resolveStationLayoutPath({
      XDG_STATE_HOME: "/home/dev/.state",
      HOME: "/home/dev",
    });

    expect(path).toBe("/home/dev/.state/station/station/layout.json");
  });

  it("defaults to the station state dir under HOME", () => {
    const path = resolveStationLayoutPath({ HOME: "/home/dev" });

    expect(path).toBe("/home/dev/.local/state/station/station/layout.json");
  });

  it("ignores empty overrides", () => {
    const path = resolveStationLayoutPath({
      STATION_LAYOUT_PATH: "",
      XDG_STATE_HOME: "",
      HOME: "/home/dev",
    });

    expect(path).toBe("/home/dev/.local/state/station/station/layout.json");
  });

  it("never uses the ephemeral runtime dir (must survive reboot)", () => {
    const path = resolveStationLayoutPath({
      XDG_RUNTIME_DIR: "/run/user/1000",
      HOME: "/home/dev",
    });

    expect(path).toBe("/home/dev/.local/state/station/station/layout.json");
  });

  it("fails clearly when nothing can be resolved", () => {
    expect(() => resolveStationLayoutPath({})).toThrow(
      /STATION_LAYOUT_PATH, XDG_STATE_HOME, or HOME/,
    );
  });
});
