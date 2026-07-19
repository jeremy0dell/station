import { describe, expect, it } from "bun:test";
import { createPtyTable } from "./ptyTable.js";

// Real node-pty spawn. Gated like the other PTY smokes so a plain `bun test`
// stays hermetic; run with STATION_PTY_SMOKE=1.
const SMOKE = process.env.STATION_PTY_SMOKE === "1";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
}

if (SMOKE) {
  describe("ptyTable real PTY smoke", () => {
    it("keeps a spawned PTY alive with no client attached and captures output", async () => {
      const table = createPtyTable();
      try {
        const { ptyId } = table.spawn({
          kind: "agent",
          terminalTargetId: "native:smoke",
          worktreeId: "smoke",
          projectId: "smoke",
          sessionId: "smoke",
          worktreePath: process.cwd(),
          harnessProvider: "scripted",
          command: "/bin/sh",
          args: [
            "-c",
            'printf "READY:%s|%s|%s|%s|%s|%s|%s|%s|%s|%s" "$STATION_PANE" "$TERM" "$COLORTERM" "$TERM_PROGRAM" "${GHOSTTY_RESOURCES_DIR-unset}" "${TMUX-unset}" "${TMUX_PANE-unset}" "$STATION_OUTER_TMUX" "$STATION_OUTER_TMUX_PANE" "$USER_SETTING"; sleep 2',
          ],
          cwd: process.cwd(),
          env: {
            STATION_PANE: "0",
            TERM: "xterm-kitty",
            COLORTERM: "station-test-color",
            TERM_PROGRAM: "ghostty",
            GHOSTTY_RESOURCES_DIR: "/ghostty",
            TMUX: "/tmp/tmux-501/station-smoke,123,0",
            TMUX_PANE: "%7",
            USER_SETTING: "ordinary",
          },
          cols: 80,
          rows: 24,
        });

        const expected =
          "READY:1|xterm-256color|truecolor|Station|unset|unset|unset|" +
          "/tmp/tmux-501/station-smoke,123,0|%7|ordinary";
        await waitUntil(
          () => table.snapshot(ptyId).scrollback.join("").includes(expected),
          2000,
        );
        expect(table.snapshot(ptyId).scrollback.join("")).toContain(expected);

        // The PTY is parented to the host, not a client: it survives with none attached.
        await delay(1100);
        expect(table.list()[0]).toMatchObject({ ptyId, alive: true });
      } finally {
        table.disposeAll();
      }
    });
  });
}
