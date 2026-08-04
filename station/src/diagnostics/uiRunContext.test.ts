import { UiRunContextSchema } from "@station/contracts";
import { describe, expect, it } from "bun:test";
import { resolveUiRunContext, type UiRunIdSlots } from "./uiRunContext.js";

const launcherId = "ui_11111111-1111-4111-8111-111111111111";

describe("UI run context", () => {
  it("accepts a valid launcher identity", () => {
    const slots: UiRunIdSlots = {};
    const context = resolveUiRunContext({
      env: { STATION_UI_RUN_ID: launcherId },
      slots,
      rendererPid: 42,
    });

    expect(context).toEqual({
      uiRunId: launcherId,
      rendererPid: 42,
      clientKind: "native_renderer",
    });
    expect(slots.__stationUiRunId).toBe(launcherId);
  });

  it("replaces malformed input instead of failing renderer startup", () => {
    const context = resolveUiRunContext({
      env: { STATION_UI_RUN_ID: "malformed" },
      slots: {},
      rendererPid: 43,
    });

    expect(context.uiRunId).not.toBe("malformed");
    expect(UiRunContextSchema.safeParse(context).success).toBe(true);
  });

  it("preserves a direct-development identity across HMR resolution", () => {
    const slots: UiRunIdSlots = {};
    const first = resolveUiRunContext({ env: {}, slots, rendererPid: 44 });
    const second = resolveUiRunContext({ env: {}, slots, rendererPid: 44 });

    expect(second.uiRunId).toBe(first.uiRunId);
  });
});
