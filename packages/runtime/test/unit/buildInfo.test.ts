import { describe, expect, it, vi } from "vitest";
import {
  isCompiledBinary,
  parseStationObserverBuildVersion,
  stationBuildInfo,
  stationObserverBuildVersion,
} from "../../src/buildInfo.js";

const buildIdentity = "a".repeat(64);
const verifyBuildIdentity = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  readFileSync: () => `${buildIdentity}\n`,
}));
vi.mock("node:child_process", () => ({
  execFileSync: verifyBuildIdentity,
}));

describe("station build info", () => {
  it("reports the source-mode defaults when compile-time defines are absent", () => {
    expect(stationBuildInfo()).toEqual({
      version: "0.7.0",
      compiled: false,
      buildIdentity,
    });
    expect(isCompiledBinary()).toBe(false);
    expect(verifyBuildIdentity).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/scripts\/build-identity\.mjs$/u), "--verify", buildIdentity],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  it("refuses a source build whose published input or output identity is stale", () => {
    verifyBuildIdentity.mockImplementationOnce(() => {
      throw new Error("stale identity");
    });

    expect(() => stationBuildInfo()).toThrow("does not match the current checkout");
  });

  it("appends reserved identity metadata without changing the display version", () => {
    expect(
      stationObserverBuildVersion({ version: "1.2.3-dev", compiled: false, buildIdentity }),
    ).toBe(`1.2.3-dev+station.${buildIdentity}`);
    expect(
      stationObserverBuildVersion({
        version: "1.2.3+channel",
        compiled: true,
        buildIdentity,
      }),
    ).toBe(`1.2.3+channel.station.${buildIdentity}`);
    expect(
      stationObserverBuildVersion({
        version: "1.2.3-rc.station.1",
        compiled: false,
        buildIdentity,
      }),
    ).toBe(`1.2.3-rc.station.1+station.${buildIdentity}`);
  });

  it("parses only the reserved final identity suffix with exact optional fields", () => {
    expect(parseStationObserverBuildVersion(`1.2.3-dev+station.${buildIdentity}`)).toEqual({
      version: "1.2.3-dev",
      buildIdentity,
    });
    expect(parseStationObserverBuildVersion(`1.2.3+channel.station.${buildIdentity}`)).toEqual({
      version: "1.2.3+channel",
      buildIdentity,
    });

    const legacy = parseStationObserverBuildVersion("1.2.3-dev");
    expect(legacy).toEqual({ version: "1.2.3-dev" });
    expect("buildIdentity" in legacy).toBe(false);
  });

  it("rejects identities that cannot be carried as reserved metadata", () => {
    expect(() =>
      stationObserverBuildVersion({
        version: "1.2.3",
        compiled: false,
        buildIdentity: "A".repeat(64),
      }),
    ).toThrow("64 lowercase hexadecimal");
    expect(parseStationObserverBuildVersion(`1.2.3+station.${"A".repeat(64)}`)).toEqual({
      version: `1.2.3+station.${"A".repeat(64)}`,
    });
    expect(() =>
      stationObserverBuildVersion({
        version: "1.2.3+station.reserved",
        compiled: false,
        buildIdentity,
      }),
    ).toThrow("reserved station build metadata");
    const doubled = `1.2.3+station.${buildIdentity}.station.${buildIdentity}`;
    expect(parseStationObserverBuildVersion(doubled)).toEqual({ version: doubled });
  });
});
