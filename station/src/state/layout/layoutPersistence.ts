import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  isLayoutTopologyValid,
  parseLayoutSnapshot,
  type StationLayoutSnapshot,
} from "./layoutSnapshot.js";

/**
 * Atomic sync write for the tiny layout snapshot: write a pid-tagged sibling
 * temp file, then rename it over the target. Sync is intentional for clean-exit
 * flushes where `process.exit` follows immediately.
 */
export function writeLayoutSnapshotSync(path: string, snapshot: StationLayoutSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    // A rename that fails (EPERM/ENOSPC/cross-device) would otherwise strand the
    // pid-tagged temp; remove it before rethrowing so the writer's onError path
    // doesn't accrete junk beside the real layout file.
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Cold-boot read: load + strict-parse + topology-validate the snapshot. Returns
 * `undefined` for an absent file, unreadable bytes, invalid JSON, a
 * schema/version mismatch, or an incoherent topology. The caller decides how
 * to boot without restored layout.
 */
export function readLayoutSnapshotSync(path: string): StationLayoutSnapshot | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // no snapshot yet (first run) or unreadable
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined; // corrupt / truncated
  }
  const parsed = parseLayoutSnapshot(json);
  if (parsed === undefined || !isLayoutTopologyValid(parsed)) {
    return undefined;
  }
  return parsed;
}

export type LayoutWriter = {
  /** Note that the layout changed; coalesced into one debounced write. */
  schedule(): void;
  /** Cancel any pending debounce and write now (clean shutdown). */
  flush(): void;
  /** Drop a pending write without flushing (HMR teardown). */
  dispose(): void;
};

export type LayoutWriterOptions = {
  /** Snapshot to persist, read fresh at write time (post-debounce). */
  build: () => StationLayoutSnapshot;
  debounceMs?: number;
  /** Test seam; production uses {@link writeLayoutSnapshotSync}. */
  write: (snapshot: StationLayoutSnapshot) => void;
  /** Best-effort persistence: a failed write must never crash the UI. */
  onError?: (error: unknown) => void;
};

const DEFAULT_LAYOUT_DEBOUNCE_MS = 250;

/**
 * Debounced writer builds snapshots at flush time and skips identical serialized
 * layouts, so transient UI churn does not hit disk.
 */
export function createLayoutWriter(options: LayoutWriterOptions): LayoutWriter {
  const debounceMs = options.debounceMs ?? DEFAULT_LAYOUT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSerialized: string | undefined;

  const writeNow = (): void => {
    const snapshot = options.build();
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSerialized) {
      return;
    }
    try {
      options.write(snapshot);
      lastSerialized = serialized;
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    schedule: () => {
      if (timer !== undefined) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        writeNow();
      }, debounceMs);
    },
    flush: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      writeNow();
    },
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
