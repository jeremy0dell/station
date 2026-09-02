import { describe, expect, it } from "vitest";
import { terminalControlEvidence } from "../../src/reconcile/terminalControlEvidence";

describe("terminal control evidence", () => {
  it("preserves the graph control policy for state, provider, and target evidence", () => {
    expect(terminalControlEvidence({ state: "detached" })).toEqual({
      externallyFocusable: true,
      closeable: true,
    });
    expect(terminalControlEvidence({ state: "stale" })).toEqual({ closeable: true });
    expect(terminalControlEvidence({ state: "none" })).toEqual({});
    expect(
      terminalControlEvidence({ state: "open" }, { canFocusTarget: false, canCloseTarget: false }),
    ).toEqual({ externallyFocusable: false, closeable: false });
    expect(
      terminalControlEvidence(
        { state: "open", externallyFocusable: true, closeable: true },
        { canFocusTarget: false, canCloseTarget: false },
      ),
    ).toEqual({ externallyFocusable: true, closeable: true });
  });
});
