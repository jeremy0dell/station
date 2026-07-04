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
    // Bucket count (cumulative) is top-level; the per-chunk char count is nested
    // under detail so it can never clobber the record's own fields.
    expect(record?.attributes.count).toBe(1);
    expect((record?.attributes.detail as { count: number }).count).toBe(2);
  });
});

describe("escape fragment detection", () => {
  it("fires when ANSI guts land in the grid as visible text", async () => {
    const screen = track(
      createStationVtScreen({
        size: { cols: 60, rows: 6 },
        flushIntervalMs: 1,
      }),
    );
    // The literal tail an over-erased truecolor SGR leaves behind — no ESC byte.
    screen.feed("[38;2;255;107;97mghost text");
    await screen.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(terminalCorruptionCounters().escape_fragment).toBeGreaterThanOrEqual(1);
    const record = logged.find((entry) => entry.attributes.kind === "escape_fragment");
    expect(record).toBeDefined();
  });

  it("stays quiet for properly escaped styling and benign numeric text", async () => {
    const screen = track(
      createStationVtScreen({ size: { cols: 60, rows: 6 }, flushIntervalMs: 1 }),
    );
    // Properly escaped SGR, plus CSV-like numbers that the loose form used to
    // false-positive on ("10;20;30mm" measurements).
    screen.feed("\x1b[38;2;255;107;97mstyled\x1b[0m 10;20;30mm 1;2;3m rows");
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

describe("bucket bounding for untrusted idents", () => {
  it("caps distinct unhandled-sequence buckets so terminal output cannot grow the maps unbounded", async () => {
    const screen = track(createStationVtScreen({ size: { cols: 40, rows: 6 } }));
    // OSC identifiers are arbitrary integers from the byte stream; a hostile or
    // random stream would otherwise mint one bucket (and one log line) each.
    for (let osc = 0; osc < 400; osc += 1) {
      screen.feed(`\x1b]${9000 + osc};x\x07`);
    }
    await screen.whenIdle();

    const buckets = Object.keys(terminalCorruptionCounters());
    expect(buckets.length).toBeLessThanOrEqual(300);
    expect(buckets).toContain("unhandled_sequence:_overflow");
  });
});
