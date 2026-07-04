import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonlLogger } from "@station/observability";

/**
 * Corruption telemetry for the terminal path. Detectors report hard signals
 * (invariant violations and high-signal heuristics) here; signals count always
 * and log rate-limited when a logger is wired, so hot paths stay silent-cheap
 * and a missing logger (tests, dashboard renderer) never throws.
 */
export type TerminalCorruptionKind =
  | "unhandled_sequence"
  | "parse_error"
  | "replacement_char"
  | "escape_fragment"
  | "geometry_divergence"
  | "overflow_clip"
  | "terminal_diagnostic";

export type TerminalCorruptionSignal = {
  kind: TerminalCorruptionKind;
  /** Pane label when the detector knows it; module-level detectors omit it. */
  pane?: string;
  /** Rate-limit bucket detail (e.g. a CSI ident) so distinct causes each log. */
  key?: string;
  attributes?: Record<string, unknown>;
};

// One log line per bucket per minute: corruption tends to fire per frame, and
// the counters carry the volume — the log carries the existence and shape.
const LOG_INTERVAL_MS = 60_000;
const DUMP_INTERVAL_MS = 5 * 60_000;

let logger: JsonlLogger | undefined;
let dumpDir: string | undefined;
const counters = new Map<string, number>();
const lastLoggedAt = new Map<string, number>();
const lastDumpAt = new Map<string, number>();

export function wireTerminalDiagnostics(options: {
  logger?: JsonlLogger | undefined;
  /** Directory for pane evidence dumps, e.g. `<stateDir>/diagnostics/panes`. */
  dumpDir?: string | undefined;
}): void {
  logger = options.logger;
  dumpDir = options.dumpDir;
}

export function terminalCorruptionCounters(): Readonly<Record<string, number>> {
  return Object.fromEntries(counters);
}

export function resetTerminalDiagnosticsForTest(): void {
  logger = undefined;
  dumpDir = undefined;
  counters.clear();
  lastLoggedAt.clear();
  lastDumpAt.clear();
}

export function reportTerminalCorruption(signal: TerminalCorruptionSignal): void {
  const bucket = signal.key === undefined ? signal.kind : `${signal.kind}:${signal.key}`;
  const count = (counters.get(bucket) ?? 0) + 1;
  counters.set(bucket, count);
  if (logger === undefined) {
    return;
  }
  const now = Date.now();
  const last = lastLoggedAt.get(bucket);
  if (last !== undefined && now - last < LOG_INTERVAL_MS) {
    return;
  }
  lastLoggedAt.set(bucket, now);
  void logger
    .warn("Terminal corruption signal.", {
      kind: signal.kind,
      count,
      ...(signal.pane === undefined ? {} : { pane: signal.pane }),
      ...(signal.key === undefined ? {} : { key: signal.key }),
      ...signal.attributes,
    })
    .catch(() => {});
}

/**
 * Forensic capture at the moment of detection: the visible grid plus the raw
 * byte tail that produced it, replayable offline through the VT screen. Rate
 * limited per pane so a corruption storm cannot fill the disk.
 */
export function writePaneEvidenceDump(input: {
  pane: string;
  trigger: TerminalCorruptionKind;
  evidence: { rows: string[]; rawTail: string };
  attributes?: Record<string, unknown>;
}): void {
  if (dumpDir === undefined) {
    return;
  }
  const now = Date.now();
  const last = lastDumpAt.get(input.pane);
  if (last !== undefined && now - last < DUMP_INTERVAL_MS) {
    return;
  }
  lastDumpAt.set(input.pane, now);
  const dir = dumpDir;
  const stamp = new Date(now).toISOString().replaceAll(":", "-");
  const safePane = input.pane.replaceAll(/[^A-Za-z0-9_-]/g, "_");
  const path = join(dir, `${stamp}-${safePane}.json`);
  void (async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        {
          pane: input.pane,
          trigger: input.trigger,
          capturedAt: new Date(now).toISOString(),
          counters: terminalCorruptionCounters(),
          ...input.attributes,
          rows: input.evidence.rows,
          rawTail: input.evidence.rawTail,
        },
        null,
        2,
      ),
    );
    await logger?.warn("Pane corruption evidence written.", {
      pane: input.pane,
      trigger: input.trigger,
      path,
    });
  })().catch(() => {});
}
