import { afterEach, describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import { testRender } from "@opentui/react/test-utils";
import { nativeStationTheme, stationColorSnapshotValue } from "../theme/index.js";
import { waitFor } from "./testing/waitFor.js";
import { createStationVtScreen, type StationVtScreen } from "./vt/screen.js";
import "./TerminalScreenRenderable.js";

class CapturingStdout extends Writable {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;
  readonly #chunks: Buffer[] = [];

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    callback();
  }

  getColorDepth(): number {
    return 24;
  }

  take(): string {
    const output = Buffer.concat(this.#chunks).toString("utf8");
    this.#chunks.length = 0;
    return output;
  }
}

type Mounted = {
  setup: Awaited<ReturnType<typeof testRender>>;
  screen: StationVtScreen;
  stdout: CapturingStdout;
};

const teardowns: Array<() => void> = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown();
  }
});

async function mount(hyperlinks: boolean, width = 30): Promise<Mounted> {
  const rows = 3;
  const screen = createStationVtScreen({ size: { cols: width, rows } });
  const stdout = new CapturingStdout(width, rows);
  const previousTerm = process.env.TERM;
  process.env.TERM = hyperlinks ? "xterm-ghostty" : "xterm-256color";
  let setup: Awaited<ReturnType<typeof testRender>>;
  try {
    setup = await testRender(
      <terminalScreen
        screen={screen}
        width="100%"
        height="100%"
        defaultForeground={nativeStationTheme.terminal.defaultForeground.value}
        selectionBackground={stationColorSnapshotValue(nativeStationTheme.pane.selection)}
      />,
      {
        width,
        height: rows,
        stdout: stdout as unknown as NodeJS.WriteStream,
        bufferedOutput: "stdout",
        forwardEnvKeys: ["TERM"],
      },
    );
  } finally {
    if (previousTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = previousTerm;
    }
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  await setup.flush();
  stdout.take();
  teardowns.push(() => {
    setup.renderer.destroy();
    screen.dispose();
  });
  return { setup, screen, stdout };
}

async function feedAndCapture(mounted: Mounted, data: string): Promise<string> {
  const before = mounted.screen.getVersion();
  mounted.screen.feed(`\x1b[?25l${data}`);
  await mounted.screen.whenIdle();
  await waitFor(() => mounted.screen.getVersion() > before);
  await mounted.setup.flush();
  return mounted.stdout.take();
}

function oscOpen(output: string, uri: string): string {
  const prefix = "\x1b]8;id=";
  const suffix = `;${uri}\x1b\\`;
  const suffixIndex = output.indexOf(suffix);
  const prefixIndex = output.lastIndexOf(prefix, suffixIndex);
  expect(suffixIndex).toBeGreaterThanOrEqual(0);
  expect(prefixIndex).toBeGreaterThanOrEqual(0);
  const linkId = output.slice(prefixIndex + prefix.length, suffixIndex);
  expect(linkId).toMatch(/^\d+$/u);
  return `${prefix}${linkId}${suffix}`;
}

const OSC_CLOSE = "\x1b]8;;\x1b\\";

describe("TerminalScreenRenderable OSC 8 output", () => {
  it("emits the exact native OSC 8 open and close bytes around a label", async () => {
    const mounted = await mount(true);
    const uri = "https://example.com/issues/247?exact=yes#output";
    const output = await feedAndCapture(
      mounted,
      `\x1b]8;;${uri}\x1b\\#247\x1b]8;;\x1b\\ plain`,
    );

    const open = oscOpen(output, uri);
    expect(output).toContain(open);
    expect(output).toContain(OSC_CLOSE);
    expect(output.indexOf(open)).toBeLessThan(output.indexOf("#247"));
    expect(output.indexOf(OSC_CLOSE)).toBeGreaterThan(output.indexOf("#247"));
    expect(output.indexOf(OSC_CLOSE)).toBeLessThan(output.indexOf(" plain"));
  });

  it("closes and reopens adjacent links without URI bleed", async () => {
    const mounted = await mount(true);
    const first = "https://example.com/first";
    const second = "mailto:second@example.com";
    const output = await feedAndCapture(
      mounted,
      `\x1b]8;;${first}\x1b\\A\x1b]8;;\x1b\\` +
        `\x1b]8;;${second}\x1b\\B\x1b]8;;\x1b\\C`,
    );

    const firstOpen = oscOpen(output, first);
    const secondOpen = oscOpen(output, second);
    const firstClose = output.indexOf(OSC_CLOSE, output.indexOf(firstOpen));
    const secondClose = output.indexOf(OSC_CLOSE, output.indexOf(secondOpen));
    expect(output.indexOf(firstOpen)).toBeLessThan(output.indexOf("A"));
    expect(firstClose).toBeGreaterThan(output.indexOf("A"));
    expect(firstClose).toBeLessThan(output.indexOf(secondOpen));
    expect(output.indexOf(secondOpen)).toBeLessThan(output.indexOf("B"));
    expect(secondClose).toBeGreaterThan(output.indexOf("B"));
    expect(secondClose).toBeLessThan(output.indexOf("C"));
  });

  it("encloses every colored row of a wrapped link with the exact URI", async () => {
    const mounted = await mount(true, 4);
    const uri = "https://example.com/wrapped";
    const output = await feedAndCapture(
      mounted,
      `\x1b[38;2;12;34;56m\x1b]8;;${uri}\x1b\\ABCDEFGH\x1b]8;;\x1b\\\x1b[0m`,
    );

    const open = oscOpen(output, uri);
    const openIndex = output.indexOf(open);
    const closeIndex = output.indexOf(OSC_CLOSE, openIndex + open.length);
    let previousTextIndex = openIndex;
    for (const [rowIndex, rowText] of ["ABCD", "EFGH"].entries()) {
      const cursorIndex = output.indexOf(`\x1b[${rowIndex + 1};1H`, previousTextIndex);
      const colorIndex = output.indexOf("\x1b[38;2;12;34;56m", cursorIndex);
      const textIndex = output.indexOf(rowText, colorIndex);
      expect(cursorIndex).toBeGreaterThan(previousTextIndex);
      expect(colorIndex).toBeGreaterThan(cursorIndex);
      expect(textIndex).toBeGreaterThan(colorIndex);
      expect(textIndex).toBeLessThan(closeIndex);
      previousTextIndex = textIndex;
    }
    expect(closeIndex).toBeGreaterThan(previousTextIndex);
  });

  it("emits no OSC 8 bytes when the outer capability is disabled", async () => {
    const mounted = await mount(false);
    const output = await feedAndCapture(
      mounted,
      "\x1b]8;;https://example.com/disabled\x1b\\visible\x1b]8;;\x1b\\",
    );
    expect(output).toContain("visible");
    expect(output).not.toContain("\x1b]8;");
  });

  it("renders invalid and oversized URIs as ordinary visible text", async () => {
    const mounted = await mount(true, 20);
    const invalid = "not-a-valid-scheme/path";
    const oversized = `x:${"a".repeat(511)}`;
    const output = await feedAndCapture(
      mounted,
      `\x1b]8;;${invalid}\x1b\\bad\x1b]8;;\x1b\\` +
        `\x1b]8;;${oversized}\x1b\\large\x1b]8;;\x1b\\`,
    );
    expect(output).toContain("badlarge");
    expect(output).not.toContain("\x1b]8;");
    expect(output).not.toContain(invalid);
    expect(output).not.toContain(oversized);
  });
});
