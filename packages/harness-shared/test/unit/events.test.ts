import { describe, expect, it } from "vitest";
import { reportCorrelation } from "../../src/events";

describe("reportCorrelation", () => {
  it("carries an adapter-resolved harness run without inventing a terminal target", () => {
    const result = reportCorrelation({ harnessRunId: "codex:term_main" });
    expect(result.harnessRunId).toBe("codex:term_main");
    expect(result.terminalTargetId).toBeUndefined();
  });

  it("leaves absent correlation absent instead of manufacturing identity", () => {
    expect(reportCorrelation({})).toBeUndefined();
  });

  it("preserves adapter-owned terminal and run correlation together", () => {
    const result = reportCorrelation({
      harnessRunId: "cursor:term_ghost",
      terminalTargetId: "term_ghost",
    });
    expect(result.harnessRunId).toBe("cursor:term_ghost");
    expect(result.terminalTargetId).toBe("term_ghost");
  });
});
