import { describe, expect, it } from "vitest";
import {
  resolveTmuxPopupScope,
  resolveTmuxPopupScopeDescriptor,
  serverPopupStateKeys,
} from "../../src/popup/scope";

describe("tmux popup scope", () => {
  it("preserves the existing server-owned popup defaults", () => {
    expect(resolveTmuxPopupScope(undefined)).toBe("server");
    expect(resolveTmuxPopupScopeDescriptor({})).toEqual({
      kind: "server",
      allowLegacyState: true,
      registerFastPopup: true,
      state: serverPopupStateKeys,
      uiSessionName: "_station-ui",
    });
  });

  it("derives stable isolated state and renderer names for each client", () => {
    const first = resolveTmuxPopupScopeDescriptor({
      config: { popupScope: "client" },
      focusClientId: "/dev/ttys001",
    });
    const repeated = resolveTmuxPopupScopeDescriptor({
      config: { popupScope: "client" },
      focusClientId: "/dev/ttys001",
    });
    const second = resolveTmuxPopupScopeDescriptor({
      config: { popupScope: "client" },
      focusClientId: "/dev/ttys002",
    });

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      kind: "client",
      allowLegacyState: false,
      registerFastPopup: false,
      state: {
        activeClaimOption: expect.stringMatching(/^@station_popup_active_claim_c_[a-f0-9]{16}$/),
        activeClientOption: expect.stringMatching(/^@station_popup_client_c_[a-f0-9]{16}$/),
        focusClientOption: expect.stringMatching(/^@station_popup_focus_client_c_[a-f0-9]{16}$/),
      },
      uiSessionName: expect.stringMatching(/^_station-ui-c-[a-f0-9]{16}$/),
    });
    expect(second?.state).not.toEqual(first?.state);
    expect(second?.uiSessionName).not.toBe(first?.uiSessionName);
  });

  it("requires a concrete client before selecting client scope", () => {
    expect(resolveTmuxPopupScopeDescriptor({ config: { popupScope: "client" } })).toBeUndefined();
  });
});
