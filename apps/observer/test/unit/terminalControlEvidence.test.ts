import { describe, expect, it } from "vitest";
import { terminalControlEvidence } from "../../src/reconcile/terminalControlEvidence";

describe("terminal control evidence", () => {
  it("preserves the graph control policy for state, provider, and target evidence", () => {
    expect(terminalControlEvidence({ state: "detached" })).toEqual({
      focusable: true,
      closeable: true,
    });
    expect(terminalControlEvidence({ state: "stale" })).toEqual({ closeable: true });
    expect(terminalControlEvidence({ state: "none" })).toEqual({});
    expect(
      terminalControlEvidence({ state: "open" }, { canFocusTarget: false, canCloseTarget: false }),
    ).toEqual({ focusable: false, closeable: false });
    expect(
      terminalControlEvidence(
        { state: "open", focusable: true, closeable: true },
        { canFocusTarget: false, canCloseTarget: false },
      ),
    ).toEqual({ focusable: true, closeable: true });
  });
});
