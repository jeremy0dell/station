import { describe, expect, it } from "vitest";
import { parseRepairArgs } from "../../src/commands/repair/args";

const digest = "a".repeat(64);

describe("repair arguments", () => {
  it("parses inventory and deterministic repeated selections", () => {
    expect(parseRepairArgs(["inventory", "--json"])).toEqual({ action: "inventory", json: true });
    expect(
      parseRepairArgs([
        "runtime",
        "--dry-run",
        "--expect-inventory",
        digest,
        "--target",
        "z",
        "--target",
        "a",
        "--json",
      ]),
    ).toEqual({
      action: "runtime",
      json: true,
      request: {
        schemaVersion: 1,
        dryRun: true,
        expectInventory: digest,
        targetKeys: ["a", "z"],
      },
    });
  });

  it("parses explicit recovery keep/prune intent", () => {
    expect(
      parseRepairArgs([
        "recovery",
        "--dry-run",
        "--expect-inventory",
        digest,
        "--session",
        "session-1",
        "--keep-handle",
        "keep",
        "--prune-handle",
        "old",
      ]),
    ).toMatchObject({
      action: "recovery",
      request: { sessionId: "session-1", keepHandleId: "keep", pruneHandleIds: ["old"] },
    });
  });

  it.each(["--yes", "--force", "--expect-plan"])("rejects future mutation flag %s", (flag) => {
    expect(() =>
      parseRepairArgs([
        "runtime",
        "--dry-run",
        "--expect-inventory",
        digest,
        "--target",
        "target",
        flag,
        "value",
      ]),
    ).toThrow("preview-only");
  });

  it("rejects execution, missing exact inventory, duplicate targets, and keep/prune overlap", () => {
    expect(() =>
      parseRepairArgs(["runtime", "--expect-inventory", digest, "--target", "target"]),
    ).toThrow("require --dry-run");
    expect(() => parseRepairArgs(["runtime", "--dry-run", "--target", "target"])).toThrow(
      "--expect-inventory is required",
    );
    expect(() =>
      parseRepairArgs([
        "runtime",
        "--dry-run",
        "--expect-inventory",
        digest,
        "--target",
        "target",
        "--target",
        "target",
      ]),
    ).toThrow("must be unique");
    expect(() =>
      parseRepairArgs([
        "recovery",
        "--dry-run",
        "--expect-inventory",
        digest,
        "--session",
        "session",
        "--keep-handle",
        "handle",
        "--prune-handle",
        "handle",
      ]),
    ).toThrow();
  });
});
