import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonlLogger } from "@station/observability";
import { redactString } from "@station/observability";

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
  | "terminal_diagnostic";

export type TerminalCorruptionSignal = {
  kind: TerminalCorruptionKind;
  /** Pane label when the detector knows it; module-level detectors omit it. */
  pane?: string;
  /** Rate-limit bucket detail (e.g. a CSI ident) so distinct causes each log. */
  key?: string;
  /** Detector-specific fields; logged under `detail` so they cannot clobber. */
  detail?: Record<string, unknown>;
};

// One log line per bucket per minute: corruption tends to fire per frame, and
// the counters carry the volume — the log carries the existence and shape.
const LOG_INTERVAL_MS = 60_000;
const DUMP_INTERVAL_MS = 5 * 60_000;
// Bucket keys can include idents taken from untrusted terminal output (OSC
// identifiers are arbitrary integers); cap distinct buckets so a hostile or
// random stream cannot grow the Maps or flood the log without bound. Beyond the
// cap, further distinct keys fold into one overflow bucket per kind.
const MAX_BUCKETS = 256;
// Keep only the most recent dumps so a pane that trips repeatedly cannot fill
// the state dir.
const MAX_DUMP_FILES = 50;

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

// Resolve the rate-limit/counter bucket, folding excess distinct keys into one
// overflow bucket per kind once the cap is reached (so an unbounded key space
// from terminal output cannot grow the Maps).
function bucketFor(signal: TerminalCorruptionSignal): string {
  if (signal.key === undefined) {
    return signal.kind;
  }
  const bucket = `${signal.kind}:${signal.key}`;
  if (counters.has(bucket) || counters.size < MAX_BUCKETS) {
    return bucket;
  }
  return `${signal.kind}:_overflow`;
}

export function reportTerminalCorruption(signal: TerminalCorruptionSignal): void {
  const bucket = bucketFor(signal);
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
  // Reserved fields are assigned last so a detector's detail can never overwrite
  // them; detail is nested rather than spread for the same reason.
  const attributes: Record<string, unknown> = {};
  if (signal.detail !== undefined) {
    attributes.detail = signal.detail;
  }
  attributes.kind = signal.kind;
  attributes.count = count;
  if (signal.pane !== undefined) {
    attributes.pane = signal.pane;
  }
  if (signal.key !== undefined) {
    attributes.key = signal.key;
  }
  void logger.warn("Terminal corruption signal.", attributes).catch(() => {});
}

/**
 * Forensic capture at the moment of detection: the visible grid plus the raw
 * byte tail that produced it, replayable offline through the VT screen. Content
 * is redacted (the same pass as debug bundles) and both the per-pane rate limit
 * and directory retention are enforced so this cannot fill disk or leak secrets.
 */
export function writePaneEvidenceDump(input: {
  pane: string;
  trigger: TerminalCorruptionKind;
  evidence: { rows: string[]; rawTail: string };
  detail?: Record<string, unknown>;
}): void {
  const dir = dumpDir;
  if (dir === undefined) {
    return;
  }
  const now = Date.now();
  const last = lastDumpAt.get(input.pane);
  if (last !== undefined && now - last < DUMP_INTERVAL_MS) {
    return;
  }
  const stamp = new Date(now).toISOString().replaceAll(":", "-");
  const safePane = input.pane.replaceAll(/[^A-Za-z0-9_-]/g, "_");
  const path = join(dir, `${stamp}-${safePane}.json`);
  const body = JSON.stringify(
    {
      pane: input.pane,
      trigger: input.trigger,
      capturedAt: new Date(now).toISOString(),
      counters: terminalCorruptionCounters(),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      rows: input.evidence.rows.map((row) => redactString(row)),
      rawTail: redactString(input.evidence.rawTail),
    },
    null,
    2,
  );
  void (async () => {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(path, body);
      // Only mark the pane rate-limited once a write actually lands, so a
      // failing directory does not silently swallow every later capture too.
      lastDumpAt.set(input.pane, now);
      await pruneDumpDir(dir);
      await logger?.warn("Pane corruption evidence written.", {
        pane: input.pane,
        trigger: input.trigger,
        path,
      });
    } catch (error) {
      await logger
        ?.warn("Pane corruption evidence write failed.", {
          pane: input.pane,
          message: error instanceof Error ? error.message : String(error),
        })
        .catch(() => {});
    }
  })();
}

async function pruneDumpDir(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const excess = names.length - MAX_DUMP_FILES;
  for (let index = 0; index < excess; index += 1) {
    const name = names[index];
    if (name !== undefined) {
      await rm(join(dir, name), { force: true });
    }
  }
}
