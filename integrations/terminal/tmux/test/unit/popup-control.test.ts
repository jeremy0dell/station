import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTmuxPopupControl } from "../../src/popup/control.js";
import { dismissTmuxPopup, resolveTmuxPopupFocusTarget } from "../../src/popup/index.js";

vi.mock("../../src/popup/index.js", () => ({
  dismissTmuxPopup: vi.fn(async () => ({ dismissed: true })),
  resolveTmuxPopupFocusTarget: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

describe("tmux popup controls", () => {
  it("follows the current shared popup without mutating the startup environment", async () => {
    const env = { STATION_FOCUS_CLIENT_ID: "startup-client" };
    const control = createTmuxPopupControl({ env });
    await control.dismissPopup();
    await control.resolveFocusTarget();
    expect(dismissTmuxPopup).toHaveBeenCalledWith({ env: {} });
    expect(resolveTmuxPopupFocusTarget).toHaveBeenCalledWith({ env: {} });
    expect(env.STATION_FOCUS_CLIENT_ID).toBe("startup-client");
  });

  it("retains the client for a client-scoped renderer", async () => {
    const env = { STATION_FOCUS_CLIENT_ID: "owner-client" };
    await createTmuxPopupControl({ env, config: { popupScope: "client" } }).dismissPopup();
    expect(dismissTmuxPopup).toHaveBeenCalledWith({ env, config: { popupScope: "client" } });
  });

  it.each([
    false,
    true,
  ])("dismisses the exact resolved popup only after shell opening succeeds: %j", async (opened) => {
    const events: string[] = [];
    const dismissExact = vi.fn(async () => {
      events.push("dismiss");
      return { dismissed: true };
    });
    vi.mocked(resolveTmuxPopupFocusTarget).mockResolvedValue({
      origin: { provider: "tmux", clientId: "current-client" },
      openShell: async (cwd) => {
        events.push(cwd);
        return { opened };
      },
      dismissExact,
    });
    const control = createTmuxPopupControl({ env: {} });
    await expect(control.openShell?.("/project path")).resolves.toEqual({ opened });
    expect(events).toEqual(opened ? ["/project path", "dismiss"] : ["/project path"]);
    expect(dismissTmuxPopup).not.toHaveBeenCalled();
  });

  it("preserves refusal when the popup owner changes after opening a shell", async () => {
    vi.mocked(resolveTmuxPopupFocusTarget).mockResolvedValue({
      origin: { provider: "tmux", clientId: "old-client" },
      openShell: async () => ({ opened: true }),
      dismissExact: async () => ({ dismissed: false }),
    });
    await expect(createTmuxPopupControl({ env: {} }).openShell?.("/project")).resolves.toEqual({
      opened: false,
    });
    expect(dismissTmuxPopup).not.toHaveBeenCalled();
  });
});
