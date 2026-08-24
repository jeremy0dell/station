import {
  UpdateChannelIdSchema,
  UpdateCommandArgvSchema,
  UpdateCommandStepSchema,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

describe("update command schemas", () => {
  it("parses current command vocabulary strictly", () => {
    expect(UpdateChannelIdSchema.safeParse("unknown").success).toBe(false);
    expect(UpdateCommandArgvSchema.safeParse([""]).success).toBe(false);
    expect(UpdateCommandArgvSchema.parse(["stn", "update"])).toEqual(["stn", "update"]);
    expect(
      UpdateCommandStepSchema.safeParse({
        id: "plan",
        status: "completed",
        detail: "Resolved builds.",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
