import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLayoutSnapshot } from "./layoutSnapshot.js";
import {
  createLayoutWriter,
  readLayoutSnapshotSync,
  writeLayoutSnapshotSync,
} from "./layoutPersistence.js";
import type { WorkspaceSlice } from "../types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function workspace(): WorkspaceSlice {
  return {
    panes: [
      { id: "pane-main", split: null, role: "shell" },
      { id: "pane-split-0", split: { anchorPaneId: "pane-main", direction: "right" }, role: "shell" },
    ],
    activePaneId: "pane-split-0",
  };
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "station-layout-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("writeLayoutSnapshotSync / readLayoutSnapshotSync", () => {
  it("round-trips a snapshot through disk, creating the state dir", () => {
    withTmpDir((dir) => {
      const path = join(dir, "nested", "station", "layout.json");
      const snapshot = buildLayoutSnapshot(workspace(), (id) => (id === "pane-main" ? "/work" : undefined));
      writeLayoutSnapshotSync(path, snapshot);

      const loaded = readLayoutSnapshotSync(path);
      expect(loaded).toEqual(snapshot);
    });
  });

  it("leaves no temp file behind after an atomic write", () => {
    withTmpDir((dir) => {
      const path = join(dir, "layout.json");
      writeLayoutSnapshotSync(path, buildLayoutSnapshot(workspace(), () => "/x"));
      expect(() => readFileSync(`${path}.${process.pid}.tmp`, "utf8")).toThrow();
    });
  });

  it("returns undefined for a missing file", () => {
    withTmpDir((dir) => {
      expect(readLayoutSnapshotSync(join(dir, "absent.json"))).toBeUndefined();
    });
  });

  it("returns undefined for corrupt JSON", () => {
    withTmpDir((dir) => {
      const path = join(dir, "layout.json");
      writeFileSync(path, "{ not json", "utf8");
      expect(readLayoutSnapshotSync(path)).toBeUndefined();
    });
  });

  it("returns undefined for a structurally incoherent (but JSON-valid) doc", () => {
    withTmpDir((dir) => {
      const path = join(dir, "layout.json");
      // Valid JSON, valid-ish shape, but the split anchors to a missing pane.
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 1,
          panes: [{ id: "p", split: { anchorPaneId: "ghost", direction: "right" }, role: "shell" }],
          activePaneId: "p",
          cwdByPane: {},
        }),
        "utf8",
      );
      expect(readLayoutSnapshotSync(path)).toBeUndefined();
    });
  });
});

describe("createLayoutWriter", () => {
  it("coalesces bursts into one debounced write", async () => {
    const writes: number[] = [];
    let counter = 0;
    const writer = createLayoutWriter({
      build: () => {
        counter += 1;
        return { ...buildLayoutSnapshot(workspace(), () => `/${counter}`) };
      },
      write: () => writes.push(counter),
      debounceMs: 10,
    });

    writer.schedule();
    writer.schedule();
    writer.schedule();
    expect(writes.length).toBe(0); // nothing yet — debounced
    await sleep(25);
    expect(writes.length).toBe(1); // three schedules, one write
  });

  it("skips a write when the snapshot is unchanged", async () => {
    let writeCount = 0;
    const writer = createLayoutWriter({
      build: () => buildLayoutSnapshot(workspace(), () => "/stable"),
      write: () => {
        writeCount += 1;
      },
      debounceMs: 5,
    });

    writer.flush();
    expect(writeCount).toBe(1);
    writer.flush(); // identical snapshot → no second write
    expect(writeCount).toBe(1);
  });

  it("flush writes immediately and cancels the pending timer", () => {
    let writeCount = 0;
    const writer = createLayoutWriter({
      build: () => buildLayoutSnapshot(workspace(), () => `/${writeCount}`),
      write: () => {
        writeCount += 1;
      },
      debounceMs: 1000,
    });

    writer.schedule();
    writer.flush();
    expect(writeCount).toBe(1);
  });

  it("dispose drops a pending write", async () => {
    let writeCount = 0;
    const writer = createLayoutWriter({
      build: () => buildLayoutSnapshot(workspace(), () => "/x"),
      write: () => {
        writeCount += 1;
      },
      debounceMs: 5,
    });

    writer.schedule();
    writer.dispose();
    await sleep(15);
    expect(writeCount).toBe(0);
  });

  it("swallows write errors through onError (best-effort persistence)", () => {
    const errors: unknown[] = [];
    const writer = createLayoutWriter({
      build: () => buildLayoutSnapshot(workspace(), () => "/x"),
      write: () => {
        throw new Error("disk full");
      },
      onError: (error) => errors.push(error),
      debounceMs: 1,
    });

    expect(() => writer.flush()).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
