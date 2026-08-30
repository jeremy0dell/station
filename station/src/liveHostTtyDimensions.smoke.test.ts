import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const smoke = process.env.STATION_PTY_SMOKE === "1" ? describe : () => undefined;

type ProbeResult = {
  phase: "ready" | "resized";
  width: number;
  height: number;
  columns: number;
  rows: number;
  hostedPtySize: { cols: number; rows: number };
  streamResizes: Array<{ columns: number; rows: number }>;
};

const rendererProbe = String.raw`
const { writeFileSync } = await import("node:fs");
const resultPath = process.env.STATION_TTY_DIMENSIONS_RESULT;
try {
  const { CliRenderer, CliRenderEvents } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { createElement } = await import("react");
  const { installLiveHostTtyDimensions } = await import(
    process.env.STATION_TTY_DIMENSIONS_MODULE
  );
  const stationSource = process.env.STATION_TTY_STATION_SOURCE;
  const { MAIN_PANE_ID } = await import(new URL("./state/types.ts", stationSource));
  const { nativeStationTheme, StationThemeProvider } = await import(
    new URL("./theme/index.ts", stationSource)
  );
  const { PaneRegistryProvider } = await import(
    new URL("./terminal/registry/paneTerminalContext.tsx", stationSource)
  );
  const { createPtyRegistry } = await import(
    new URL("./terminal/registry/ptyRegistry.ts", stationSource)
  );
  const { createScriptedTerminal } = await import(
    new URL("./terminal/testing/scriptedTerminal.ts", stationSource)
  );
  const { TerminalPane } = await import(new URL("./terminal/TerminalPane.tsx", stationSource));
  const finalWidth = Number(process.env.STATION_TTY_DIMENSIONS_FINAL_WIDTH);
  const finalHeight = Number(process.env.STATION_TTY_DIMENSIONS_FINAL_HEIGHT);
  const streamResizes = [];
  process.stdout.on("resize", () => {
    streamResizes.push({ columns: process.stdout.columns, rows: process.stdout.rows });
  });

  installLiveHostTtyDimensions();
  const renderer = new CliRenderer(
    process.stdin,
    process.stdout,
    process.stdout.columns || 80,
    process.stdout.rows || 24,
    {
      autoFocus: false,
      exitOnCtrlC: false,
      exitSignals: [],
      useKittyKeyboard: null,
      useMouse: false,
      useThread: false,
    },
  );
  const publish = (phase, width, height) => {
    writeFileSync(
      resultPath,
      JSON.stringify({
        phase,
        width,
        height,
      columns: process.stdout.columns,
      rows: process.stdout.rows,
      hostedPtySize: hostedSize(),
      streamResizes,
    }),
    );
  };
  const scripted = createScriptedTerminal();
  const spawnSizes = [];
  const registry = createPtyRegistry({
    createTerminal: (options) => {
      spawnSizes.push(options.size);
      return scripted.terminal;
    },
  });
  const hostedSize = () => scripted.helpers.resizes.at(-1) ?? spawnSizes.at(-1);
  registry.updateTerminalTheme(nativeStationTheme.terminal);
  const root = createRoot(renderer);
  root.render(
    createElement(
      StationThemeProvider,
      { theme: nativeStationTheme },
      createElement(
        PaneRegistryProvider,
        { registry },
        createElement(TerminalPane, { paneId: MAIN_PANE_ID }),
      ),
    ),
  );
  renderer.start();

  let ready = false;
  let target = { cols: 78, rows: 22, width: 80, height: 24 };
  renderer.on(CliRenderEvents.RESIZE, (width, height) => {
    target = { cols: width - 2, rows: height - 2, width, height };
  });
  const convergence = setInterval(() => {
    const size = hostedSize();
    if (size?.cols !== target.cols || size.rows !== target.rows) return;
    if (!ready) {
      ready = true;
      publish("ready", target.width, target.height);
      return;
    }
    if (target.width === 80 && target.height === 24) return;
    publish("resized", target.width, target.height);
    if (target.width === finalWidth && target.height === finalHeight) {
      clearInterval(convergence);
      root.unmount();
      registry.disposeAll();
      renderer.destroy();
      setTimeout(() => process.exit(0), 0);
    }
  }, 5);
  setTimeout(() => process.exit(2), 10000);
} catch (error) {
  writeFileSync(
    resultPath,
    JSON.stringify({ phase: "error", error: error?.stack ?? String(error) }),
  );
  process.exit(1);
}
`;

const ptyHarness = String.raw`
const fs = require("node:fs");
const pty = require("node-pty");
const terminal = pty.spawn(process.env.STATION_BUN, ["-e", process.env.STATION_TTY_RENDERER_PROBE], {
  cols: 80,
  cwd: process.cwd(),
  env: { ...process.env, TERM: "xterm-256color" },
  name: "xterm-256color",
  rows: 24,
});
let resized = false;
terminal.onData((data) => process.stdout.write(data));
const poll = setInterval(() => {
  if (resized || !fs.existsSync(process.env.STATION_TTY_DIMENSIONS_RESULT)) return;
  try {
    const result = JSON.parse(fs.readFileSync(process.env.STATION_TTY_DIMENSIONS_RESULT, "utf8"));
    if (result.phase !== "ready") return;
    resized = true;
    fs.writeFileSync(process.env.STATION_TTY_DIMENSIONS_INITIAL_RESULT, JSON.stringify(result));
    terminal.resize(120, 40);
    terminal.resize(60, 18);
    terminal.resize(73, 19);
  } catch {}
}, 10);
const timeout = setTimeout(() => {
  terminal.kill();
  process.exitCode = 3;
}, 12000);
terminal.onExit(({ exitCode }) => {
  clearInterval(poll);
  clearTimeout(timeout);
  if (process.exitCode === undefined) process.exitCode = exitCode;
});
`;

smoke("live host TTY dimensions", () => {
  it("drives OpenTUI to the final coherent size through a real PTY", async () => {
    const root = mkdtempSync(join(tmpdir(), "station-host-tty-"));
    const initialResultPath = join(root, "initial.json");
    const resultPath = join(root, "result.json");
    const output: string[] = [];
    let exited = false;
    const harness = spawn(process.env.STATION_NODE ?? "node", ["-e", ptyHarness], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        STATION_BUN: process.execPath,
        STATION_TTY_DIMENSIONS_FINAL_HEIGHT: "19",
        STATION_TTY_DIMENSIONS_FINAL_WIDTH: "73",
        STATION_TTY_DIMENSIONS_INITIAL_RESULT: initialResultPath,
        STATION_TTY_DIMENSIONS_MODULE: new URL(
          "./liveHostTtyDimensions.ts",
          import.meta.url,
        ).href,
        STATION_TTY_DIMENSIONS_RESULT: resultPath,
        STATION_TTY_RENDERER_PROBE: rendererProbe,
        STATION_TTY_STATION_SOURCE: new URL("./", import.meta.url).href,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    harness.stdout.on("data", (data: Buffer) => output.push(data.toString("utf8")));
    harness.stderr.on("data", (data: Buffer) => output.push(data.toString("utf8")));

    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          harness.once("error", reject);
          harness.once("close", (code, signal) => {
            exited = true;
            resolve({ code, signal });
          });
        },
      );
      expect(exit).toEqual({ code: 0, signal: null });
      expect(readResult(initialResultPath)).toMatchObject({
        columns: 80,
        height: 24,
        rows: 24,
        width: 80,
        hostedPtySize: { cols: 78, rows: 22 },
      });
      const result = readResult(resultPath);
      expect(result).toMatchObject({
        columns: 73,
        height: 19,
        hostedPtySize: { cols: 71, rows: 17 },
        rows: 19,
        width: 73,
      });
      expect(result.streamResizes.length).toBeGreaterThan(0);
      expect(
        result.streamResizes.every(({ columns, rows }) =>
          ["120x40", "60x18", "73x19"].includes(`${columns}x${rows}`),
        ),
      ).toBe(true);
      expect(result.streamResizes.at(-1)).toEqual({ columns: 73, rows: 19 });
    } catch (error) {
      throw new Error(
        `${String(error)}\nResult:\n${safeRead(resultPath)}\nPTY output:\n${output.join("")}`,
        { cause: error },
      );
    } finally {
      if (!exited) harness.kill();
      rmSync(root, { force: true, recursive: true });
    }
  }, 15_000);
});

function readResult(path: string): ProbeResult {
  return JSON.parse(readFileSync(path, "utf8")) as ProbeResult;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "<missing>";
  }
}
