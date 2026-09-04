import type { RepairPreview } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { repairPreviewResult } from "../../src/commands/repair/report.js";

const digest = "a".repeat(64);

describe("repair report", () => {
  it("shell-quotes copied selectors and never advertises a refused apply", () => {
    const ready = preview("ready", "ready", "handle with ' quote");
    expect(repairPreviewResult(ready, "text").output).toContain(
      `--handle 'handle with '\\'' quote' --yes --expect-plan ${digest}`,
    );
    const refused = preview("refused", "recovery-handle-not-found", "missing");
    expect(repairPreviewResult(refused, "text").output).toContain("apply: unavailable");
  });
});

function preview(
  status: RepairPreview["plan"]["status"],
  reason: RepairPreview["plan"]["reason"],
  recoveryHandleId: string,
): RepairPreview {
  return {
    schemaVersion: 1,
    kind: "preview",
    inventory: {
      schemaVersion: 1,
      configuredStateScopeDigest: "b".repeat(64),
      runtime: {
        status: "unavailable",
        error: { tag: "Unavailable", code: "UNAVAILABLE", message: "Unavailable." },
      },
      recovery: {
        status: "unavailable",
        error: { tag: "Unavailable", code: "UNAVAILABLE", message: "Unavailable." },
      },
      repairInventoryDigest: "c".repeat(64),
    },
    plan: {
      schemaVersion: 1,
      authorization: "none",
      action: {
        kind: "recovery-prune",
        recoveryHandleId,
        projectId: "project-1",
        worktreeId: "worktree-1",
        sessionId: "session-1",
        provider: "codex",
      },
      inventoryDigest: "c".repeat(64),
      configuredStateScopeDigest: "b".repeat(64),
      status,
      reason,
      detail: "Preview.",
      recoveryCommands: [],
      repairPlanDigest: digest,
    },
  };
}
