// Synchronized output (DECSET 2026): the engine advertises the mode via DECRQM,
// so TUIs wrap repaints in BSU (?2026h) / ESU (?2026l) expecting atomic frames.
// The flush path must hold listener notification between them — a previous bug
// ignored the mode and notified renderers mid-frame, tearing every fast repaint.
import { afterEach, describe, expect, it } from "bun:test";
import { waitFor } from "../testing/waitFor.js";
import { createStationVtScreen, type StationVtScreen } from "./screen.js";

const SIZE = { cols: 20, rows: 5 };

const frameARows = ["FRAME-A-ROW0", "FRAME-A-ROW1", "FRAME-A-ROW2", "FRAME-A-ROW3", "FRAME-A-ROW4"];
const frameBRows = ["FRAME-B-ROW0", "FRAME-B-ROW1", "FRAME-B-ROW2", "FRAME-B-ROW3", "FRAME-B-ROW4"];

const frameA = "\x1b[H\x1b[2J" + frameARows.join("\r\n");
// BSU + clear + only the first two rows of frame B — the "atomic" frame is
// left half-painted with NO ?2026l yet.
const bsuPlusHalfB = "\x1b[?2026h\x1b[2J\x1b[H" + frameBRows.slice(0, 2).join("\r\n");
const esuPlusRestB = "\x1b[?2026l" + "\r\n" + frameBRows.slice(2).join("\r\n");

const gridText = (screen: StationVtScreen): string[] =>
  Array.from({ length: SIZE.rows }, (_, index) => screen.rowText(index));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const feedAndFlush = async (screen: StationVtScreen, data: string): Promise<void> => {
  const before = screen.getVersion();
  screen.feed(data);
  await screen.whenIdle();
  await waitFor(() => screen.getVersion() > before);
};

describe("synchronized output (DECSET 2026)", () => {
  const cleanups: Array<() => void> = [];
  const track = (screen: StationVtScreen): StationVtScreen => {
    cleanups.push(() => {
      screen.dispose();
    });
    return screen;
  };
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("DECRQM ?2026$p replies recognized (;1/;2), not ;0", async () => {
    const responses: string[] = [];
    const screen = track(
      createStationVtScreen({
        size: SIZE,
        onResponse: (data) => {
          responses.push(data);
        },
      }),
    );
    screen.feed("\x1b[?2026$p");
    await waitFor(() => responses.join("").includes("\x1b[?2026;"));
    const reply = responses.join("");
    expect(reply).toMatch(/\x1b\[\?2026;[12]\$y/);
    expect(reply).not.toContain("\x1b[?2026;0$y");
  });

  it("holds listener notification while a synchronized update is open", async () => {
    const screen = track(createStationVtScreen({ size: SIZE, flushIntervalMs: 1 }));
    await feedAndFlush(screen, frameA);
    expect(gridText(screen)).toEqual(frameARows);

    const snapshots: Array<{ syncActive: boolean; rows: string[] }> = [];
    screen.subscribe(() => {
      snapshots.push({
        syncActive: screen.unsafeEngine.modes.synchronizedOutputMode,
        rows: gridText(screen),
      });
    });

    screen.feed(bsuPlusHalfB);
    await screen.whenIdle();
    await sleep(200);

    // The engine is mid-atomic-frame; renderers were not told to repaint.
    // (Direct rowText reads still see the live buffer — only the notification
    // path is gated, which is what drives TerminalScreenRenderable.)
    expect(screen.unsafeEngine.modes.synchronizedOutputMode).toBe(true);
    expect(snapshots).toEqual([]);
  });

  it("ESU promptly notifies with the complete frame, never a torn one", async () => {
    const screen = track(createStationVtScreen({ size: SIZE, flushIntervalMs: 1 }));
    await feedAndFlush(screen, frameA);

    const snapshots: Array<{ syncActive: boolean; rows: string[] }> = [];
    screen.subscribe(() => {
      snapshots.push({
        syncActive: screen.unsafeEngine.modes.synchronizedOutputMode,
        rows: gridText(screen),
      });
    });

    screen.feed(bsuPlusHalfB);
    await screen.whenIdle();
    screen.feed(esuPlusRestB);
    await screen.whenIdle();
    await waitFor(() => snapshots.length > 0);

    expect(screen.unsafeEngine.modes.synchronizedOutputMode).toBe(false);
    expect(gridText(screen)).toEqual(frameBRows);
    // Every notified snapshot is post-ESU and complete — no torn frame.
    for (const snapshot of snapshots) {
      expect(snapshot.syncActive).toBe(false);
      expect(snapshot.rows).toEqual(frameBRows);
    }
  });

  it("a stuck BSU with no ESU still paints after the bounded hold", async () => {
    const screen = track(createStationVtScreen({ size: SIZE, flushIntervalMs: 1 }));
    await feedAndFlush(screen, frameA);

    const notifiedAt: number[] = [];
    const start = Date.now();
    screen.subscribe(() => {
      notifiedAt.push(Date.now() - start);
    });

    screen.feed(bsuPlusHalfB); // ESU never arrives
    await screen.whenIdle();
    await waitFor(() => notifiedAt.length > 0, 3_000);

    // Held for the sync window, then the escape hatch painted the pane rather
    // than freezing it forever.
    expect(notifiedAt[0]).toBeGreaterThan(500);
    expect(gridText(screen)).toEqual(["FRAME-B-ROW0", "FRAME-B-ROW1", "", "", ""]);
  }, 10_000);
});
