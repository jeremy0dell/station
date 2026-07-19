import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createPtyTable } from "./ptyTable.js";

const PI_CAPABILITIES_PROBE = fileURLToPath(
  new URL("../terminal/pty/fixtures/piCapabilitiesProbe.ts", import.meta.url),
);

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
        const inheritedTmux = process.env.TMUX;
        const inheritedTmuxPane = process.env.TMUX_PANE;
        let ptyId: string;
        try {
          process.env.TMUX = "/tmp/tmux-501/stale-host,111,0";
          process.env.TMUX_PANE = "%3";
          ({ ptyId } = table.spawn({
            kind: "agent",
            terminalTargetId: "native:smoke",
            worktreeId: "smoke",
            projectId: "smoke",
            sessionId: "smoke",
            worktreePath: process.cwd(),
            harnessProvider: "scripted",
            command: process.execPath,
            args: [PI_CAPABILITIES_PROBE, "--hold"],
            cwd: process.cwd(),
            env: {
              STATION_PANE: "0",
              TERM: "xterm-kitty",
              COLORTERM: "station-test-color",
              TERM_PROGRAM: "ghostty",
              GHOSTTY_RESOURCES_DIR: "/ghostty",
              KITTY_WINDOW_ID: "7",
              WEZTERM_PANE: "4",
              __CFBundleIdentifier: "com.mitchellh.ghostty",
              NO_COLOR: "1",
              FORCE_COLOR: "0",
              CURSOR_TRACE_ID: "provider-trace",
              VSCODE_GIT_ASKPASS_MAIN: "/opt/vscode/askpass-main.js",
              TMUX: "/tmp/tmux-501/stale-launch,222,0",
              TMUX_PANE: "%7",
              USER_SETTING: "ordinary",
            },
            cols: 80,
            rows: 24,
          }));
        } finally {
          if (inheritedTmux === undefined) delete process.env.TMUX;
          else process.env.TMUX = inheritedTmux;
          if (inheritedTmuxPane === undefined) delete process.env.TMUX_PANE;
          else process.env.TMUX_PANE = inheritedTmuxPane;
        }

        await waitUntil(
          () => table.snapshot(ptyId).scrollback.join("").includes("USER_SETTING=ordinary"),
          2000,
        );
        const output = table.snapshot(ptyId).scrollback.join("");
        for (const expected of [
          'CAPABILITIES={"images":null,"trueColor":true,"hyperlinks":false}',
          "TERM=xterm-256color",
          "COLORTERM=truecolor",
          "TERM_PROGRAM=Station",
          "GHOSTTY=unset",
          "KITTY=unset",
          "WEZTERM=unset",
          "BUNDLE=unset",
          "TMUX=unset",
          "TMUX_PANE=unset",
          "STATION_OUTER_TMUX=unset",
          "STATION_OUTER_TMUX_PANE=unset",
          "NO_COLOR=1",
          "FORCE_COLOR=0",
          "VSCODE_GIT_ASKPASS_MAIN=/opt/vscode/askpass-main.js",
          "CURSOR_TRACE_ID=provider-trace",
          "USER_SETTING=ordinary",
        ]) {
          expect(output).toContain(expected);
        }

        // The PTY is parented to the host, not a client: it survives with none attached.
        await delay(1100);
        expect(table.list()[0]).toMatchObject({ ptyId, alive: true });
      } finally {
        table.disposeAll();
      }
    });
  });
}
