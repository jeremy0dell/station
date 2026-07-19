import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseStationObserverBuildVersion,
  stationObserverBuildVersion,
} from "../../src/buildInfo.js";

const buildIdentity = "a".repeat(64);
const verifyBuildIdentity = vi.hoisted(() => vi.fn());
const verifiedSourceBuildIdentitySlot = Symbol.for(
  "@station/runtime/verified-source-build-identity",
);

vi.mock("node:fs", () => ({
  readFileSync: () => `${buildIdentity}\n`,
}));
vi.mock("node:child_process", () => ({
  execFileSync: verifyBuildIdentity,
}));

describe("station build info", () => {
  beforeEach(() => {
    vi.resetModules();
    verifyBuildIdentity.mockReset();
    Reflect.deleteProperty(globalThis, verifiedSourceBuildIdentitySlot);
  });

  it("caches one verified source identity across module resets in the same process", async () => {
    const {
      isCompiledBinary,
      stationBuildInfo,
      stationObserverBuildVersion: currentObserverBuildVersion,
    } = await import("../../src/buildInfo.js");

    expect(isCompiledBinary()).toBe(false);
    expect(verifyBuildIdentity).not.toHaveBeenCalled();
    expect(stationBuildInfo()).toEqual({
      version: "0.7.1-rc.4",
      compiled: false,
      buildIdentity,
    });
    expect(currentObserverBuildVersion()).toBe(`0.7.1-rc.4+station.${buildIdentity}`);
    expect(currentObserverBuildVersion()).toBe(`0.7.1-rc.4+station.${buildIdentity}`);
    expect(stationBuildInfo()).toEqual({
      version: "0.7.1-rc.4",
      compiled: false,
      buildIdentity,
    });
    expect(verifyBuildIdentity).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/scripts\/build-identity\.mjs$/u), "--verify", buildIdentity],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(verifyBuildIdentity).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const reloaded = await import("../../src/buildInfo.js");
    expect(reloaded.stationBuildInfo()).toMatchObject({ buildIdentity });
    expect(verifyBuildIdentity).toHaveBeenCalledTimes(1);
  });

  it("refuses a source build whose published input or output identity is stale", async () => {
    verifyBuildIdentity.mockImplementationOnce(() => {
      throw new Error("stale identity");
    });
    const { stationBuildInfo } = await import("../../src/buildInfo.js");

    expect(() => stationBuildInfo()).toThrow("does not match the current checkout");
    expect(stationBuildInfo()).toMatchObject({ buildIdentity });
    expect(verifyBuildIdentity).toHaveBeenCalledTimes(2);

    vi.resetModules();
    const reloaded = await import("../../src/buildInfo.js");
    expect(reloaded.stationBuildInfo()).toMatchObject({ buildIdentity });
    expect(verifyBuildIdentity).toHaveBeenCalledTimes(2);
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
