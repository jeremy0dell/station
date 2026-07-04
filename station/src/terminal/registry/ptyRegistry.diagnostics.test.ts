// Registry-side corruption telemetry: transport diagnostics get a subscriber,
// and a settled disagreement between pane, screen, and PTY-acked geometry is
// reported with pane evidence captured.
import { readdirSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resetTerminalDiagnosticsForTest,
  terminalCorruptionCounters,
  wireTerminalDiagnostics,
} from "../diagnostics.js";
import type { StationTerminalProcess, StationTerminalSize } from "../types.js";
import { waitFor } from "../testing/waitFor.js";
import { createPtyRegistry, type PtyRegistry } from "./ptyRegistry.js";

const PANE = "pane-geometry";
const SIZE: StationTerminalSize = { cols: 48, rows: 12 };

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

let dumpDir: string;
const registries: PtyRegistry[] = [];

beforeEach(async () => {
  resetTerminalDiagnosticsForTest();
  logged.length = 0;
  dumpDir = await mkdtemp(join(tmpdir(), "station-pane-dumps-"));
  wireTerminalDiagnostics({ logger: fakeLogger, dumpDir });
});
afterEach(() => {
  for (const registry of registries.splice(0)) {
    registry.disposeAll();
  }
  resetTerminalDiagnosticsForTest();
});

/** Fake PTY whose acked size either mirrors resizes (healthy) or sticks (diverged). */
function ackTerminal(mode: "mirror" | "stuck") {
  const diagnosticListeners = new Set<(message: string) => void>();
  let size: StationTerminalSize = { cols: 80, rows: 24 };
  const stuck: StationTerminalSize = { cols: 80, rows: 24 };
  const terminal: StationTerminalProcess = {
    id: "fake-ack",
    command: "/bin/fake",
    pid: 4242,
    get size() {
      return size;
    },
    get ackedSize() {
      return mode === "mirror" ? size : stuck;
    },
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    onDiagnostic(listener) {
      diagnosticListeners.add(listener);
      return { dispose: () => diagnosticListeners.delete(listener) };
    },
    write() {},
    resize(next) {
      size = next;
    },
    kill() {},
    dispose() {},
  };
  return {
    terminal,
    emitDiagnostic: (message: string) => {
      for (const listener of [...diagnosticListeners]) {
        listener(message);
      }
    },
  };
}

function registryFor(terminal: StationTerminalProcess): PtyRegistry {
  const registry = createPtyRegistry({
    resizeDebounceMs: 5,
    geometrySettleMs: 25,
    createTerminal: (spawn) => {
      // Real PTYs spawn at the laid-out size; mirror that so only the acked
      // size (the divergence under test) can disagree.
      terminal.resize({ cols: spawn.size?.cols ?? 80, rows: spawn.size?.rows ?? 24 });
      return terminal;
    },
  });
  registries.push(registry);
  return registry;
}

describe("geometry divergence detection", () => {
  it("reports a PTY stuck at a stale acked size and captures pane evidence", async () => {
    const { terminal } = ackTerminal("stuck");
    const registry = registryFor(terminal);
    registry.resize(PANE, SIZE);

    await waitFor(() => (terminalCorruptionCounters().geometry_divergence ?? 0) >= 1);
    const record = logged.find((entry) => entry.attributes.kind === "geometry_divergence");
    expect(record?.attributes.pane).toBe(PANE);
    expect(record?.attributes.detail).toMatchObject({
      paneSize: "48x12",
      screenSize: "48x12",
      ptySize: "80x24",
    });

    await waitFor(() => readdirSync(dumpDir).length >= 1);
    const [dumpName] = readdirSync(dumpDir);
    const dump = JSON.parse(await readFile(join(dumpDir, dumpName ?? ""), "utf8"));
    expect(dump).toMatchObject({ pane: PANE, trigger: "geometry_divergence" });
    expect(Array.isArray(dump.rows)).toBe(true);
  });

  it("stays silent when pane, screen, and acked PTY size agree", async () => {
    const { terminal } = ackTerminal("mirror");
    const registry = registryFor(terminal);
    registry.resize(PANE, SIZE);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(terminalCorruptionCounters().geometry_divergence).toBeUndefined();
    expect(readdirSync(dumpDir)).toEqual([]);
  });
});

describe("transport diagnostics", () => {
  it("logs terminal diagnostics that previously had zero listeners", async () => {
    const { terminal, emitDiagnostic } = ackTerminal("mirror");
    const registry = registryFor(terminal);
    registry.resize(PANE, SIZE);
    emitDiagnostic("The station host request failed.");

    await waitFor(() => (terminalCorruptionCounters().terminal_diagnostic ?? 0) >= 1);
    const record = logged.find((entry) => entry.attributes.kind === "terminal_diagnostic");
    expect((record?.attributes.detail as { message: string }).message).toBe(
      "The station host request failed.",
    );
    expect(record?.attributes.pane).toBe(PANE);
  });
});
