import { type TuiToastEntry, toastCopyText } from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

function entry(toast: TuiToastEntry["toast"]): TuiToastEntry {
  return {
    id: "toast-1",
    toast,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 17_000,
  };
}

describe("toastCopyText", () => {
  it("copies the complete readable error notice", () => {
    expect(
      toastCopyText(
        entry({
          kind: "error",
          message: "Worktree removal failed.",
          hint: "Open another checkout and retry.",
          traceId: "trace_123",
          diagnosticId: "diag_456",
        }),
      ),
    ).toBe(
      [
        "needs attention",
        "Worktree removal failed.",
        "Open another checkout and retry. | trace trace_123 | diagnostic diag_456",
      ].join("\n"),
    );
  });

  it("omits an absent detail line", () => {
    expect(toastCopyText(entry({ kind: "success", message: "Session renamed." }))).toBe(
      "saved\nSession renamed.",
    );
  });
});
