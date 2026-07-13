import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentLogPath, readJsonlLog } from "@station/observability";
import { describe, expect, it } from "vitest";
import { createObserverLogger } from "../../src/runtime/logging.js";

describe("Observer logging adapter", () => {
  it("exposes only application logging operations and discards JSONL records", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-observer-log-"));
    const logger = createObserverLogger({
      stateDir,
      clock: { now: () => new Date("2026-05-20T12:00:00.000Z") },
    });

    expect(Object.keys(logger).sort()).toEqual(["error", "info", "warn"]);
    await expect(
      logger.info("Observer ready.", { token: "sk-secret000000000000" }),
    ).resolves.toBeUndefined();
    await expect(logger.warn("Observer delayed.")).resolves.toBeUndefined();
    await expect(logger.error("Observer failed.")).resolves.toBeUndefined();

    await expect(readJsonlLog(componentLogPath(stateDir, "observer"))).resolves.toEqual([
      expect.objectContaining({
        level: "info",
        message: "Observer ready.",
        attributes: { token: "[REDACTED]" },
      }),
      expect.objectContaining({ level: "warn", message: "Observer delayed." }),
      expect.objectContaining({ level: "error", message: "Observer failed." }),
    ]);
  });
});
