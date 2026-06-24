import type { TuiToast } from "@station/dashboard-core";
import {
  activeTuiToast,
  addTuiToast,
  createInitialTuiState,
  expireTuiToasts,
  nextTuiToastExpiry,
  refreshActiveTuiToastExpiry,
  toastExpiryMs,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";

describe("TUI toast lifecycle state", () => {
  it("adds toast lifecycle metadata", () => {
    const state = addTuiToast(
      createInitialTuiState(),
      {
        kind: "success",
        message: "Session renamed.",
      },
      1_000,
    );

    expect(state.toasts).toEqual([
      {
        id: expect.stringContaining("Session renamed."),
        toast: {
          kind: "success",
          message: "Session renamed.",
        },
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 3_400,
      },
    ]);
    expect(activeTuiToast(state)?.toast.message).toBe("Session renamed.");
    expect(nextTuiToastExpiry(state)).toBe(3_400);
  });

  it("refreshes exact active duplicates instead of appending", () => {
    const toast: TuiToast = {
      kind: "error",
      message: "Worktree remove failed.",
      diagnosticId: "diag_1",
    };
    const first = addTuiToast(createInitialTuiState(), toast, 1_000);
    const second = addTuiToast(first, toast, 2_000);

    expect(second.toasts).toHaveLength(1);
    expect(second.toasts[0]).toMatchObject({
      createdAt: 1_000,
      updatedAt: 2_000,
      expiresAt: 10_000,
      toast,
    });
  });

  it("keeps only a small history while a different toast becomes active", () => {
    const state = [
      { kind: "success" as const, message: "First." },
      { kind: "info" as const, message: "Second." },
      { kind: "error" as const, message: "Third." },
      { kind: "success" as const, message: "Fourth." },
    ].reduce(
      (current, toast, index) => addTuiToast(current, toast, 1_000 + index),
      createInitialTuiState(),
    );

    expect(state.toasts.map((entry) => entry.toast.message)).toEqual([
      "Second.",
      "Third.",
      "Fourth.",
    ]);
    expect(activeTuiToast(state)?.toast.message).toBe("Fourth.");
  });

  it("expires success, info, and error toasts at their configured lifetimes", () => {
    expect(toastExpiryMs("success")).toBe(2_400);
    expect(toastExpiryMs("info")).toBe(3_200);
    expect(toastExpiryMs("error")).toBe(8_000);

    const withSuccess = addTuiToast(
      createInitialTuiState(),
      { kind: "success", message: "Session renamed." },
      1_000,
    );

    expect(expireTuiToasts(withSuccess, 3_399).toasts).toHaveLength(1);
    expect(expireTuiToasts(withSuccess, 3_400).toasts).toHaveLength(0);
  });

  it("refreshes the active toast expiry when hidden presentation resumes", () => {
    const state = addTuiToast(
      createInitialTuiState(),
      { kind: "success", message: "terminal.focus queued" },
      1_000,
    );

    const resumed = refreshActiveTuiToastExpiry(state, 5_000);

    expect(resumed.toasts[0]).toMatchObject({
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 7_400,
    });
    expect(nextTuiToastExpiry(resumed)).toBe(7_400);
  });
});
