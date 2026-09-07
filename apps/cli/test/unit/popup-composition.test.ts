import { fileURLToPath } from "node:url";
import { emptyConfig } from "@station/config";
import { createTmuxPopupControl, createTmuxPopupLauncher } from "@station/tmux";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPopupControl, createPopupLauncher } from "../../src/popupComposition.js";

vi.mock("@station/tmux", () => ({
  createTmuxPopupLauncher: vi.fn(() => ({ open: vi.fn() })),
  createTmuxPopupControl: vi.fn(() => ({ dismissPopup: vi.fn(), resolveFocusTarget: vi.fn() })),
}));
const cliEntryPath = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

beforeEach(() => vi.clearAllMocks());

describe("popup composition", () => {
  it("binds resolved config, executable, and installed ownership without opening a popup", () => {
    const config = emptyConfig();
    config.defaults.terminal = "tmux";
    config.terminal = {
      tmux: { command: "/custom/tmux", popupScope: "client", popupWidth: "90%" },
    };
    const popup = createPopupLauncher({
      config,
      cliEntryPath,
      configPath: "/tmp/config file.toml",
      installedRoot: "/opt/station",
      env: {},
      timeoutMs: 250,
    });
    expect(popup.open).not.toHaveBeenCalled();
    const input = vi.mocked(createTmuxPopupLauncher).mock.lastCall?.[0];
    expect(input).toMatchObject({
      config: config.terminal.tmux,
      checkoutRoot: "/opt/station",
      installedRoot: "/opt/station",
      env: {},
      timeoutMs: 250,
    });
    expect(input?.buildRendererCommand(undefined, true)).toBe(
      `'${process.execPath}' '${cliEntryPath}' --config '/tmp/config file.toml' tui --popup --persistent`,
    );
    expect(input?.buildRendererCommand("node --watch custom-ui", true)).toBe(
      "node --watch custom-ui --config '/tmp/config file.toml' tui --popup --persistent",
    );
  });

  it("lets the selected adapter request a transient dashboard", () => {
    createPopupLauncher({ cliEntryPath, env: {} });
    const input = vi.mocked(createTmuxPopupLauncher).mock.lastCall?.[0];
    expect(input?.buildRendererCommand(undefined, false)).toBe(
      `'${process.execPath}' '${cliEntryPath}' tui --popup`,
    );
  });

  it("retains config-less first-run routing without inventing a config argument", () => {
    createPopupLauncher({ config: emptyConfig(), firstRun: true, cliEntryPath, env: {} });
    const input = vi.mocked(createTmuxPopupLauncher).mock.lastCall?.[0];
    expect(input?.buildRendererCommand(undefined, true)).not.toContain("--config");
    expect(input?.checkoutRoot).toBe(
      fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, ""),
    );
  });

  it("refuses a configured unsupported provider even when a tmux environment is present", () => {
    const config = emptyConfig();
    config.defaults.terminal = "fixture-terminal";
    expect(() =>
      createPopupLauncher({
        config,
        cliEntryPath,
        env: { TMUX: "ambient", STATION_FOCUS_PROVIDER: "tmux" },
      }),
    ).toThrow(expect.objectContaining({ code: "TERMINAL_POPUP_UNSUPPORTED" }));
    expect(createTmuxPopupLauncher).not.toHaveBeenCalled();
  });

  it("uses launcher provenance for controls without changing the configured provider", () => {
    const config = emptyConfig();
    const env = { STATION_TUI_POPUP: "1", STATION_FOCUS_PROVIDER: "tmux" };
    createPopupControl({ config, env });
    expect(createTmuxPopupControl).toHaveBeenCalledWith({ env });
    expect(config.defaults.terminal).toBe("noop-terminal");
  });

  it.each([
    "fixture-terminal",
    "",
  ])("does not fall back from unsupported or malformed provenance %j", (provider) => {
    const config = emptyConfig();
    config.defaults.terminal = "tmux";
    expect(() =>
      createPopupControl({
        config,
        env: { STATION_TUI_POPUP: "1", STATION_FOCUS_PROVIDER: provider },
      }),
    ).toThrow();
    expect(createTmuxPopupControl).not.toHaveBeenCalled();
  });
});
