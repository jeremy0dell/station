import {
  classifyHostCompatibility,
  HOST_PROTOCOL_VERSION,
  stationHostCompatibilityError,
} from "@station/host";
import { describe, expect, it } from "vitest";

describe("classifyHostCompatibility", () => {
  it("reuses only an exact protocol and opaque build match", () => {
    expect(
      classifyHostCompatibility(
        { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "1.2.3+one" },
        "1.2.3+one",
      ),
    ).toEqual({ action: "reuse" });
  });

  it("replaces a different nonempty build on the current protocol", () => {
    expect(
      classifyHostCompatibility(
        { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "1.2.3+one" },
        "1.2.3+two",
      ),
    ).toEqual({ action: "replace", runningBuildVersion: "1.2.3+one" });
  });

  it("refuses protocol mismatches and legacy health", () => {
    expect(
      classifyHostCompatibility(
        { ok: true, protocolVersion: HOST_PROTOCOL_VERSION - 1, buildVersion: "1.2.3" },
        "1.2.3",
      ),
    ).toEqual({ action: "refuse", reason: "protocol-mismatch" });
    expect(
      classifyHostCompatibility({ ok: true, protocolVersion: HOST_PROTOCOL_VERSION }, "1.2.3"),
    ).toEqual({ action: "refuse", reason: "legacy-health" });
  });
});

describe("stationHostCompatibilityError", () => {
  it("returns no error for exact reuse and the canonical error for a mismatch", () => {
    expect(
      stationHostCompatibilityError(
        { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "build-current" },
        "build-current",
      ),
    ).toBeUndefined();

    expect(
      stationHostCompatibilityError(
        { ok: true, protocolVersion: HOST_PROTOCOL_VERSION, buildVersion: "build-old" },
        "build-current",
      ),
    ).toMatchObject({
      code: "HOST_VERSION_INCOMPATIBLE",
      message: expect.stringContaining('build "build-old"'),
    });
  });
});
