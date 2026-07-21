import { externalCommandErrorFromUnknown } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { tmuxProviderErrorFromUnknown } from "../../src/errors.js";

const fallback = {
  code: "TERMINAL_CAPTURE_FAILED" as const,
  message: "tmux failed to capture terminal output.",
};

describe("tmux provider error mapping", () => {
  it("classifies missing targets from typed command evidence", () => {
    const commandError = externalCommandErrorFromUnknown(
      { code: 1, stderr: "can't find pane: %12" },
      { command: "tmux", args: ["capture-pane", "-t", "%12"] },
    );

    const mapped = tmuxProviderErrorFromUnknown(commandError, fallback);

    expect(mapped).toMatchObject({
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_MISSING",
      message: "The terminal target no longer exists.",
      diagnosticDetails: [
        expect.objectContaining({
          type: "external_command",
          command: "tmux capture-pane -t %12",
          exitCode: 1,
          stderrSnippet: "can't find pane: %12",
        }),
      ],
    });
    expect(mapped.cause).toMatchObject({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
    });
  });

  it("classifies missing binaries and timeout by normalized code", () => {
    expect(
      tmuxProviderErrorFromUnknown(
        {
          tag: "ExternalCommandError",
          code: "ENOENT",
          message: "External command failed.",
        },
        fallback,
      ),
    ).toMatchObject({ code: "TERMINAL_TMUX_UNAVAILABLE", message: "tmux is not available." });

    expect(
      tmuxProviderErrorFromUnknown(
        {
          tag: "TimeoutError",
          code: "TERMINAL_TMUX_TIMEOUT",
          message: "tmux command timed out.",
        },
        fallback,
      ),
    ).toMatchObject({ code: "TERMINAL_TMUX_TIMEOUT", message: "tmux command timed out." });
  });

  it("uses the operation fallback while retaining typed diagnostics", () => {
    const commandError = externalCommandErrorFromUnknown(
      { code: 1, stderr: "ordinary failure" },
      { command: "tmux", args: ["capture-pane"] },
    );

    const mapped = tmuxProviderErrorFromUnknown(commandError, fallback);

    expect(mapped).toMatchObject({
      code: "TERMINAL_CAPTURE_FAILED",
      message: fallback.message,
      diagnosticDetails: [expect.objectContaining({ type: "external_command", exitCode: 1 })],
    });
  });
});
