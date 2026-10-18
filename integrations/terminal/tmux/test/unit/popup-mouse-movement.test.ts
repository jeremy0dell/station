import { describe, expect, it } from "vitest";
import {
  popupTmuxSupportsMouseMovement,
  tmuxVersionSupportsPopupMouseMovement,
} from "../../src/popup/mouseMovement";

describe("popup mouse movement", () => {
  it("enables movement only for tmux releases that attach menus to the window", () => {
    for (const version of ["3.8", "3.8a", "3.10", "4.0", "next-3.9", "3.8\n"]) {
      expect(tmuxVersionSupportsPopupMouseMovement(version)).toBe(true);
    }
    for (const version of ["3.7", "3.7c", "3.6b", "2.9", "master", "openbsd-7.6", ""]) {
      expect(tmuxVersionSupportsPopupMouseMovement(version)).toBe(false);
    }
  });

  it("asks the given tmux for its server version and stays click-only when that fails", async () => {
    const calls: Array<{ command: string; args: string[] | undefined }> = [];
    const supported = await popupTmuxSupportsMouseMovement({
      command: "/opt/tmux",
      runner: async (input) => {
        calls.push({ command: input.command, args: input.args });
        return { stdout: "3.8\n", stderr: "" };
      },
    });
    expect(supported).toBe(true);
    expect(calls).toEqual([
      { command: "/opt/tmux", args: ["display-message", "-p", "#{version}"] },
    ]);

    const failed = await popupTmuxSupportsMouseMovement({
      command: "/opt/tmux",
      runner: async () => {
        throw new Error("no server");
      },
    });
    expect(failed).toBe(false);
  });
});
