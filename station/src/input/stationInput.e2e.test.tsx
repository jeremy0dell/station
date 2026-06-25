import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { testRender } from "@opentui/react/test-utils";
import { selectStationOverlayVisible } from "../state/selectors.js";
import { createStationStore, type StationStore } from "../state/store.js";
import { MAIN_PANE_ID } from "../state/types.js";
import { createLocalPtyTerminal } from "../terminal/pty/localPtyTerminal.js";
import { PaneRegistryProvider } from "../terminal/registry/paneTerminalContext.js";
import { createPtyRegistry } from "../terminal/registry/ptyRegistry.js";
import { TerminalPane } from "../terminal/TerminalPane.js";
import {
  createScriptedTerminal,
  type ScriptedTerminal,
} from "../terminal/testing/scriptedTerminal.js";
import { waitFor } from "../terminal/testing/waitFor.js";
import type {
  StationTerminalProcess,
  StationTerminalSpawnOptions,
} from "../terminal/types.js";
import { createStationInputRuntime } from "./stationInput.js";

// End-to-end input tests: keystrokes enter through OpenTUI's real input
// pipeline (mock stdin -> parser -> the production input runtime) and must
// arrive at the pty as the bytes a legacy terminal user would send.

const SURFACE = { width: 70, height: 18 };

type Station = {
  registry: ReturnType<typeof createPtyRegistry>;
  setup: Awaited<ReturnType<typeof testRender>>;
  store: StationStore;
  shutdowns: number[];
};

function overlayVisible(station: Station): boolean {
  return selectStationOverlayVisible(station.store.getState());
}

describe("station input end to end", () => {
  const teardowns: Array<() => void> = [];
  afterEach(() => {
    for (const teardown of teardowns.splice(0)) {
      teardown();
    }
  });

  async function renderStation(options: {
    createTerminal: (spawn: StationTerminalSpawnOptions) => StationTerminalProcess;
    kittyKeyboard?: boolean;
  }): Promise<Station> {
    // The pane updates through the registry (an external store) from the first
    // layout, so disable act-environment checks before rendering.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const store = createStationStore();
    const shutdowns: number[] = [];
    // The pane and the input runtime share one registry — the explicit wiring
    // that replaces the old global input-target singleton.
    const registry = createPtyRegistry({ createTerminal: options.createTerminal });
    const runtime = createStationInputRuntime({
      store,
      shutdown: () => {
        shutdowns.push(1);
      },
      registry,
    });
    const setup = await testRender(
      <PaneRegistryProvider registry={registry}>
        <TerminalPane paneId={MAIN_PANE_ID} />
      </PaneRegistryProvider>,
      {
        ...SURFACE,
        prependInputHandlers: [runtime.handleSequence],
        kittyKeyboard: options.kittyKeyboard ?? false,
      },
    );
    // Same paste wiring as main.tsx: OpenTUI routes paste around sequence
    // handlers, so the pane only sees it through this forward.
    setup.renderer.keyInput.on("paste", (event) => {
      runtime.handlePaste(event);
    });
    teardowns.push(() => {
      // The registry owns the PTY now (the pane no longer disposes on unmount),
      // so teardown must dispose it — critical for the real-shell lane.
      registry.disposeAll();
      setup.renderer.destroy();
    });
    await setup.flush();
    return { registry, setup, store, shutdowns };
  }

  async function renderScripted(kittyKeyboard: boolean): Promise<Station & {
    scripted: ScriptedTerminal;
  }> {
    const scripted = createScriptedTerminal();
    const station = await renderStation({
      createTerminal: () => scripted.terminal,
      kittyKeyboard,
    });
    await waitFor(() => scripted.helpers.writes !== undefined);
    return { ...station, scripted };
  }

  async function waitForStationFrame(
    station: Station,
    predicate: (frame: string) => boolean,
    timeoutMs = 5_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let frame = "";
    while (true) {
      await station.setup.renderOnce();
      frame = station.setup.captureCharFrame();
      if (predicate(frame)) {
        return frame;
      }
      if (Date.now() > deadline) {
        throw new Error(`frame predicate timed out; last frame:\n${frame}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("typed text reaches the pty byte-for-byte", async () => {
    const station = await renderScripted(false);
    await station.setup.mockInput.typeText("ls -la /tmp");
    await waitFor(() => station.scripted.helpers.writes.join("") === "ls -la /tmp");
  });

  it("enter, escape, and ctrl-c arrive as legacy control bytes", async () => {
    const station = await renderScripted(false);
    station.setup.mockInput.pressEnter();
    station.setup.mockInput.pressEscape();
    station.setup.mockInput.pressCtrlC();
    await waitFor(() => station.scripted.helpers.writes.join("") === "\r\x1b\x03");
  });

  it("kitty-protocol keystrokes still arrive as legacy bytes", async () => {
    const station = await renderScripted(true);
    await station.setup.mockInput.typeText("ab");
    station.setup.mockInput.pressEnter();
    station.setup.mockInput.pressEscape();
    station.setup.mockInput.pressCtrlC();
    await waitFor(() => {
      const bytes = station.scripted.helpers.writes.join("");
      return bytes.includes("ab") && bytes.includes("\r") && bytes.includes("\x1b") && bytes.includes("\x03");
    });
    // No CSI-u garbage leaked into the pty.
    expect(/\x1b\[\d+;\d+u/.test(station.scripted.helpers.writes.join(""))).toBe(false);
  });

  it("preserves Shift+Enter for a shell-pane TUI that negotiated kitty keyboard protocol", async () => {
    const station = await renderScripted(true);
    station.setup.mockInput.pressEnter({ shift: true });
    await waitFor(() => station.scripted.helpers.writes.join("") === "\r");

    station.scripted.helpers.emitData("\x1b[>1u");
    await waitFor(
      () => station.registry.get(MAIN_PANE_ID)?.screen?.isKittyKeyboardEnabled() === true,
    );
    station.setup.mockInput.pressEnter({ shift: true });

    await waitFor(() => station.scripted.helpers.writes.join("") === "\r\x1b[13;2u");
  });

  it("sends arrows in application form when the pane requests cursor-key mode", async () => {
    const station = await renderScripted(false);
    station.scripted.helpers.emitData("\x1b[?1h");
    await waitFor(
      () => station.registry.get(MAIN_PANE_ID)?.screen?.isApplicationCursorKeys() === true,
    );

    station.setup.mockInput.pressArrow("down");

    await waitFor(() => station.scripted.helpers.writes.join("") === "\x1bOB");
  });

  it("ctrl-q triggers shutdown instead of typing into the shell", async () => {
    const station = await renderScripted(true);
    station.setup.mockInput.pressKey("q", { ctrl: true });
    await waitFor(() => station.shutdowns.length === 1);
    expect(station.scripted.helpers.writes.join("")).not.toContain("\x11");
  });

  it("ctrl-o toggles the overlay and the overlay swallows typing", async () => {
    const station = await renderScripted(false);
    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    await station.setup.mockInput.typeText("blocked");
    expect(station.scripted.helpers.writes.join("")).not.toContain("blocked");

    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => !overlayVisible(station));
    await station.setup.mockInput.typeText("ok");
    await waitFor(() => station.scripted.helpers.writes.join("").includes("ok"));
  });

  it("reserved chords stay live while the overlay is open", async () => {
    const station = await renderScripted(false);
    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    station.setup.mockInput.pressKey("q", { ctrl: true });
    await waitFor(() => station.shutdowns.length === 1);
    expect(station.scripted.helpers.writes.join("")).not.toContain("\x11");
  });

  it("paste flows to the pty and respects the child's bracketed-paste mode", async () => {
    const station = await renderScripted(false);
    await station.setup.mockInput.pasteBracketedText("echo pasted");
    await waitFor(() =>
      station.scripted.helpers.writes[station.scripted.helpers.writes.length - 1] ===
        "echo pasted",
    );

    station.scripted.helpers.emitData("\x1b[?2004h");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await station.setup.mockInput.pasteBracketedText("wrapped paste");
    await waitFor(() =>
      station.scripted.helpers.writes[station.scripted.helpers.writes.length - 1] ===
        "\x1b[200~wrapped paste\x1b[201~",
    );
  });

  it("paste is not delivered while the overlay is open", async () => {
    const station = await renderScripted(false);
    station.setup.mockInput.pressKey("o", { ctrl: true });
    await waitFor(() => overlayVisible(station));
    const writesBefore = station.scripted.helpers.writes.length;
    await station.setup.mockInput.pasteBracketedText("blocked paste");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(station.scripted.helpers.writes.length).toBe(writesBefore);
  });

  // --- Real shell lane (gated): a user typing into a live /bin/sh ---

  const ptyGated = (): boolean => {
    if (Bun.env.STATION_PTY_SMOKE !== "1") {
      expect(true).toEqual(true);
      return true;
    }
    return false;
  };

  function realShellFactory(spawn: StationTerminalSpawnOptions): StationTerminalProcess {
    return createLocalPtyTerminal({
      ...spawn,
      command: "/bin/sh",
      args: ["-i"],
      env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", PS1: "$ " },
    });
  }

  function realCommandFactory(
    command: string,
    args: readonly string[] = [],
  ): (spawn: StationTerminalSpawnOptions) => StationTerminalProcess {
    return (spawn) =>
      createLocalPtyTerminal({
        ...spawn,
        command,
        args,
        env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
      });
  }

  function codexTrustedProjectOverride(): string | undefined {
    // Codex keys project trust by `git rev-parse --show-toplevel` (the worktree
    // root it runs in), so the override must use that path. The shared
    // --git-common-dir resolves to the main repo, which Codex never checks, so
    // trust would not match inside a linked worktree.
    const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    });
    if (toplevel.status !== 0) {
      return undefined;
    }
    const root = toplevel.stdout.trim();
    if (root === "") {
      return undefined;
    }
    return `projects={${JSON.stringify(root)}={trust_level="trusted"}}`;
  }

  it("typing a command into a real shell runs it and renders the output", async () => {
    if (ptyGated()) return;
    const station = await renderStation({ createTerminal: realShellFactory });
    await station.setup.mockInput.typeText("printf 'TYPED-OK\\n'");
    station.setup.mockInput.pressEnter();
    await waitForStationFrame(station, (frame) => frame.includes("TYPED-OK"));
  });

  it("ctrl-c interrupts a running command like a real terminal", async () => {
    if (ptyGated()) return;
    const station = await renderStation({ createTerminal: realShellFactory });
    await station.setup.mockInput.typeText("sleep 30");
    station.setup.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 400));
    station.setup.mockInput.pressCtrlC();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await station.setup.mockInput.typeText("printf 'AFTER-INT\\n'");
    station.setup.mockInput.pressEnter();
    // Renders only if the sleep died and the shell prompt came back.
    await waitForStationFrame(station, (frame) => frame.includes("AFTER-INT"), 10_000);
  });

  // --- Real agent lane (extra-gated): codex/claude launched by typing ---

  const agentGated = (): boolean => {
    if (Bun.env.STATION_PTY_SMOKE !== "1" || Bun.env.STATION_PTY_SMOKE_TUI !== "1") {
      expect(true).toEqual(true);
      return true;
    }
    return false;
  };

  const commandExists = (command: string): boolean =>
    spawnSync("/bin/sh", ["-c", `command -v ${command}`]).status === 0;

  async function runAgentSession(station: Station, launch: string): Promise<void> {
    await station.setup.mockInput.typeText(launch);
    station.setup.mockInput.pressEnter();
    // TUI paint detection: box-drawing/banner glyphs that a plain shell echo
    // of the typed command cannot produce.
    await waitForStationFrame(station, (frame) => /[╭│█▌✻]/.test(frame), 45_000);
    // Let the agent finish initializing; a Ctrl-C during startup can be
    // swallowed and the double-press quit window never opens.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Quit: both codex and claude exit on a double Ctrl-C. Retry once — the
    // first round can land while the TUI is still busy.
    for (let attempt = 0; attempt < 2; attempt++) {
      station.setup.mockInput.pressCtrlC();
      await new Promise((resolve) => setTimeout(resolve, 600));
      station.setup.mockInput.pressCtrlC();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      try {
        // The real invariant: the shell is usable again after the session.
        await station.setup.mockInput.typeText("printf 'AGENT-DONE\\n'");
        station.setup.mockInput.pressEnter();
        await waitForStationFrame(station, (frame) => frame.includes("AGENT-DONE"), 15_000);
        return;
      } catch (error) {
        if (attempt === 1) {
          throw error;
        }
      }
    }
  }

  it("claude code launches in the pane by typing and exits cleanly", async () => {
    if (agentGated()) return;
    if (!commandExists("claude")) {
      expect(true).toEqual(true);
      return;
    }
    const station = await renderStation({ createTerminal: realShellFactory });
    await runAgentSession(station, "claude");
  }, 120_000);

  it("codex launches in the pane by typing and exits cleanly", async () => {
    if (agentGated()) return;
    if (!commandExists("codex")) {
      expect(true).toEqual(true);
      return;
    }
    const station = await renderStation({ createTerminal: realShellFactory });
    await runAgentSession(station, "codex");
  }, 120_000);

  it("codex negotiates kitty keyboard protocol in a real Station PTY", async () => {
    if (agentGated()) return;
    if (!commandExists("codex")) {
      expect(true).toEqual(true);
      return;
    }
    const station = await renderStation({
      createTerminal: realCommandFactory("codex"),
      kittyKeyboard: true,
    });
    await waitFor(
      () => station.registry.get(MAIN_PANE_ID)?.screen?.isKittyKeyboardEnabled() === true,
      45_000,
    );
  }, 60_000);

  it("codex treats Shift+Enter as a soft newline in a real Station PTY", async () => {
    if (agentGated()) return;
    if (!commandExists("codex")) {
      expect(true).toEqual(true);
      return;
    }
    // If Shift+Enter regresses to Enter, Codex would submit line one. Keep that
    // path pointed at dead localhost, not a real model endpoint.
    const args = [
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      'openai_base_url="http://127.0.0.1:9"',
    ];
    // Newer Codex versions may stop at a trust prompt; override trust for this
    // smoke command only, without mutating the user's Codex config.
    const trustConfig = codexTrustedProjectOverride();
    if (trustConfig !== undefined) {
      args.push("-c", trustConfig);
    }
    const station = await renderStation({
      createTerminal: realCommandFactory("codex", args),
      kittyKeyboard: true,
    });
    await waitFor(
      () => station.registry.get(MAIN_PANE_ID)?.screen?.isKittyKeyboardEnabled() === true,
      45_000,
    );
    await waitForStationFrame(station, (frame) => /[╭│█▌✻]/.test(frame), 45_000);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    await station.setup.mockInput.typeText("STATION_SHIFT_ENTER_LINE_ONE");
    station.setup.mockInput.pressEnter({ shift: true });
    await station.setup.mockInput.typeText("STATION_SHIFT_ENTER_LINE_TWO");

    await waitForStationFrame(
      station,
      (frame) =>
        frame.includes("STATION_SHIFT_ENTER_LINE_ONE") &&
        frame.includes("STATION_SHIFT_ENTER_LINE_TWO"),
      15_000,
    );
  }, 90_000);
});
