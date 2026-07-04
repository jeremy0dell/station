// Corruption detectors: hard signals that the grid is (or is about to be)
// wrong — unhandled sequences the engine swallowed, bytes destroyed upstream,
// and ANSI guts rendered as visible text — counted always, logged when wired.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resetTerminalDiagnosticsForTest,
  terminalCorruptionCounters,
  wireTerminalDiagnostics,
} from "../diagnostics.js";
import { createStationVtScreen, type StationVtScreen } from "./screen.js";

type LoggedRecord = { message: string; attributes: Record<string, unknown> };

const logged: LoggedRecord[] = [];
const fakeLogger = {
  path: "/tmp/fake-tui.jsonl",
  log: async () => ({}) as never,
  debug: async () => ({}) as never,
  info: async () => ({}) as never,
  warn: async (message: string, attributes?: Record<string, unknown>) => {
    logged.push({ message, attributes: attributes ?? {} });
    return {} as never;
  },
  error: async () => ({}) as never,
};

const cleanups: Array<() => void> = [];
const track = (screen: StationVtScreen): StationVtScreen => {
  cleanups.push(() => {
    screen.dispose();
  });
  return screen;
};

beforeEach(() => {
  resetTerminalDiagnosticsForTest();
  logged.length = 0;
  wireTerminalDiagnostics({ logger: fakeLogger });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  resetTerminalDiagnosticsForTest();
});

const countersMatching = (prefix: string): number =>
  Object.entries(terminalCorruptionCounters())
    .filter(([key]) => key.startsWith(prefix))
    .reduce((sum, [, value]) => sum + value, 0);

describe("unhandled sequence detection", () => {
  it("counts CSI/OSC/DCS sequences the engine has no handler for", async () => {
    const screen = track(
      createStationVtScreen({ size: { cols: 40, rows: 6 }, diagnosticsLabel: "pane-test" }),
    );
    screen.feed("\x1b[1;2y"); // DECTST — no headless handler
    screen.feed("\x1b]777;notify;title;body\x07"); // urxvt notify extension
    screen.feed("\x1bP+q544e\x1b\\"); // XTGETTCAP
    await screen.whenIdle();

    expect(countersMatching("unhandled_sequence:")).toBeGreaterThanOrEqual(3);
    const record = logged.find((entry) => entry.attributes.kind === "unhandled_sequence");
    expect(record?.attributes.pane).toBe("pane-test");
  });

  it("does not count sequences the screen handles", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 40, rows: 6 } }));
    screen.feed("\x1b[31mred\x1b[0m\x1b[2J\x1b[H\x1b[?2004h\x1b]0;title\x07");
    await screen.whenIdle();

    expect(countersMatching("unhandled_sequence:")).toBe(0);
  });
});

describe("replacement character detection", () => {
  it("counts U+FFFD arriving in the feed", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 40, rows: 6 } }));
    screen.feed("ok��ok");
    await screen.whenIdle();

    expect(terminalCorruptionCounters().replacement_char).toBe(1);
    const record = logged.find((entry) => entry.attributes.kind === "replacement_char");
    expect(record?.attributes.count).toBe(2);
  });
});

describe("escape fragment detection", () => {
  it("fires when ANSI guts land in the grid as visible text", async () => {
    const detected: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: { cols: 60, rows: 6 },
        flushIntervalMs: 1,
        onCorruptionDetected: (kind) => {
          detected.push(kind);
        },
      }),
    );
    // The literal tail an over-erased truecolor SGR leaves behind — no ESC byte.
    screen.feed("[38;2;255;107;97mghost text");
    await screen.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(terminalCorruptionCounters().escape_fragment).toBeGreaterThanOrEqual(1);
    expect(detected).toContain("escape_fragment");
  });

  it("stays quiet for properly escaped styling", async () => {
    const screen = track(
      createStationVtScreen({ size: { cols: 60, rows: 6 }, flushIntervalMs: 1 }),
    );
    screen.feed("\x1b[38;2;255;107;97mstyled\x1b[0m plain ?2004h [1] (3;4)");
    await screen.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(terminalCorruptionCounters().escape_fragment).toBeUndefined();
  });
});

describe("corruption evidence", () => {
  it("captures the visible grid and the raw byte tail", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 20, rows: 4 } }));
    screen.feed("\x1b[31mhello\x1b[0m evidence");
    await screen.whenIdle();

    const evidence = screen.corruptionEvidence();
    expect(evidence.rows[0]).toContain("hello evidence");
    expect(evidence.rawTail).toContain("\x1b[31mhello");
  });
});
