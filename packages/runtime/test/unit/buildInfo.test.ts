import { describe, expect, it } from "vitest";
import { isCompiledBinary, stationBuildInfo } from "../../src/buildInfo.js";

describe("station build info", () => {
  it("reports the source-mode defaults when compile-time defines are absent", () => {
    expect(stationBuildInfo()).toEqual({ version: "0.7.0", compiled: false });
    expect(isCompiledBinary()).toBe(false);
  });
});
