import { describe, expect, it } from "vitest";
import { buildGuardedTmuxCommandArgs } from "../../src/commandGuard";

describe("tmux command guard", () => {
  it("encodes nested tmux arguments without reopening parser metacharacters", () => {
    const args = buildGuardedTmuxCommandArgs({
      target: "%1",
      serverPid: 10,
      sessionId: "$1",
      windowId: "@1",
      paneId: "%1",
      panePid: 20,
      commands: ["new-window", "-n", "safe'; display-message INJECTED ; #", "-c", "/tmp/a\\b"],
      rejectionMarker: "REJECT",
    });

    const nested = args[5] ?? "";
    expect(nested).toContain('"safe\'; display-message INJECTED ; ##"');
    expect(nested).toContain('"/tmp/a\\\\b"');
    expect(nested).not.toContain("'safe\\'");
  });

  it("preserves intentional nested tmux formats for the guarded command", () => {
    const format = "#{pane_dead}\\t#{pane_current_command}";
    const args = buildGuardedTmuxCommandArgs({
      target: "%1",
      serverPid: 10,
      sessionId: "$1",
      windowId: "@1",
      paneId: "%1",
      commands: ["display-message", "-p", format],
      rawFormatArgs: [format],
      rejectionMarker: "REJECT",
    });

    expect(args[5]).toContain(`"${format.replaceAll("\\", "\\\\")}"`);
    expect(args[5]).not.toContain("##{pane_dead}");
  });
});
