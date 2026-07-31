import type { StationTerminalReplay } from "../types.js";
import type { StationVtScreen } from "../vt/screen.js";

type TerminalReplayDiagnostics = {
  semanticCopyDropped(count: number): void;
  semanticCopyInvalid(): void;
};

/**
 * Applies one typed replay mode while preserving parser-idle barriers between
 * production geometry, serialized VT, and semantic-copy sidecar restoration.
 */
export async function applyTerminalReplay(
  screen: StationVtScreen,
  replay: StationTerminalReplay,
  diagnostics: TerminalReplayDiagnostics,
): Promise<void> {
  screen.resize(replay.initialSize);
  switch (replay.kind) {
    case "raw-complete":
      await applyRawReplay(screen, replay.events);
      return;
    case "semantic-truncation-recovery":
      await applySemanticReplay(screen, replay, diagnostics);
      return;
    case "live-reset-recovery":
      screen.feed(replay.resetData);
      await screen.whenIdle();
      return;
    default:
      return unreachableReplay(replay);
  }
}

function unreachableReplay(_replay: never): never {
  throw new Error("Unexpected terminal replay kind.");
}

async function applySemanticReplay(
  screen: StationVtScreen,
  replay: Extract<StationTerminalReplay, { kind: "semantic-truncation-recovery" }>,
  diagnostics: TerminalReplayDiagnostics,
): Promise<void> {
  screen.feed(replay.serializedVt);
  await screen.whenIdle();
  try {
    const result = screen.restoreSemanticCopySnapshot(replay.semanticCopy);
    if (result.dropped > 0) {
      diagnostics.semanticCopyDropped(result.dropped);
    }
  } catch {
    // restoreSemanticCopySnapshot clears state before validating, so an invalid
    // sidecar cannot preserve stale copy boundaries.
    diagnostics.semanticCopyInvalid();
  }
}

async function applyRawReplay(
  screen: StationVtScreen,
  events: Extract<StationTerminalReplay, { kind: "raw-complete" }>["events"],
): Promise<void> {
  for (const event of events) {
    if (event.type === "data") {
      screen.feed(event.data);
      continue;
    }
    // Resize barriers are intentionally sequential: bytes before and after the
    // barrier were produced at different widths and cannot parse concurrently.
    // pi-lens-ignore: await-in-loop
    await screen.whenIdle();
    screen.resize({ cols: event.cols, rows: event.rows });
  }
  await screen.whenIdle();
}
