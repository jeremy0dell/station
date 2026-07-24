import { afterEach, describe, expect, it } from "vitest";
import { realHarnessChildEnv } from "../../../../tests/support/real-station/env.js";

const inheritedStationValue = process.env.STATION_PARENT_TEST;

describe("real Station environment support", () => {
  afterEach(() => {
    if (inheritedStationValue === undefined) {
      delete process.env.STATION_PARENT_TEST;
    } else {
      process.env.STATION_PARENT_TEST = inheritedStationValue;
    }
  });

  it("removes inherited Station state and keeps fixture overrides", () => {
    process.env.STATION_PARENT_TEST = "leaked";

    const env = realHarnessChildEnv({ STATION_SESSION_ID: "ses_fixture" });

    expect(env.STATION_PARENT_TEST).toBeUndefined();
    expect(env.STATION_SESSION_ID).toBe("ses_fixture");
    expect(env.PATH).toBe(process.env.PATH);
  });
});
