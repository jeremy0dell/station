import { describe, expect, it } from "vitest";
import { runTmuxCommand } from "../../src/command.js";

describe("tmux command boundary", () => {
  it("redacts configured endpoint paths from command diagnostics and output", async () => {
    const socketPath = "/private/user/station/tmux.sock";
    await expect(
      runTmuxCommand(
        {
          command: "tmux",
          socketPath,
          timeoutMs: 1_000,
          runner: async () => {
            throw Object.assign(new Error("tmux failed"), {
              code: 1,
              stderr: `no server running on ${socketPath}`,
            });
          },
        },
        {
          args: ["has-session", "-t", "station"],
          operation: "test.tmux.command",
          fallback: {
            tag: "TerminalProviderError",
            code: "TERMINAL_PLACEMENT_REJECTED",
            message: "tmux failed",
            provider: "tmux",
          },
        },
      ),
    ).rejects.toMatchObject({
      diagnosticDetails: [
        expect.objectContaining({
          stderrSnippet: "no server running on <configured-tmux-endpoint>",
        }),
      ],
    });
  });
});
