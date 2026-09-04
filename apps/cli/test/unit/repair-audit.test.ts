import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepairAuditSchema } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createFilesystemRepairAuditPort } from "../../src/repair/audit.js";

describe("repair audit", () => {
  it("persists a valid in-progress record before atomic finalization", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "station-repair-audit-"));
    const id = "00000000-0000-4000-8000-000000000001";
    const port = createFilesystemRepairAuditPort(stateDir, {
      auditId: () => id,
      now: () => "2026-09-04T12:00:00.000Z",
    });
    const started = await port.start({
      action: { kind: "observer-cleanup" },
      planDigest: "a".repeat(64),
      inventoryDigest: "b".repeat(64),
      errorCodes: [],
      recoveryCommands: [["stn", "repair", "observer", "cleanup"]],
    });
    expect(started.status).toBe("in-progress");
    await expect(port.findInProgress()).resolves.toEqual(started);
    await expect(port.read(id)).resolves.toEqual(started);
    await port.finalize(started, {
      status: "refused",
      errorCodes: ["REPAIR_PLAN_CHANGED"],
      recoveryCommands: [["stn", "repair", "inventory"]],
    });
    const path = join(stateDir, "repair", "audit", `${id}.json`);
    const stored = RepairAuditSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(stored).toMatchObject({
      status: "refused",
      errorCodes: ["REPAIR_PLAN_CHANGED"],
    });
    expect(JSON.stringify(stored)).not.toMatch(/pid|pgid|socket|\/private/u);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(port.findInProgress()).resolves.toBeUndefined();
  });
});
