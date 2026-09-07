import { runManagedFastPopup } from "@station/tmux/popup-fast";
import { describe, expect, it, vi } from "vitest";
import { runTmuxPopupMain } from "../../src/tmuxPopupMain.js";

vi.mock("@station/tmux/popup-fast", () => ({ runManagedFastPopup: vi.fn() }));

describe("compiled popup entry", () => {
  it("runs the current installed fast path without entering the CLI", async () => {
    const cli = vi.fn();
    const args = ["{}", "/dev/ttys001", "123", "outer"];
    await runTmuxPopupMain(["__managed-popup", ...args], "/opt/station", cli);
    expect(runManagedFastPopup).toHaveBeenCalledWith(args, "/opt/station");
    expect(cli).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ["--help"],
    ["--config", "/tmp/config.toml"],
    ["popup", "--help"],
  ])("preserves full CLI dispatch for %j", async (...argv) => {
    const cli = vi.fn();
    await runTmuxPopupMain(argv, "/opt/station", cli);
    expect(cli).toHaveBeenCalledWith(argv[0] === "popup" ? argv : ["popup", ...argv]);
  });
});
